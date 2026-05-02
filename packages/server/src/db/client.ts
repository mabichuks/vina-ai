import path from 'node:path';
import fs from 'node:fs';
import Database, { type Database as DatabaseType } from 'better-sqlite3';

let instance: DatabaseType | null = null;
let openedPath: string | null = null;

export interface OpenDbOptions {
  /** Absolute path to the SQLite file. Use `:memory:` for ephemeral DBs. */
  filename: string;
  /** Busy timeout in ms. Default 5000. */
  busyTimeoutMs?: number;
}

/**
 * Open (or return) the singleton DB. The first call wins; subsequent calls
 * with a different filename throw to surface a misconfiguration.
 */
export function getDb(options?: OpenDbOptions): DatabaseType {
  if (instance) {
    if (options && options.filename !== openedPath) {
      throw new Error(
        `getDb already initialised at ${openedPath}; cannot reopen at ${options.filename}`,
      );
    }
    return instance;
  }

  if (!options) {
    throw new Error('getDb requires options on first call');
  }

  if (options.filename !== ':memory:') {
    fs.mkdirSync(path.dirname(options.filename), { recursive: true });
  }

  const db = new Database(options.filename);
  // Connection pragmas: WAL for concurrency, foreign keys for cascade behaviour,
  // a busy timeout so concurrent writers don't immediately error.
  if (options.filename !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);

  instance = db;
  openedPath = options.filename;
  return db;
}

/** Close the singleton and clear it so the next `getDb` opens fresh. */
export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
    openedPath = null;
  }
}

/** For tests: open an isolated DB without touching the singleton. */
export function openDbDirect(options: OpenDbOptions): DatabaseType {
  const db = new Database(options.filename);
  if (options.filename !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  return db;
}

export type { DatabaseType };
