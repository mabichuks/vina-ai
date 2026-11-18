import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '..', '..', 'migrations');

function freshDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  migrate(db, { migrationsDir });
  return db;
}

describe('migration 010', () => {
  it('adds external_apply_mode to settings, defaulting to manual', () => {
    const db = freshDb();
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('external_apply_mode');
    const row = db.prepare(`SELECT external_apply_mode FROM settings WHERE id = 'app'`).get() as
      | { external_apply_mode: string }
      | undefined;
    expect(row?.external_apply_mode).toBe('manual');
    db.close();
  });

  it('rejects an out-of-range external_apply_mode (CHECK constraint)', () => {
    const db = freshDb();
    expect(() =>
      db.prepare(`UPDATE settings SET external_apply_mode = 'banana' WHERE id = 'app'`).run(),
    ).toThrow(/CHECK/);
    db.close();
  });

  it('accepts the external_form_fill task kind after the rebuild', () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO task_queue (id, kind, payload, next_attempt_at, status, created_at)
           VALUES ('t1', 'external_form_fill', '{}', '2026-01-01T00:00:00.000Z', 'pending', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).not.toThrow();
    db.close();
  });

  it('accepts the new external application_events kinds after the rebuild', () => {
    const db = freshDb();
    // Seed a job + application so the FK holds.
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO jobs (id, site_id, external_id, url, apply_method, title, company, description, discovered_at, status)
       VALUES ('j1', 'linkedin', 'ext', 'https://x', 'manual', 't', 'c', 'd', ?, 'scored')`,
    ).run(now);
    db.prepare(
      `INSERT INTO cvs (id, label, original_filename, mime_type, file_path, created_at)
       VALUES ('cv1', 'main', 'cv.pdf', 'application/pdf', '/tmp/cv.pdf', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO applications (id, job_id, cv_id, apply_method, status, started_at)
       VALUES ('a1', 'j1', 'cv1', 'manual', 'ready_for_manual_apply', ?)`,
    ).run(now);

    for (const kind of [
      'external_form_opened',
      'external_field_filled',
      'external_ready_for_review',
      'external_submitted',
    ]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO application_events (id, application_id, kind, created_at)
             VALUES (?, 'a1', ?, ?)`,
          )
          .run(`ev-${kind}`, kind, now),
      ).not.toThrow();
    }
    db.close();
  });
});
