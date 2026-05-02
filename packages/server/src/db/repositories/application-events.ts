import type { Database as DatabaseType } from 'better-sqlite3';
import { newId, type ApplicationEvent, type ApplicationEventKind } from '@vina/shared';

interface ApplicationEventRow {
  id: string;
  application_id: string;
  kind: ApplicationEventKind;
  payload: string | null;
  screenshot_path: string | null;
  created_at: string;
}

function rowToEvent(row: ApplicationEventRow): ApplicationEvent {
  return row;
}

export interface AppendEventInput {
  application_id: string;
  kind: ApplicationEventKind;
  payload?: unknown;
  screenshot_path?: string | null;
}

export function appendEvent(db: DatabaseType, input: AppendEventInput): ApplicationEvent {
  const id = newId();
  const now = new Date().toISOString();
  const payload =
    input.payload === undefined || input.payload === null
      ? null
      : typeof input.payload === 'string'
        ? input.payload
        : JSON.stringify(input.payload);

  db.prepare(
    `INSERT INTO application_events
       (id, application_id, kind, payload, screenshot_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.application_id, input.kind, payload, input.screenshot_path ?? null, now);

  return {
    id,
    application_id: input.application_id,
    kind: input.kind,
    payload,
    screenshot_path: input.screenshot_path ?? null,
    created_at: now,
  };
}

export function listEvents(db: DatabaseType, applicationId: string): ApplicationEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM application_events
       WHERE application_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(applicationId) as ApplicationEventRow[];
  return rows.map(rowToEvent);
}
