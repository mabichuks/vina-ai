import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '..', '..', 'migrations');

/**
 * Live-database tripwire for migration 011 (DB tripwire: `migrations/**`).
 *
 * The rebuild must (a) preserve every pre-existing provider row, (b) widen the
 * `kind` CHECK to admit `ollama-cloud`, and (c) leave the old kinds intact.
 * We simulate a pre-011 database by applying migrations 001..010, seeding a
 * provider row, then applying 011 alone and asserting the row survives.
 *
 * `llm_providers` is the parent of `settings.active_llm_provider_id`'s FK
 * (`ON DELETE RESTRICT`), so the rebuild must also preserve a provider that is
 * actively referenced — otherwise the DROP raises `FOREIGN KEY constraint
 * failed` and the daemon cannot boot after upgrade.
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

function seedReferencedProvider(db: InstanceType<typeof Database>): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO llm_providers (id, kind, label, model, base_url, encrypted_api_key, created_at)
     VALUES ('prov1', 'anthropic', 'Claude', 'claude-opus-4-7', NULL, NULL, ?)`,
  ).run(now);
  db.prepare(`UPDATE settings SET active_llm_provider_id = 'prov1' WHERE id = 'app'`).run();
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

  it('preserves a provider referenced by settings.active_llm_provider_id through the rebuild', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    applyUpTo(db, '010_external_apply_mode.sql');
    seedReferencedProvider(db);

    // This is the case that previously failed: DROP TABLE llm_providers raised
    // FOREIGN KEY constraint failed because the row is referenced (RESTRICT).
    expect(() =>
      db.exec(fs.readFileSync(path.join(migrationsDir, '011_ollama_cloud_provider.sql'), 'utf8')),
    ).not.toThrow();

    // Both the provider row and the FK target survive the rebuild.
    const kept = db.prepare(`SELECT id, kind FROM llm_providers WHERE id = 'prov1'`).get() as
      | { id: string; kind: string }
      | undefined;
    expect(kept).toEqual({ id: 'prov1', kind: 'anthropic' });

    const active = db.prepare(`SELECT active_llm_provider_id FROM settings WHERE id = 'app'`).get() as
      | { active_llm_provider_id: string }
      | undefined;
    expect(active?.active_llm_provider_id).toBe('prov1');

    // The FK is still enforced after the rebuild (ON DELETE RESTRICT).
    expect(() => db.prepare(`DELETE FROM llm_providers WHERE id = 'prov1'`).run()).toThrow(
      /FOREIGN KEY/,
    );

    // No dangling references remain.
    expect(db.pragma('foreign_key_check')).toEqual([]);

    db.close();
  });

  it('migrate() (production boot path) applies 011 to a DB whose active provider is referenced', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Pre-011 state, then the real runner applies only 011 (as on upgrade).
    applyUpTo(db, '010_external_apply_mode.sql');
    seedReferencedProvider(db);

    // A temp dir containing only 011 so migrate() runs just that file.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-mig-011-'));
    fs.copyFileSync(
      path.join(migrationsDir, '011_ollama_cloud_provider.sql'),
      path.join(tmp, '011_ollama_cloud_provider.sql'),
    );

    let applied: string[];
    try {
      applied = migrate(db, { migrationsDir: tmp }).applied;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }

    expect(applied).toEqual(['011_ollama_cloud_provider.sql']);

    const kept = db.prepare(`SELECT id, kind FROM llm_providers WHERE id = 'prov1'`).get() as
      | { id: string; kind: string }
      | undefined;
    expect(kept).toEqual({ id: 'prov1', kind: 'anthropic' });

    const active = db.prepare(`SELECT active_llm_provider_id FROM settings WHERE id = 'app'`).get() as
      | { active_llm_provider_id: string }
      | undefined;
    expect(active?.active_llm_provider_id).toBe('prov1');

    expect(db.pragma('foreign_key_check')).toEqual([]);

    db.close();
  });
});
