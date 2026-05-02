import PQueue from 'p-queue';
import type { Database as DatabaseType } from 'better-sqlite3';
import { createLogger, TASK_KINDS, type Task, type TaskKind } from '@vina/shared';
import {
  claimNext,
  complete,
  fail,
  listPending,
} from '../db/repositories/task-queue.js';
import type { EventBus } from '../events/bus.js';
import { DEFAULT_CONCURRENCY } from './concurrency.js';

const log = createLogger('worker');

/** A handler is any async function from a parsed payload to nothing. */
export type TaskHandler<P = unknown> = (payload: P) => Promise<void>;
export type TaskHandlers = Record<TaskKind, TaskHandler>;

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
    const pending = listPending(options.db).length;
    const running = (
      options.db
        .prepare(`SELECT COUNT(*) AS n FROM task_queue WHERE status = 'running'`)
        .get() as {
          n: number;
        }
    ).n;
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
      await handler(payload);
      complete(options.db, task.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const willRetry = task.attempts < task.max_attempts;
      if (willRetry) {
        // `fail(..., retry=true)` flips the row back to `pending`. Push the
        // next-attempt time forward so we don't busy-loop on a flaky task.
        fail(options.db, task.id, reason, true);
        options.db
          .prepare(`UPDATE task_queue SET next_attempt_at = ? WHERE id = ?`)
          .run(nextAttemptAtIso(task.attempts), task.id);
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
    // Drain up to N tasks per tick — N higher than total concurrency so each
    // p-queue can fill its lanes. The atomic claim in the repo ensures we
    // never double-process even if a poke arrived mid-tick.
    const totalCap = [...queues.values()].reduce((acc, q) => acc + q.concurrency, 0);
    for (let i = 0; i < totalCap * 2; i++) {
      const task = claimNext(options.db);
      if (!task) break;
      const q = queues.get(task.kind);
      if (!q) {
        fail(options.db, task.id, 'unhandled_kind', false);
        continue;
      }
      void q.add(() => runOne(task));
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
      if (timer || stopping) return;
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
