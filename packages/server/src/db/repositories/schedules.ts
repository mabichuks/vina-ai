import type { Database as DatabaseType } from 'better-sqlite3';
import { NotFoundError, newId } from '@vina/shared';

export interface Schedule {
  id: string;
  cron_expression: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

interface ScheduleRow {
  id: string;
  cron_expression: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

function rowToSchedule(row: ScheduleRow): Schedule {
  return { ...row, enabled: row.enabled === 1 };
}

export function listSchedules(db: DatabaseType): Schedule[] {
  const rows = db.prepare(`SELECT * FROM schedules ORDER BY created_at ASC`).all() as ScheduleRow[];
  return rows.map(rowToSchedule);
}

export function findScheduleById(db: DatabaseType, id: string): Schedule | null {
  const row = db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as ScheduleRow | undefined;
  return row ? rowToSchedule(row) : null;
}

export function insertSchedule(
  db: DatabaseType,
  input: { cron_expression: string; enabled?: boolean },
): Schedule {
  const id = newId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO schedules (id, cron_expression, enabled, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, input.cron_expression, input.enabled === false ? 0 : 1, now);
  return {
    id,
    cron_expression: input.cron_expression,
    enabled: input.enabled !== false,
    last_run_at: null,
    next_run_at: null,
    created_at: now,
  };
}

export interface ScheduleUpdatePatch {
  cron_expression?: string;
  enabled?: boolean;
  last_run_at?: string | null;
  next_run_at?: string | null;
}

export function updateSchedule(db: DatabaseType, id: string, patch: ScheduleUpdatePatch): Schedule {
  const current = findScheduleById(db, id);
  if (!current) throw new NotFoundError(`Schedule ${id} not found`);

  const next: Schedule = {
    ...current,
    ...(patch.cron_expression !== undefined && {
      cron_expression: patch.cron_expression,
    }),
    ...(patch.enabled !== undefined && { enabled: patch.enabled }),
    ...(patch.last_run_at !== undefined && { last_run_at: patch.last_run_at }),
    ...(patch.next_run_at !== undefined && { next_run_at: patch.next_run_at }),
  };

  db.prepare(
    `UPDATE schedules SET
       cron_expression=?, enabled=?, last_run_at=?, next_run_at=?
     WHERE id=?`,
  ).run(next.cron_expression, next.enabled ? 1 : 0, next.last_run_at, next.next_run_at, id);

  return next;
}

export function deleteSchedule(db: DatabaseType, id: string): void {
  const result = db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
  if (result.changes === 0) throw new NotFoundError(`Schedule ${id} not found`);
}
