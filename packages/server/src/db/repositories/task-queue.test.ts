import { describe, expect, it } from 'vitest';
import { freshTestDb } from '../test-helpers.js';
import {
  claimNext,
  complete,
  enqueue,
  fail,
  listPending,
  resetStaleRunning,
} from './task-queue.js';

describe('task_queue repository', () => {
  it('enqueue + listPending', () => {
    const db = freshTestDb();
    enqueue(db, { kind: 'apply', payload: { job_id: '01J' } });
    expect(listPending(db)).toHaveLength(1);
    db.close();
  });

  it('claimNext atomically marks one row running and returns it', () => {
    const db = freshTestDb();
    enqueue(db, { kind: 'apply', payload: { job_id: '01J1' } });
    enqueue(db, { kind: 'apply', payload: { job_id: '01J2' } });

    const claimed = claimNext(db, 'apply');
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.started_at).not.toBeNull();
    expect(listPending(db)).toHaveLength(1);
    db.close();
  });

  it('returns null when nothing is pending of that kind', () => {
    const db = freshTestDb();
    enqueue(db, { kind: 'tailor', payload: {} });
    expect(claimNext(db, 'apply')).toBeNull();
    expect(claimNext(db, 'tailor')).not.toBeNull();
    db.close();
  });

  it('claimNext under concurrency never returns the same row twice', () => {
    // Better-sqlite3 transactions are synchronous from JS land, but they each
    // serialise on the underlying file/connection. We verify atomicity by
    // back-to-back claimNext calls and assert distinct row ids.
    const db = freshTestDb();
    enqueue(db, { kind: 'apply', payload: { i: 1 } });
    enqueue(db, { kind: 'apply', payload: { i: 2 } });
    enqueue(db, { kind: 'apply', payload: { i: 3 } });

    const claims = [
      claimNext(db, 'apply'),
      claimNext(db, 'apply'),
      claimNext(db, 'apply'),
      claimNext(db, 'apply'),
    ];

    const claimed = claims.filter((c) => c !== null);
    expect(claimed).toHaveLength(3);

    const ids = claimed.map((c) => c.id);
    expect(new Set(ids).size).toBe(3); // all distinct
    expect(claims[3]).toBeNull(); // queue drained
    db.close();
  });

  it('respects priority and next_attempt_at ordering', () => {
    const db = freshTestDb();
    const future = new Date(Date.now() + 60_000).toISOString();
    enqueue(db, { kind: 'apply', payload: { i: 'low' } });
    enqueue(db, { kind: 'apply', payload: { i: 'high' }, priority: 10 });
    enqueue(db, { kind: 'apply', payload: { i: 'future' }, next_attempt_at: future });

    const first = claimNext(db, 'apply');
    expect(first?.payload).toBe('{"i":"high"}');
    const second = claimNext(db, 'apply');
    expect(second?.payload).toBe('{"i":"low"}');
    const third = claimNext(db, 'apply');
    expect(third).toBeNull(); // future task is not yet ready
    db.close();
  });

  it('complete marks running → completed', () => {
    const db = freshTestDb();
    enqueue(db, { kind: 'apply', payload: {} });
    const claimed = claimNext(db, 'apply')!;
    complete(db, claimed.id);
    expect(listPending(db)).toHaveLength(0);
    db.close();
  });

  it('fail with retry returns task to pending while attempts < max_attempts', () => {
    const db = freshTestDb();
    enqueue(db, { kind: 'apply', payload: {}, max_attempts: 2 });

    const first = claimNext(db, 'apply')!;
    fail(db, first.id, 'transient', true);
    const second = claimNext(db, 'apply')!;
    expect(second.id).toBe(first.id);
    expect(second.attempts).toBe(2);
    expect(second.failed_reason).toBe('transient');

    fail(db, second.id, 'permanent', true);
    // Now attempts = max_attempts, so it stays failed.
    expect(claimNext(db, 'apply')).toBeNull();
    db.close();
  });

  it('fail with retry=false marks failed regardless of attempts', () => {
    const db = freshTestDb();
    enqueue(db, { kind: 'apply', payload: {}, max_attempts: 5 });
    const t = claimNext(db, 'apply')!;
    fail(db, t.id, 'no retry', false);
    expect(claimNext(db, 'apply')).toBeNull();
    db.close();
  });

  it('resetStaleRunning flips running → pending on startup', () => {
    const db = freshTestDb();
    enqueue(db, { kind: 'apply', payload: { i: 1 } });
    enqueue(db, { kind: 'apply', payload: { i: 2 } });
    claimNext(db, 'apply');
    claimNext(db, 'apply');
    expect(listPending(db)).toHaveLength(0);

    const reset = resetStaleRunning(db);
    expect(reset).toBe(2);
    expect(listPending(db)).toHaveLength(2);
    db.close();
  });
});
