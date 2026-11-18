import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '..', '..', 'migrations');

/**
 * Live-database tripwire for migration 011 (DB tripwire: `migrations/**`).
 *
 * The rebuild must (a) preserve every pre-existing provider row, (b) widen the
 * `kind` CHECK to admit `ollama-cloud`, and (c) leave the old kinds intact.
 * We simulate a pre-011 database by applying migrations 001..010, seeding a
 * provider row, then applying 011 alone and asserting the row survives.
 */
function applyUpTo(db: InstanceType<typeof Database>, last: string): void {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => f <= last);
  for (const file of files) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
}

describe('migration 011 (ollama-cloud provider kind)', () => {
  it('preserves existing provider rows and admits ollama-cloud through the rebuild', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Pre-011 state: migrations 001..010 only, with the old 3-kind CHECK.
    applyUpTo(db, '010_external_apply_mode.sql');

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO llm_providers (id, kind, label, model, base_url, encrypted_api_key, created_at)
       VALUES ('prov1', 'anthropic', 'Claude', 'claude-opus-4-7', NULL, NULL, ?)`,
    ).run(now);

    // Apply 011 (the rebuild + expanded CHECK).
    db.exec(fs.readFileSync(path.join(migrationsDir, '011_ollama_cloud_provider.sql'), 'utf8'));

    // (a) The pre-existing row survived the rebuild.
    const kept = db.prepare(`SELECT kind FROM llm_providers WHERE id = 'prov1'`).get() as
      | { kind: string }
      | undefined;
    expect(kept?.kind).toBe('anthropic');

    // (b) The new kind is admitted.
    expect(() =>
      db
        .prepare(
          `INSERT INTO llm_providers (id, kind, label, model, created_at)
           VALUES ('prov2', 'ollama-cloud', 'Hosted', 'deepseek-v4.1-flash:cloud', ?)`,
        )
        .run(now),
    ).not.toThrow();

    // (c) The old kinds still work and out-of-range kinds are rejected.
    expect(() =>
      db
        .prepare(
          `INSERT INTO llm_providers (id, kind, label, model, created_at)
           VALUES ('prov3', 'ollama', 'Local', 'llama3.1:70b', ?)`,
        )
        .run(now),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO llm_providers (id, kind, label, model, created_at)
           VALUES ('prov4', 'banana', 'x', 'y', ?)`,
        )
        .run(now),
    ).toThrow(/CHECK/);

    db.close();
  });
});
