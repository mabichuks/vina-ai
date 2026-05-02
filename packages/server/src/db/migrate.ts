import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as DatabaseType } from 'better-sqlite3';

const MIGRATIONS_TABLE = '_migrations';

/**
 * Default migrations directory: `packages/server/migrations/`. Resolved at
 * call time (not import time) so tests can override the path.
 */
function defaultMigrationsDir(): string {
  // src/db/migrate.ts → ../../migrations
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'migrations');
}

export interface MigrateOptions {
  migrationsDir?: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Forward-only migration runner.
 *
 * Reads `*.sql` files from the migrations directory in lexical order. Each
 * file is applied inside a single transaction; failures roll back. Applied
 * filenames are recorded in `_migrations` so subsequent runs are idempotent.
 */
export function migrate(db: DatabaseType, options: MigrateOptions = {}): MigrationResult {
  const dir = options.migrationsDir ?? defaultMigrationsDir();

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare(`SELECT id FROM ${MIGRATIONS_TABLE}`).all() as { id: string }[];
  const alreadyApplied = new Set(appliedRows.map((r) => r.id));

  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { applied: [], skipped: [] };
    }
    throw err;
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  const insertMigration = db.prepare(
    `INSERT INTO ${MIGRATIONS_TABLE} (id, applied_at) VALUES (?, ?)`,
  );

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      insertMigration.run(file, new Date().toISOString());
    });
    apply();
    applied.push(file);
  }

  return { applied, skipped };
}
