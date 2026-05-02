import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { enqueue, listPending } from '../../src/db/repositories/task-queue.js';
import { createEventBus } from '../../src/events/bus.js';
import { createWorker, type TaskHandlers } from '../../src/queue/worker.js';
import { freshTestDb } from '../db/helpers.js';

let db: DatabaseType;
beforeEach(() => {
  db = freshTestDb();
});
afterEach(() => db.close());

function harness(handlers: Partial<TaskHandlers>, backoffMs?: readonly number[]) {
  return createWorker({
    db,
    bus: createEventBus(),
    handlers: {
      search: handlers.search ?? (async () => undefined),
      score: handlers.score ?? (async () => undefined),
      tailor: handlers.tailor ?? (async () => undefined),
      apply: handlers.apply ?? (async () => undefined),
      prepare_manual_apply: handlers.prepare_manual_apply ?? (async () => undefined),
      resume: handlers.resume ?? (async () => undefined),
    },
    pollIntervalMs: 5,
    backoffMs,
  });
}

describe('worker', () => {
  it('claims a pending task, runs the handler, and marks it completed', async () => {
    const handler = vi.fn(async () => undefined);
    const worker = harness({ score: handler });
    enqueue(db, { kind: 'score', payload: { job_id: 'j1' } });

    worker.start();
    worker.poke();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1), { timeout: 1_000 });
    await worker.stop();

    expect(listPending(db)).toHaveLength(0);
  });

  it('retries on handler failure with backoff until max_attempts, then marks failed', async () => {
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    const worker = harness({ score: handler }, [10, 20]);
    enqueue(db, { kind: 'score', payload: {}, max_attempts: 2 });

    worker.start();
    await vi.waitFor(
      () => {
        const failedRow = db
          .prepare(`SELECT status, attempts, failed_reason FROM task_queue`)
          .get() as { status: string; attempts: number; failed_reason: string | null };
        expect(failedRow.status).toBe('failed');
        expect(failedRow.attempts).toBe(2);
        expect(failedRow.failed_reason).toMatch(/boom/);
      },
      { timeout: 5_000, interval: 50 },
    );
    await worker.stop();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('marks tasks of unknown kind as failed without retry', async () => {
    const worker = harness({});
    // Construct a worker with tailor handler as undefined to simulate unhandled kind.
    // reason: we need to test the !handler check in runOne.
    const customWorker = createWorker({
      db,
      bus: createEventBus(),
      handlers: {
        search: async () => undefined,
        score: async () => undefined,
        tailor: undefined as unknown as (payload: unknown) => Promise<void>,
        apply: async () => undefined,
        prepare_manual_apply: async () => undefined,
        resume: async () => undefined,
      },
      pollIntervalMs: 5,
    });
    enqueue(db, { kind: 'tailor', payload: {} });
    customWorker.start();
    await vi.waitFor(
      () => {
        const row = db.prepare(`SELECT status, failed_reason FROM task_queue`).get() as {
          status: string;
          failed_reason: string | null;
        };
        expect(row.status).toBe('failed');
        expect(row.failed_reason).toMatch(/unhandled_kind/);
      },
      { timeout: 1_000 },
    );
    await customWorker.stop();
    await worker.stop();
  });

  it('emits queue:updated after each transition', async () => {
    const bus = createEventBus();
    const counts: Array<{ pending: number; running: number }> = [];
    bus.on('queue:updated', (p) => counts.push(p));

    const worker = createWorker({
      db,
      bus,
      handlers: {
        search: async () => undefined,
        score: async () => undefined,
        tailor: async () => undefined,
        apply: async () => undefined,
        prepare_manual_apply: async () => undefined,
        resume: async () => undefined,
      },
      pollIntervalMs: 5,
    });
    enqueue(db, { kind: 'score', payload: {} });
    worker.start();
    await vi.waitFor(() => expect(counts.some((c) => c.pending === 0)).toBe(true), {
      timeout: 1_000,
    });
    await worker.stop();
  });
});
