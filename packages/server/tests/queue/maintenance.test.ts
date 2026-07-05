import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { freshTestDb } from '../db/helpers.js';
import { pruneTaskQueue } from '../../src/queue/maintenance.js';

let db: DatabaseType;

beforeEach(() => {
  db = freshTestDb();
});
afterEach(() => db.close());

function insertTask(
  id: string,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled',
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO task_queue
       (id, kind, payload, priority, attempts, max_attempts, next_attempt_at,
        started_at, failed_reason, status, created_at)
     VALUES (?, 'apply', '{}', 0, 0, 3, ?, NULL, NULL, ?, ?)`,
  ).run(id, createdAt, status, createdAt);
}

describe('pruneTaskQueue', () => {
  it('removes terminal rows older than maxAgeDays and keeps pending/running', () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    insertTask('a', 'completed', old);
    insertTask('b', 'failed', old);
    insertTask('c', 'completed', fresh);
    insertTask('d', 'pending', old);
    insertTask('e', 'running', old);
    insertTask('f', 'cancelled', old);

    const removed = pruneTaskQueue(db, 30);

    expect(removed).toBe(3); // completed/failed/cancelled, all old
    const remaining = db
      .prepare(`SELECT id FROM task_queue ORDER BY id`)
      .all() as Array<{ id: string }>;
    expect(remaining.map((r) => r.id)).toEqual(['c', 'd', 'e']);
  });

  it('returns 0 when nothing is eligible', () => {
    const fresh = new Date().toISOString();
    insertTask('a', 'completed', fresh);
    insertTask('b', 'pending', fresh);
    expect(pruneTaskQueue(db, 30)).toBe(0);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM task_queue`).get() as { n: number },
    ).toEqual({ n: 2 });
  });
});
