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

describe('migration 009', () => {
  it('accepts the review task kind after the rebuild', () => {
    const db = freshDb();
    // Enqueue a review task directly — the CHECK constraint on kind must allow it.
    db.prepare(
      `INSERT INTO task_queue (id, kind, payload, next_attempt_at, status, created_at)
       VALUES ('t1', 'review', '{"application_id":"a1"}', ?, 'pending', ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());
    const row = db.prepare(`SELECT kind FROM task_queue WHERE id = 't1'`).get() as {
      kind: string;
    };
    expect(row.kind).toBe('review');
    db.close();
  });

  it('still rejects an unknown task kind', () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO task_queue (id, kind, payload, next_attempt_at, status, created_at)
           VALUES ('t2', 'bogus', '{}', ?, 'pending', ?)`,
        )
        .run(new Date().toISOString(), new Date().toISOString()),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('preserves existing pending task rows across the rebuild', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO task_queue (id, kind, payload, next_attempt_at, status, created_at)
       VALUES ('t3', 'score', '{"job_id":"j1"}', ?, 'pending', ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());
    // Re-running migrate is idempotent; the row must survive untouched.
    migrate(db, { migrationsDir });
    const row = db.prepare(`SELECT kind, payload FROM task_queue WHERE id = 't3'`).get() as {
      kind: string;
      payload: string;
    };
    expect(row.kind).toBe('score');
    expect(row.payload).toBe('{"job_id":"j1"}');
    db.close();
  });
});
