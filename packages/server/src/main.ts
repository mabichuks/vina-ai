import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBrowserManager,
  linkedInAdapter,
  type BrowserManagerHandle,
} from '@vina/automation';
import { createLogger } from '@vina/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { buildConfig, type ServerConfig } from './config.js';
import { closeDb, getDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { initVault } from './secrets/vault.js';
import { insertAlert } from './db/repositories/alerts.js';
import { listJobs } from './db/repositories/jobs.js';
import {
  enqueue,
  getInFlightScoreJobIds,
  resetStaleRunning,
} from './db/repositories/task-queue.js';
import { createEventBus } from './events/bus.js';
import { createSearchHandler } from './queue/handlers/search.js';
import { createScoreHandler } from './queue/handlers/score.js';
import { createPrepareManualApplyHandler } from './queue/handlers/prepare-manual-apply.js';
import { createManualApplyToolKit } from './orchestrator/tools/index.js';
import { updateApplicationStatus } from './db/repositories/applications.js';
import { createWorker, type TaskHandler, type TaskHandlers } from './queue/worker.js';
import { runResolveSelector, type StructuredScorer } from '@vina/orchestrator';
import { createScheduler } from './scheduler/scheduler.js';
import { createLinkedInConnectService } from './services/linkedin-connect-service.js';
import { getActiveChatModel } from './services/llm-service.js';
import { createPromptsService } from './services/prompts-service.js';
import { createSkillsService } from './services/skills-service.js';

const log = createLogger('main');

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = path.resolve(here, '..', 'package.json');
const MIGRATIONS_DIR = path.resolve(here, '..', 'migrations');

function readVersion(): string {
  const raw = fs.readFileSync(PACKAGE_JSON, 'utf8');
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? '0.0.0';
}

function writeStatusFile(config: ServerConfig, port: number, version: string): void {
  fs.writeFileSync(
    config.statusFile,
    JSON.stringify(
      { port, version, started_at: new Date().toISOString(), pid: process.pid },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

function deleteStatusFile(config: ServerConfig): void {
  try {
    fs.unlinkSync(config.statusFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export interface BootedServer {
  app: FastifyInstance;
  config: ServerConfig;
  port: number;
  browserManager: BrowserManagerHandle;
  shutdown: () => Promise<void>;
}

/**
 * Build and start the server. Returns a handle so callers (tests, the CLI
 * daemon) can shut it down cleanly. Pass `port: 0` to bind an ephemeral
 * port and `dataDir` to isolate the on-disk footprint.
 */
export async function bootServer(overrides: Partial<ServerConfig> = {}): Promise<BootedServer> {
  const config = buildConfig(overrides);
  const version = readVersion();

  const db = getDb({ filename: path.join(config.dataDir, 'vina.db') });
  migrate(db, { migrationsDir: MIGRATIONS_DIR });
  await initVault(config.dataDir);

  // Recover from a hard crash mid-task — anything left `running` returns to
  // `pending`. Idempotent on a clean shutdown (no rows in `running`).
  const stale = resetStaleRunning(db);
  if (stale > 0) log.warn({ count: stale }, 'reset stale running tasks at boot');

  // Rescore-stranded sweep: any job left at `status='new'` from a prior run
  // where the search task crashed before enqueueing its score never gets
  // picked up otherwise (the score handler only runs for explicitly-enqueued
  // tasks). At boot, enqueue a score for each such job that doesn't already
  // have one in flight. Idempotent: re-running the sweep does nothing if
  // scores are still pending or running.
  const inFlightScoreIds = getInFlightScoreJobIds(db);
  const strandedJobs = listJobs(db, { status: 'new', limit: 1_000 }).filter(
    (job) => !inFlightScoreIds.has(job.id),
  );
  for (const job of strandedJobs) {
    enqueue(db, { kind: 'score', payload: { job_id: job.id } });
  }
  if (strandedJobs.length > 0) {
    log.info(
      { count: strandedJobs.length },
      'enqueued score tasks for jobs stranded at status=new from a prior run',
    );
  }

  const bus = createEventBus();

  const browserManager = createBrowserManager({
    dataDir: config.dataDir,
    headless: !config.headfulBrowser,
  });

  const linkedInConnectService = createLinkedInConnectService({
    db,
    bus,
    browserManager,
    adapter: linkedInAdapter,
    dataDir: config.dataDir,
  });

  const prompts = await createPromptsService({ dataDir: config.dataDir });
  const skills = await createSkillsService({ dataDir: config.dataDir });

  // M10 ships `search` and `score`. Other TaskKinds (tailor, apply,
  // prepare_manual_apply, resume) intentionally have no entry — the worker
  // marks them `failed: unhandled_kind` (no retry) until M14+ provides
  // handlers. The factory return types are widened via `adapt` because each
  // handler accepts its own narrow payload but `TaskHandler` accepts
  // `unknown` (function-parameter contravariance).
  const adapt = <P>(h: (p: P) => Promise<void>): TaskHandler => (p) => h(p as P);
  const handlers: TaskHandlers = {
    search: adapt(
      createSearchHandler({
        db,
        bus,
        browserManager,
        adapters: { linkedin: linkedInAdapter },
        dataDir: config.dataDir,
        selectorResolver: async (input) => {
          const model = await getActiveChatModel(db);
          // Same StructuredScorer-shaped narrowing the score handler does;
          // LangChain's BaseChatModel#withStructuredOutput is shape-compatible
          // but the typed signature differs (M10 review note M-1).
          return runResolveSelector(input, model as unknown as StructuredScorer);
        },
      }),
    ),
    score: adapt(
      createScoreHandler({
        db,
        bus,
        buildModel: () => getActiveChatModel(db),
        promptLoader: prompts.loader,
      }),
    ),
    prepare_manual_apply: adapt(
      createPrepareManualApplyHandler({
        db,
        bus,
        buildModel: () => getActiveChatModel(db),
        toolKit: createManualApplyToolKit({ dataDir: config.dataDir }),
        promptLoader: prompts.loader,
      }),
    ),
  };

  const worker = createWorker({
    db,
    bus,
    handlers,
    onTerminalFailure: (task, reason) => {
      if (task.kind === 'score') {
        insertAlert(db, {
          kind: 'score_failed',
          severity: 'error',
          title: 'Scoring failed',
          description: reason,
          payload: { task_id: task.id },
        });
      } else if (task.kind === 'prepare_manual_apply') {
        const payload = (() => {
          try {
            return JSON.parse(task.payload) as { application_id?: string };
          } catch {
            return {};
          }
        })();
        // Best-effort: transition the application to 'failed' so the UI
        // doesn't show a stuck "Tailoring…" card.
        if (payload.application_id) {
          try {
            updateApplicationStatus(db, payload.application_id, 'failed', {
              failure_reason: reason,
            });
          } catch {
            // Application may have been deleted between enqueue and terminal
            // failure; the alert below is enough.
          }
        }
        insertAlert(db, {
          kind: 'apply_failed',
          severity: 'error',
          title: 'Tailoring failed',
          description: reason,
          application_id: payload.application_id ?? null,
          payload: { task_id: task.id, kind: 'prepare_manual_apply' },
        });
      }
    },
  });
  const scheduler = createScheduler({ db, bus, poke: () => worker.poke() });

  const startedAt = new Date().toISOString();
  const app = await buildApp({
    db,
    config,
    version,
    startedAt,
    bus,
    browserManager,
    linkedInConnectService,
    prompts,
    skills,
    poke: () => worker.poke(),
  });

  const address = await app.listen({ port: config.port, host: '127.0.0.1' });
  const port = Number.parseInt(new URL(address).port, 10);
  writeStatusFile(config, port, version);

  worker.start();
  scheduler.start();

  log.info({ port, url: address, version }, 'ready');

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    await worker.stop();
    await browserManager.closeAll();
    await app.close();
    closeDb();
    deleteStatusFile(config);
  };

  return { app, config, port, browserManager, shutdown };
}

async function runDaemon(): Promise<void> {
  const booted = await bootServer();

  let shuttingDown = false;
  const handleSignal = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    // Cap shutdown at 30s (PRD-048 acceptance) so a stuck connection cannot
    // pin the daemon forever.
    const timeout = setTimeout(() => {
      log.error('shutdown timeout, force exiting');
      process.exit(1);
    }, 30_000);
    timeout.unref();

    booted
      .shutdown()
      .then(() => {
        log.info('goodbye');
        process.exit(0);
      })
      .catch((err: unknown) => {
        log.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));
}

// Run as daemon when invoked directly (not when imported by tests).
const isDirectInvocation = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isDirectInvocation) {
  void runDaemon().catch((err: unknown) => {
    log.error({ err }, 'fatal startup error');
    process.exit(1);
  });
}
