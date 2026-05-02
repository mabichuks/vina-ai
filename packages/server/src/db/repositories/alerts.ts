import type { Database as DatabaseType } from 'better-sqlite3';
import {
  NotFoundError,
  newId,
  type Alert,
  type AlertKind,
  type AlertSeverity,
  type AlertStatus,
} from '@vina/shared';

interface AlertRow {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  description: string;
  application_id: string | null;
  site_id: string | null;
  payload: string | null;
  status: AlertStatus;
  resolution_value: string | null;
  created_at: string;
  resolved_at: string | null;
}

function rowToAlert(row: AlertRow): Alert {
  return row;
}

export interface AlertFilters {
  status?: AlertStatus | AlertStatus[];
  kind?: AlertKind;
  application_id?: string;
  limit?: number;
  offset?: number;
}

export function listAlerts(db: DatabaseType, filters: AlertFilters = {}): Alert[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.status) {
    if (Array.isArray(filters.status)) {
      const placeholders = filters.status.map((_, i) => `@status_${i}`).join(', ');
      where.push(`status IN (${placeholders})`);
      filters.status.forEach((s, i) => {
        params[`status_${i}`] = s;
      });
    } else {
      where.push(`status = @status`);
      params['status'] = filters.status;
    }
  }
  if (filters.kind) {
    where.push(`kind = @kind`);
    params['kind'] = filters.kind;
  }
  if (filters.application_id) {
    where.push(`application_id = @application_id`);
    params['application_id'] = filters.application_id;
  }

  const sql = `
    SELECT * FROM alerts
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `;
  params['limit'] = filters.limit ?? 100;
  params['offset'] = filters.offset ?? 0;

  const rows = db.prepare(sql).all(params) as AlertRow[];
  return rows.map(rowToAlert);
}

export function findAlertById(db: DatabaseType, id: string): Alert | null {
  const row = db.prepare(`SELECT * FROM alerts WHERE id = ?`).get(id) as AlertRow | undefined;
  return row ? rowToAlert(row) : null;
}

export interface AlertInsertInput {
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  description: string;
  application_id?: string | null;
  site_id?: string | null;
  /** JSON-stringified by the caller, or pass an object and we'll stringify. */
  payload?: unknown;
}

export function insertAlert(db: DatabaseType, input: AlertInsertInput): Alert {
  const id = newId();
  const now = new Date().toISOString();
  const payload =
    input.payload === undefined || input.payload === null
      ? null
      : typeof input.payload === 'string'
        ? input.payload
        : JSON.stringify(input.payload);

  db.prepare(
    `INSERT INTO alerts
       (id, kind, severity, title, description, application_id, site_id,
        payload, status, resolution_value, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, NULL)`,
  ).run(
    id,
    input.kind,
    input.severity,
    input.title,
    input.description,
    input.application_id ?? null,
    input.site_id ?? null,
    payload,
    now,
  );

  return findAlertById(db, id)!;
}

/**
 * Resolves an alert. Idempotent: resolving an already-resolved alert is a
 * no-op and returns the existing row unchanged.
 */
export function resolveAlert(db: DatabaseType, id: string, value?: string): Alert {
  const current = findAlertById(db, id);
  if (!current) throw new NotFoundError(`Alert ${id} not found`);
  if (current.status === 'resolved') return current;

  const ts = new Date().toISOString();
  db.prepare(
    `UPDATE alerts SET status = 'resolved', resolution_value = ?, resolved_at = ? WHERE id = ?`,
  ).run(value ?? null, ts, id);

  return findAlertById(db, id)!;
}

export function dismissAlert(db: DatabaseType, id: string): Alert {
  const current = findAlertById(db, id);
  if (!current) throw new NotFoundError(`Alert ${id} not found`);
  if (current.status === 'dismissed') return current;

  const ts = new Date().toISOString();
  db.prepare(`UPDATE alerts SET status = 'dismissed', resolved_at = ? WHERE id = ?`).run(ts, id);

  return findAlertById(db, id)!;
}
