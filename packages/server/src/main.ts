import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@vina/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { buildConfig, type ServerConfig } from './config.js';
import { closeDb, getDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { initVault } from './secrets/vault.js';
import { resetStaleRunning } from './db/repositories/task-queue.js';
import { createEventBus } from './events/bus.js';
import { createSearchHandler } from './queue/handlers/search.js';
import { createScoreHandler } from './queue/handlers/score.js';
import { createWorker, type TaskHandlers } from './queue/worker.js';
import { createScheduler } from './scheduler/scheduler.js';
import { getActiveChatModel } from './services/llm-service.js';

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

  const bus = createEventBus();

  const handlers: TaskHandlers = {
    search: createSearchHandler({ db, bus }) as TaskHandlers['search'],
    score: createScoreHandler({
      db,
      bus,
      buildModel: () => getActiveChatModel(db),
    }) as TaskHandlers['score'],
    // M14+ kinds intentionally unhandled — worker marks them failed with
    // `unhandled_kind`. The handlers map must exhaustively list every TaskKind
    // (TS enforces this via `Record<TaskKind, TaskHandler>`).
    tailor: async () => undefined,
    apply: async () => undefined,
    prepare_manual_apply: async () => undefined,
    resume: async () => undefined,
  };

  const worker = createWorker({ db, bus, handlers });
  const scheduler = createScheduler({ db, bus, poke: () => worker.poke() });

  const startedAt = new Date().toISOString();
  const app = await buildApp({ db, config, version, startedAt, bus });

  const address = await app.listen({ port: config.port, host: '127.0.0.1' });
  const port = Number.parseInt(new URL(address).port, 10);
  writeStatusFile(config, port, version);

  worker.start();
  scheduler.start();

  log.info({ port, url: address, version }, 'ready');

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    await worker.stop();
    await app.close();
    closeDb();
    deleteStatusFile(config);
  };

  return { app, config, port, shutdown };
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
