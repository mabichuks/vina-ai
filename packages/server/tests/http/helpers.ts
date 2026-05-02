import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { buildConfig, type ServerConfig } from '../../src/config.js';
import { _resetVaultForTests, initVault } from '../../src/secrets/vault.js';
import { freshTestDb } from '../db/helpers.js';

export interface TestAppHandle {
  app: FastifyInstance;
  db: DatabaseType;
  token: string;
  config: ServerConfig;
  /** Cleanup helper — closes the app, db, and removes the tmp data dir. */
  cleanup: () => Promise<void>;
}

/**
 * Build a fully-wired Fastify instance against a fresh in-memory DB and a
 * unique tmp data dir. Vault is initialised so routes that touch encrypted
 * columns work. Tests must call `cleanup()` in their afterEach.
 */
export async function buildTestApp(): Promise<TestAppHandle> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-test-'));

  process.env['VINA_DISABLE_KEYTAR'] = '1';
  _resetVaultForTests();
  await initVault(dataDir);

  const db = freshTestDb();
  const config = buildConfig({ dataDir });
  const app = await buildApp({
    db,
    config,
    version: '0.0.0-test',
    startedAt: '2026-04-01T00:00:00Z',
  });

  const cleanup = async (): Promise<void> => {
    await app.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  return { app, db, token: config.bearerToken, config, cleanup };
}

export const auth = (token: string): { authorization: string } => ({
  authorization: `Bearer ${token}`,
});
