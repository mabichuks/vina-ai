import { describe, expect, it } from 'vitest';
import {
  claimNext,
  enqueue,
  fail,
  listPending,
  resetStaleRunning,
} from '../../../src/db/repositories/task-queue.js';
import { freshTestDb } from '../helpers.js';

describe('task_queue repository', () => {
  it('claimNext is atomic — back-to-back claims never return the same row', () => {
    const db = freshTestDb();
    enqueue(db, { kind: 'apply', payload: { i: 1 } });
    enqueue(db, { kind: 'apply', payload: { i: 2 } });
    enqueue(db, { kind: 'apply', payload: { i: 3 } });

    const claimed = [
      claimNext(db, 'apply'),
      claimNext(db, 'apply'),
      claimNext(db, 'apply'),
      claimNext(db, 'apply'),
    ];
    const ids = claimed.filter((c) => c !== null).map((c) => c.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(claimed[3]).toBeNull();
    db.close();
  });

  it('respects priority and skips tasks scheduled in the future', () => {
    const db = freshTestDb();
    const future = new Date(Date.now() + 60_000).toISOString();
    enqueue(db, { kind: 'apply', payload: { i: 'low' } });
    enqueue(db, { kind: 'apply', payload: { i: 'high' }, priority: 10 });
    enqueue(db, { kind: 'apply', payload: { i: 'future' }, next_attempt_at: future });

    expect(claimNext(db, 'apply')?.payload).toBe('{"i":"high"}');
    expect(claimNext(db, 'apply')?.payload).toBe('{"i":"low"}');
    expect(claimNext(db, 'apply')).toBeNull();
    db.close();
  });

  it('fail with retry returns to pending until attempts >= max_attempts', () => {
    const db = freshTestDb();
    enqueue(db, { kind: 'apply', payload: {}, max_attempts: 2 });

    const first = claimNext(db, 'apply')!;
    fail(db, first.id, 'transient', true);
    const second = claimNext(db, 'apply')!;
    expect(second.id).toBe(first.id);
    expect(second.attempts).toBe(2);

    fail(db, second.id, 'still transient', true);
    expect(claimNext(db, 'apply')).toBeNull();
    db.close();
  });

  it('resetStaleRunning flips all running rows back to pending on startup', () => {
    const db = freshTestDb();
    enqueue(db, { kind: 'apply', payload: {} });
    enqueue(db, { kind: 'apply', payload: {} });
    claimNext(db, 'apply');
    claimNext(db, 'apply');
    expect(listPending(db)).toHaveLength(0);
    expect(resetStaleRunning(db)).toBe(2);
    expect(listPending(db)).toHaveLength(2);
    db.close();
  });
});
