import PQueue from 'p-queue';
import type { Database as DatabaseType } from 'better-sqlite3';
import { createLogger, TASK_KINDS, type Task, type TaskKind } from '@vina/shared';
import {
  claimNext,
  complete,
  countByStatus,
  fail,
  setNextAttemptAt,
} from '../db/repositories/task-queue.js';
import type { EventBus } from '../events/bus.js';
import { DEFAULT_CONCURRENCY } from './concurrency.js';
import { DEFAULT_TIMEOUTS_MS } from './timeouts.js';

const log = createLogger('worker');

/**
 * Race a handler promise against a timeout. The timer is always cleared so
 * a fast handler doesn't keep the event loop alive past task completion.
 * On timeout the rejection message is `handler_timeout: <kind> exceeded
 * <ms>ms` so the worker's catch path treats it as a normal retriable
 * failure (transient — assume the next attempt will fare better).
 */
async function runWithTimeout(promise: Promise<void>, ms: number, kind: TaskKind): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`handler_timeout: ${kind} exceeded ${ms}ms`)),
      ms,
    );
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A handler is any async function from a parsed payload to nothing. */
export type TaskHandler<P = unknown> = (payload: P) => Promise<void>;
/**
 * Handlers map. Sparse on purpose — kinds without an entry are marked
 * `failed: unhandled_kind` (no retry) when the worker tries to run them.
 * That gives M14+ the freedom to land tailor/apply/etc. one at a time
 * without forcing every caller to register no-op stubs.
 */
export type TaskHandlers = Partial<Record<TaskKind, TaskHandler>>;

export interface WorkerOptions {
  db: DatabaseType;
  bus: EventBus;
  handlers: TaskHandlers;
  /** Poll cadence when idle. Defaults to 1000ms. */
  pollIntervalMs?: number;
  /** Override concurrency per kind (sparse map). */
  concurrency?: Partial<Record<TaskKind, number>>;
  /** Override the retry backoff schedule (ms per attempt). Used by tests. */
  backoffMs?: readonly number[];
  /**
   * Override per-handler timeouts (sparse map, ms per kind). Defaults from
   * `DEFAULT_TIMEOUTS_MS`. A handler that exceeds its budget is rejected
   * with `handler_timeout` and goes through the normal retry path.
   */
  timeoutsMs?: Partial<Record<TaskKind, number>>;
}

export interface WorkerHandle {
  start(): void;
  /** Wake the loop immediately (skip the next poll wait). */
  poke(): void;
  /**
   * Stop polling and wait up to `timeoutMs` for in-flight tasks to drain.
   * Idempotent.
   */
  stop(timeoutMs?: number): Promise<void>;
}

export function createWorker(options: WorkerOptions): WorkerHandle {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const BACKOFF_MS = options.backoffMs ?? [30_000, 60_000, 120_000];
  const queues = new Map<TaskKind, PQueue>();
  // Iterate the shared TASK_KINDS so adding a new kind in @vina/shared
  // forces a TS error here until we set up its concurrency lane — otherwise
  // unknown kinds fall through to `unhandled_kind` and mask the real bug.
  for (const kind of TASK_KINDS) {
    queues.set(
      kind,
      new PQueue({ concurrency: options.concurrency?.[kind] ?? DEFAULT_CONCURRENCY[kind] }),
    );
  }

  let timer: NodeJS.Timeout | null = null;
  let stopping = false;

  function nextAttemptAtIso(attempts: number): string {
    const idx = Math.min(attempts - 1, BACKOFF_MS.length - 1);
    const ms = idx < 0 ? BACKOFF_MS[0]! : BACKOFF_MS[idx]!;
    return new Date(Date.now() + ms).toISOString();
  }

  function emitCounts(): void {
    const pending = countByStatus(options.db, 'pending');
    const running = countByStatus(options.db, 'running');
    options.bus.emit('queue:updated', { pending, running });
  }

  async function runOne(task: Task): Promise<void> {
    const handler = options.handlers[task.kind];
    if (!handler) {
      fail(options.db, task.id, 'unhandled_kind', false);
      emitCounts();
      return;
    }
    // Parse outside the retry try/catch — a JSON parse error means the row
    // is corrupt, which won't fix itself by retrying. Fail-fast like an
    // unhandled kind.
    let payload: unknown;
    try {
      payload = JSON.parse(task.payload);
    } catch (err) {
      const reason = `payload_parse: ${err instanceof Error ? err.message : String(err)}`;
      fail(options.db, task.id, reason, false);
      log.error({ task_id: task.id, kind: task.kind, err }, 'task payload parse failed');
      emitCounts();
      return;
    }
    try {
      const timeoutMs = options.timeoutsMs?.[task.kind] ?? DEFAULT_TIMEOUTS_MS[task.kind];
      await runWithTimeout(handler(payload), timeoutMs, task.kind);
      complete(options.db, task.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const willRetry = task.attempts < task.max_attempts;
      if (willRetry) {
        // `fail(..., retry=true)` flips the row back to `pending`. Push the
        // next-attempt time forward so we don't busy-loop on a flaky task.
        fail(options.db, task.id, reason, true);
        setNextAttemptAt(options.db, task.id, nextAttemptAtIso(task.attempts));
      } else {
        fail(options.db, task.id, reason, false);
      }
      log.warn(
        { task_id: task.id, kind: task.kind, attempts: task.attempts, err },
        'task failed',
      );
    }
    emitCounts();
  }

  async function tick(): Promise<void> {
    // Per-kind cap: only claim a task when its PQueue has live in-memory
    // headroom (`size + pending < concurrency`). Avoids over-pulling rows
    // that would sit `running` in the DB while waiting for a PQueue slot —
    // since claimNext bumps `attempts` in the same transaction, an over-
    // pulled row that crashes pre-execution would burn a retry without
    // running. Looping until no kind makes progress drains saturation
    // bursts inside one tick rather than waiting for the next poll.
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [kind, q] of queues) {
        if (q.size + q.pending >= q.concurrency) continue;
        const task = claimNext(options.db, kind);
        if (!task) continue;
        void q.add(() => runOne(task));
        progressed = true;
      }
    }
    emitCounts();
  }

  function scheduleNext(delay: number): void {
    if (stopping) return;
    timer = setTimeout(() => {
      tick()
        .catch((err: unknown) => log.error({ err }, 'tick threw'))
        .finally(() => scheduleNext(pollIntervalMs));
    }, delay);
  }

  return {
    start(): void {
      // A stopped worker is single-shot — restart attempts are silently
      // hostile (a test or hot-reload caller would think the worker is
      // running when it's actually idle). Throw so the misuse surfaces.
      if (stopping) {
        throw new Error('Worker has been stopped and cannot be restarted; create a new one');
      }
      if (timer) return; // already running — start is idempotent in the live path
      scheduleNext(0);
    },
    poke(): void {
      if (stopping) return;
      if (timer) clearTimeout(timer);
      scheduleNext(0);
    },
    async stop(timeoutMs = 30_000): Promise<void> {
      stopping = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const drained = Promise.all([...queues.values()].map((q) => q.onIdle()));
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref());
      await Promise.race([drained, timeout]);
    },
  };
}
