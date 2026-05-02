import type { Database as DatabaseType } from 'better-sqlite3';
import { newId, type Task, type TaskKind, type TaskStatus } from '@vina/shared';

interface TaskRow {
  id: string;
  kind: TaskKind;
  payload: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  started_at: string | null;
  failed_reason: string | null;
  status: TaskStatus;
  created_at: string;
}

function rowToTask(row: TaskRow): Task {
  return row;
}

export interface EnqueueInput {
  kind: TaskKind;
  /** JSON-stringified by the caller, or pass an object and we'll stringify. */
  payload: unknown;
  priority?: number;
  max_attempts?: number;
  next_attempt_at?: string;
}

export function enqueue(db: DatabaseType, input: EnqueueInput): Task {
  const id = newId();
  const now = new Date().toISOString();
  const payload = typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload);

  db.prepare(
    `INSERT INTO task_queue
       (id, kind, payload, priority, attempts, max_attempts,
        next_attempt_at, started_at, failed_reason, status, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, NULL, NULL, 'pending', ?)`,
  ).run(
    id,
    input.kind,
    payload,
    input.priority ?? 0,
    input.max_attempts ?? 3,
    input.next_attempt_at ?? now,
    now,
  );

  return {
    id,
    kind: input.kind,
    payload,
    priority: input.priority ?? 0,
    attempts: 0,
    max_attempts: input.max_attempts ?? 3,
    next_attempt_at: input.next_attempt_at ?? now,
    started_at: null,
    failed_reason: null,
    status: 'pending',
    created_at: now,
  };
}

/**
 * Atomically claim the next pending task of the given kind (or any kind if
 * unspecified). Marks the row `running` and stamps `started_at`. Returns the
 * claimed row, or null if nothing is ready.
 *
 * Atomicity is enforced by wrapping a `SELECT ... LIMIT 1` and an `UPDATE`
 * inside a single sqlite transaction, plus an extra status-check in the
 * UPDATE's WHERE clause so two concurrent transactions can't both win.
 */
export function claimNext(db: DatabaseType, kind?: TaskKind): Task | null {
  const now = new Date().toISOString();

  return db.transaction(() => {
    const candidate = db
      .prepare(
        `SELECT * FROM task_queue
         WHERE status = 'pending'
           AND next_attempt_at <= ?
           ${kind ? `AND kind = ?` : ''}
         ORDER BY priority DESC, next_attempt_at ASC, id ASC
         LIMIT 1`,
      )
      .get(...(kind ? [now, kind] : [now])) as TaskRow | undefined;

    if (!candidate) return null;

    // Re-check status so a parallel transaction can't claim it from under us.
    const result = db
      .prepare(
        `UPDATE task_queue
           SET status = 'running', started_at = ?, attempts = attempts + 1
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now, candidate.id);

    if (result.changes === 0) return null;

    const claimed = db
      .prepare(`SELECT * FROM task_queue WHERE id = ?`)
      .get(candidate.id) as TaskRow;
    return rowToTask(claimed);
  })();
}

export function complete(db: DatabaseType, id: string): void {
  db.prepare(`UPDATE task_queue SET status = 'completed' WHERE id = ?`).run(id);
}

/**
 * Marks a running task as failed. If `retry` is true and attempts < max_attempts,
 * the task returns to `pending` for another attempt; otherwise it stays `failed`.
 */
export function fail(db: DatabaseType, id: string, reason: string, retry = true): void {
  const row = db.prepare(`SELECT * FROM task_queue WHERE id = ?`).get(id) as TaskRow | undefined;
  if (!row) return;

  if (retry && row.attempts < row.max_attempts) {
    db.prepare(
      `UPDATE task_queue
         SET status = 'pending', failed_reason = ?, started_at = NULL
       WHERE id = ?`,
    ).run(reason, id);
  } else {
    db.prepare(`UPDATE task_queue SET status = 'failed', failed_reason = ? WHERE id = ?`).run(
      reason,
      id,
    );
  }
}

export function listPending(db: DatabaseType): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM task_queue
       WHERE status = 'pending'
       ORDER BY priority DESC, next_attempt_at ASC, id ASC`,
    )
    .all() as TaskRow[];
  return rows.map(rowToTask);
}

/** Reset all `running` rows back to `pending`. Used on startup recovery. */
export function resetStaleRunning(db: DatabaseType): number {
  const result = db
    .prepare(`UPDATE task_queue SET status = 'pending', started_at = NULL WHERE status = 'running'`)
    .run();
  return result.changes;
}
