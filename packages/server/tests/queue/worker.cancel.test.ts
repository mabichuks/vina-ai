import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { enqueue } from '../../src/db/repositories/task-queue.js';
import { createEventBus } from '../../src/events/bus.js';
import { createWorker } from '../../src/queue/worker.js';
import {
  cancelActiveTask,
  _resetActiveTasksForTests,
} from '../../src/queue/active-tasks.js';
import { AbortedError } from '../../src/queue/handlers/errors.js';
import { freshTestDb } from '../db/helpers.js';

let db: DatabaseType;
beforeEach(() => {
  db = freshTestDb();
  _resetActiveTasksForTests();
});
afterEach(() => {
  _resetActiveTasksForTests();
  db.close();
});

describe('worker — search cancellation', () => {
  it('registers an AbortSignal on the payload, unregisters on success', async () => {
    let observedSignal: AbortSignal | undefined;
    let observedTaskId: string | undefined;

    const worker = createWorker({
      db,
      bus: createEventBus(),
      handlers: {
        search: async (payload) => {
          const p = payload as { _signal?: AbortSignal; task_id?: string };
          observedSignal = p._signal;
          observedTaskId = p.task_id;
        },
        score: async () => undefined,
        tailor: async () => undefined,
        apply: async () => undefined,
        prepare_manual_apply: async () => undefined,
        resume: async () => undefined,
      },
      pollIntervalMs: 5,
    });

    const task = enqueue(db, {
      kind: 'search',
      payload: { site_id: 'google', task_id: 'will-be-overwritten' },
    });

    worker.start();
    await vi.waitFor(
      () => {
        expect(observedSignal).toBeDefined();
        const row = db
          .prepare(`SELECT status FROM task_queue WHERE id = ?`)
          .get(task.id) as { status: string } | undefined;
        expect(row?.status).toBe('completed');
      },
      { timeout: 2_000, interval: 25 },
    );
    await worker.stop();

    // Handler should have seen a non-aborted signal.
    expect(observedSignal?.aborted).toBe(false);
    // Registry should be clean — calling cancel on this task id returns false.
    expect(cancelActiveTask(task.id)).toBe(false);
    // task_id observed should be the row id, not the user payload value.
    expect(observedTaskId).toBe(task.id);
  });

  it('cancelActiveTask flips the row to cancelled with reason=cancelled_by_user, no retry', async () => {
    const worker = createWorker({
      db,
      bus: createEventBus(),
      handlers: {
        search: async (payload) => {
          const p = payload as { _signal?: AbortSignal };
          const signal = p._signal!;
          // Hang until aborted, then throw AbortedError like the real handler.
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new AbortedError();
        },
        score: async () => undefined,
        tailor: async () => undefined,
        apply: async () => undefined,
        prepare_manual_apply: async () => undefined,
        resume: async () => undefined,
      },
      pollIntervalMs: 5,
      backoffMs: [10, 10, 10],
    });

    const task = enqueue(db, {
      kind: 'search',
      payload: { site_id: 'google' },
      max_attempts: 3,
    });

    worker.start();

    // Wait for the row to flip running, then cancel.
    await vi.waitFor(
      () => {
        const row = db
          .prepare(`SELECT status FROM task_queue WHERE id = ?`)
          .get(task.id) as { status: string };
        expect(row.status).toBe('running');
      },
      { timeout: 2_000, interval: 25 },
    );
    expect(cancelActiveTask(task.id)).toBe(true);

    await vi.waitFor(
      () => {
        const row = db
          .prepare(
            `SELECT status, failed_reason, attempts FROM task_queue WHERE id = ?`,
          )
          .get(task.id) as {
          status: string;
          failed_reason: string | null;
          attempts: number;
        };
        expect(row.status).toBe('cancelled');
        expect(row.failed_reason).toBe('cancelled_by_user');
        // Exactly one attempt — cancellation does NOT consume retries.
        expect(row.attempts).toBe(1);
      },
      { timeout: 2_000, interval: 25 },
    );
    await worker.stop();
  });
});
