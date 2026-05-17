import type { Database as DatabaseType } from 'better-sqlite3';
import {
  ConflictError,
  NotFoundError,
  newId,
  type Application,
  type ApplicationStatus,
  type ApplyMethod,
} from '@vina/shared';

interface ApplicationRow {
  id: string;
  job_id: string;
  cv_id: string;
  cover_letter_id: string | null;
  apply_method: ApplyMethod;
  tailored_cv_path: string | null;
  tailored_cover_letter_path: string | null;
  tailored_at: string | null;
  status: ApplicationStatus;
  started_at: string;
  submitted_at: string | null;
  applied_manually_at: string | null;
  applied_manually_notes: string | null;
  failure_reason: string | null;
  form_state: string | null;
}

function rowToApplication(row: ApplicationRow): Application {
  return row;
}

export interface ApplicationFilters {
  status?: ApplicationStatus | ApplicationStatus[];
  apply_method?: ApplyMethod;
  job_id?: string;
  limit?: number;
  offset?: number;
}

export function listApplications(
  db: DatabaseType,
  filters: ApplicationFilters = {},
): Application[] {
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
  if (filters.apply_method) {
    where.push(`apply_method = @apply_method`);
    params['apply_method'] = filters.apply_method;
  }
  if (filters.job_id) {
    where.push(`job_id = @job_id`);
    params['job_id'] = filters.job_id;
  }

  const sql = `
    SELECT * FROM applications
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY started_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `;
  params['limit'] = filters.limit ?? 100;
  params['offset'] = filters.offset ?? 0;

  const rows = db.prepare(sql).all(params) as ApplicationRow[];
  return rows.map(rowToApplication);
}

export function findApplicationById(db: DatabaseType, id: string): Application | null {
  const row = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(id) as
    | ApplicationRow
    | undefined;
  return row ? rowToApplication(row) : null;
}

export interface ApplicationInsertInput {
  job_id: string;
  cv_id: string;
  cover_letter_id?: string | null;
  apply_method: ApplyMethod;
  status?: ApplicationStatus;
}

export function insertApplication(db: DatabaseType, input: ApplicationInsertInput): Application {
  const id = newId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO applications
       (id, job_id, cv_id, cover_letter_id, apply_method, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.job_id,
    input.cv_id,
    input.cover_letter_id ?? null,
    input.apply_method,
    input.status ?? 'queued',
    now,
  );
  return findApplicationById(db, id)!;
}

export function updateApplicationStatus(
  db: DatabaseType,
  id: string,
  status: ApplicationStatus,
  extra: { failure_reason?: string | null; submitted_at?: string | null } = {},
): Application {
  const current = findApplicationById(db, id);
  if (!current) throw new NotFoundError(`Application ${id} not found`);

  const submitted_at =
    extra.submitted_at !== undefined
      ? extra.submitted_at
      : status === 'submitted' && !current.submitted_at
        ? new Date().toISOString()
        : current.submitted_at;
  const failure_reason =
    extra.failure_reason !== undefined ? extra.failure_reason : current.failure_reason;

  db.prepare(
    `UPDATE applications SET status = ?, failure_reason = ?, submitted_at = ? WHERE id = ?`,
  ).run(status, failure_reason, submitted_at, id);

  return findApplicationById(db, id)!;
}

export function updateApplicationFormState(
  db: DatabaseType,
  id: string,
  formState: string | null,
): Application {
  const current = findApplicationById(db, id);
  if (!current) throw new NotFoundError(`Application ${id} not found`);
  db.prepare(`UPDATE applications SET form_state = ? WHERE id = ?`).run(formState, id);
  return { ...current, form_state: formState };
}

/**
 * Atomic patch used by the prepare_manual_apply handler: writes both tailored
 * paths, stamps `tailored_at`, and flips status (typically to
 * `ready_for_manual_apply`). Caller wraps this in a transaction together with
 * the alert insert + event emit.
 */
export function setApplicationTailored(
  db: DatabaseType,
  id: string,
  patch: {
    tailored_cv_path: string;
    tailored_cover_letter_path: string | null;
    tailored_at: string;
    new_status: ApplicationStatus;
  },
): Application {
  const current = findApplicationById(db, id);
  if (!current) throw new NotFoundError(`Application ${id} not found`);
  db.prepare(
    `UPDATE applications
       SET tailored_cv_path = ?,
           tailored_cover_letter_path = ?,
           tailored_at = ?,
           status = ?
     WHERE id = ?`,
  ).run(
    patch.tailored_cv_path,
    patch.tailored_cover_letter_path,
    patch.tailored_at,
    patch.new_status,
    id,
  );
  return findApplicationById(db, id)!;
}

const TERMINAL_STATUSES: ReadonlySet<ApplicationStatus> = new Set([
  'applied_manually',
  'submitted',
  'failed',
  'skipped',
]);

/**
 * Return the most recent non-terminal application for this job, or null when
 * every application is in a terminal state (or none exist). Used by the
 * `POST /api/jobs/:id/prepare` route for idempotency — the user clicking
 * "Prepare materials" twice should attach to the same in-flight application.
 */
export function findActiveApplicationForJob(
  db: DatabaseType,
  jobId: string,
): Application | null {
  const rows = db
    .prepare(
      `SELECT * FROM applications
         WHERE job_id = ?
         ORDER BY started_at DESC, id DESC`,
    )
    .all(jobId) as ApplicationRow[];
  for (const row of rows) {
    if (!TERMINAL_STATUSES.has(row.status)) return rowToApplication(row);
  }
  return null;
}

export function markApplicationSkipped(
  db: DatabaseType,
  id: string,
  reason?: string,
): Application {
  const current = findApplicationById(db, id);
  if (!current) throw new NotFoundError(`Application ${id} not found`);
  db.prepare(
    `UPDATE applications SET status = 'skipped', failure_reason = ? WHERE id = ?`,
  ).run(reason ?? null, id);
  return findApplicationById(db, id)!;
}

/**
 * Manual-apply terminal transition. Only valid from `ready_for_manual_apply`;
 * any other state throws ConflictError.
 */
export function markApplicationApplied(
  db: DatabaseType,
  id: string,
  appliedAt?: string,
  notes?: string,
): Application {
  const current = findApplicationById(db, id);
  if (!current) throw new NotFoundError(`Application ${id} not found`);
  if (current.status !== 'ready_for_manual_apply') {
    throw new ConflictError(
      `Application ${id} is in status '${current.status}', expected 'ready_for_manual_apply'`,
    );
  }

  const ts = appliedAt ?? new Date().toISOString();
  db.prepare(
    `UPDATE applications SET
       status = 'applied_manually',
       applied_manually_at = ?,
       applied_manually_notes = ?
     WHERE id = ?`,
  ).run(ts, notes ?? null, id);

  return findApplicationById(db, id)!;
}
