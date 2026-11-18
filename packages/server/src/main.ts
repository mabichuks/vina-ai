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
import { createApplyHandler } from './queue/handlers/apply.js';
import { createPrepareManualApplyHandler } from './queue/handlers/prepare-manual-apply.js';
import { createReviewHandler } from './queue/handlers/review.js';
import { createManualApplyToolKit } from './orchestrator/tools/index.js';
import { updateApplicationStatus } from './db/repositories/applications.js';
import { createWorker, type TaskHandler, type TaskHandlers } from './queue/worker.js';
import { runResolveSelector, type StructuredScorer } from '@vina/orchestrator';
import { createScheduler } from './scheduler/scheduler.js';
import { createLinkedInConnectService } from './services/linkedin-connect-service.js';
import { getActiveChatModel, resolveChatProvider } from './services/llm-service.js';
import { createPromptsService } from './services/prompts-service.js';
import { createSkillsService } from './services/skills-service.js';
import { generateWorkspace } from '@vina/opencode-plugin';
import { createOpenCodeHost, type OpenCodeHost } from './opencode/host.js';
import { createSessionDriver, type SessionDriver } from './opencode/session-driver.js';
import { createVinaServices } from './opencode/services.js';
import { createChatService, type ChatService } from './services/chat-service.js';

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

  // Generate the agent workspace (opencode.jsonc, AGENTS.md, the six agent
  // definitions, and the vendored skill tree) under <dataDir>/workspace.
  // Idempotent: re-running writes identical bytes. The host is booted against
  // this workspace with an isolated config home (see @vina/opencode-plugin).
  generateWorkspace({ dataDir: config.dataDir });

  const bus = createEventBus();

  // The `vina_*` tool service container (issue #16) — the plugin receives the
  // live repositories/services by injection at host boot. The host driver needs
  // `bus` before the worker/scheduler are built, so it is created first here.
  const services = createVinaServices({
    db,
    bus,
    buildModel: () => getActiveChatModel(db),
    dataDir: config.dataDir,
  });

  // Boot the single embedded OpenCode host (ADR-024 §2/§14). A boot failure
  // degrades to "chat unavailable" + a general alert (§10) — never crashes the
  // daemon. `resolveProvider` reads the active provider from settings and
  // decrypts its key from the vault; the key never reaches disk or logs.
  let host: OpenCodeHost | null = null;
  try {
    host = await createOpenCodeHost({
      dataDir: config.dataDir,
      resolveProvider: () => resolveChatProvider(db),
      services,
      // The Playwright MCP attaches to the browser manager's loopback CDP
      // endpoint (ADR-022). The manager launches per-site on first use and its
      // port is dynamic; stage 1 chat denies `playwright` entirely, so the MCP
      // is registered but never dialled — the placeholder is resolved when the
      // browser manager surfaces its endpoint (#16 follow-up).
      cdpEndpoint: () => 'http://127.0.0.1:9222',
    });
  } catch (err) {
    log.error({ err }, 'OpenCode host failed to boot; chat unavailable');
    insertAlert(db, {
      kind: 'general',
      severity: 'error',
      title: 'Chat unavailable',
      description:
        'The AI chat host failed to start. Check that an LLM provider is configured in Settings and try restarting.',
    });
  }

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

  // Chat service drives the single `vina-chat` conversation over the host.
  // `null` when the host failed to boot — the route is then not registered.
  const chat: ChatService | null = host
    ? createChatService({ host, db, bus })
    : null;

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

  // Session driver for the task-session handlers (prepare_manual_apply,
  // review). `null` host (boot failed) → a driver that always fails so those
  // kinds surface as task failures rather than silently no-op'ing.
  const sessionDriver = host
    ? createSessionDriver(host)
    : ({
        run: async () => {
          throw new Error('OpenCode host unavailable — cannot run agent sessions');
        },
      } as SessionDriver);

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
      }),
    ),
    prepare_manual_apply: adapt(
      createPrepareManualApplyHandler({
        db,
        bus,
        sessionDriver,
      }),
    ),
    review: adapt(
      createReviewHandler({
        db,
        bus,
        sessionDriver,
      }),
    ),
    apply: adapt(
      createApplyHandler({
        db,
        bus,
        browserManager,
        adapters: { linkedin: linkedInAdapter },
        manualApplyToolKit: createManualApplyToolKit({ dataDir: config.dataDir }),
        buildModel: () => getActiveChatModel(db),
        skillRegistry: skills.registry,
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
      } else if (task.kind === 'review') {
        const payload = (() => {
          try {
            return JSON.parse(task.payload) as { application_id?: string };
          } catch {
            return {};
          }
        })();
        insertAlert(db, {
          kind: 'apply_failed',
          severity: 'error',
          title: 'Review failed',
          description: reason,
          application_id: payload.application_id ?? null,
          payload: { task_id: task.id, kind: 'review' },
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
    chat,
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
    if (host) await host.close();
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
