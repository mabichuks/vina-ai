import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';

export interface ServerConfig {
  port: number;
  dataDir: string;
  logsDir: string;
  filesDir: string;
  sessionsDir: string;
  bearerToken: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  headfulBrowser: boolean;
  /** Where the runtime status file is written (`dataDir/vina.status`). */
  statusFile: string;
}

const DEFAULT_PORT = 7341;

function parseLogLevel(input: string | undefined): ServerConfig['logLevel'] {
  if (input === 'debug' || input === 'info' || input === 'warn' || input === 'error') {
    return input;
  }
  return 'info';
}

function parsePort(input: string | undefined): number {
  if (!input) return DEFAULT_PORT;
  const n = Number.parseInt(input, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Build a fresh config. Pure of process state apart from env vars; takes an
 * optional `dataDir` override so tests can isolate the filesystem footprint.
 */
export function buildConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir = overrides.dataDir ?? process.env['VINA_DATA_DIR'] ?? envPaths('vina').data;
  const logsDir = overrides.logsDir ?? path.join(dataDir, 'logs');
  const filesDir = overrides.filesDir ?? path.join(dataDir, 'files');
  const sessionsDir = overrides.sessionsDir ?? path.join(dataDir, 'sessions');

  ensureDir(dataDir);
  ensureDir(logsDir);
  ensureDir(filesDir);
  ensureDir(sessionsDir);

  return {
    port: overrides.port ?? parsePort(process.env['VINA_PORT']),
    dataDir,
    logsDir,
    filesDir,
    sessionsDir,
    bearerToken: overrides.bearerToken ?? randomUUID(),
    logLevel: overrides.logLevel ?? parseLogLevel(process.env['VINA_LOG_LEVEL']),
    headfulBrowser: overrides.headfulBrowser ?? process.env['VINA_HEADFUL'] === '1',
    statusFile: overrides.statusFile ?? path.join(dataDir, 'vina.status'),
  };
}
