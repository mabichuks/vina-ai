import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as DatabaseType } from 'better-sqlite3';
import { openDbDirect } from '../../src/db/client.js';
import { migrate } from '../../src/db/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, '..', '..', 'migrations');

/**
 * Open an in-memory DB and run all migrations against it. Each test owns
 * its DB and is responsible for closing it.
 */
export function freshTestDb(): DatabaseType {
  const db = openDbDirect({ filename: ':memory:' });
  migrate(db, { migrationsDir: MIGRATIONS_DIR });
  return db;
}
