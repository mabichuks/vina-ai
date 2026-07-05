import type { Database as DatabaseType } from 'better-sqlite3';
import { newId, type ApplyMethod, type Job, type JobStatus } from '@vina/shared';

interface JobRow {
  id: string;
  site_id: string;
  external_id: string;
  url: string;
  external_apply_url: string | null;
  apply_method: ApplyMethod;
  original_source: string | null;
  title: string;
  company: string;
  location: string | null;
  description: string;
  salary_text: string | null;
  posted_at: string | null;
  discovered_at: string;
  match_score: number | null;
  match_justification: string | null;
  status: JobStatus;
}

function rowToJob(row: JobRow): Job {
  return row;
}

export interface JobFilters {
  status?: JobStatus | JobStatus[];
  site_id?: string;
  apply_method?: ApplyMethod;
  min_score?: number;
  /** Free-text search across title, company, description (case-insensitive LIKE). */
  search?: string;
  limit?: number;
  offset?: number;
}

function buildJobWhere(filters: Omit<JobFilters, 'limit' | 'offset'>): {
  whereSql: string;
  params: Record<string, unknown>;
} {
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
  if (filters.site_id) {
    where.push(`site_id = @site_id`);
    params['site_id'] = filters.site_id;
  }
  if (filters.apply_method) {
    where.push(`apply_method = @apply_method`);
    params['apply_method'] = filters.apply_method;
  }
  if (filters.min_score !== undefined) {
    // Unscored rows (`match_score IS NULL`) are kept in the worklist while
    // they're still being processed — they show up as "Scoring…" placeholders
    // in the UI. Only fully-scored rows are filtered against the threshold.
    where.push(`(match_score IS NULL OR match_score >= @min_score)`);
    params['min_score'] = filters.min_score;
  }
  if (filters.search) {
    where.push(`(
      title LIKE @search COLLATE NOCASE OR
      company LIKE @search COLLATE NOCASE OR
      description LIKE @search COLLATE NOCASE
    )`);
    params['search'] = `%${filters.search}%`;
  }

  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listJobs(db: DatabaseType, filters: JobFilters = {}): Job[] {
  const { whereSql, params } = buildJobWhere(filters);

  // Best matches first (score DESC), unscored rows pinned to the bottom so
  // the worklist stays stable while scores stream in. Ties broken by recency.
  const sql = `
    SELECT * FROM jobs
    ${whereSql}
    ORDER BY match_score DESC NULLS LAST, discovered_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `;
  params['limit'] = filters.limit ?? 100;
  params['offset'] = filters.offset ?? 0;

  const rows = db.prepare(sql).all(params) as JobRow[];
  return rows.map(rowToJob);
}

export function countJobs(
  db: DatabaseType,
  filters: Omit<JobFilters, 'limit' | 'offset'> = {},
): number {
  const { whereSql, params } = buildJobWhere(filters);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM jobs ${whereSql}`)
    .get(params) as { n: number };
  return row.n;
}

export function findJobById(db: DatabaseType, id: string): Job | null {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export interface JobInsertInput {
  site_id: string;
  external_id: string;
  url: string;
  external_apply_url?: string | null;
  apply_method: ApplyMethod;
  original_source?: string | null;
  title: string;
  company: string;
  location?: string | null;
  description: string;
  salary_text?: string | null;
  posted_at?: string | null;
  status?: JobStatus;
}

/**
 * Insert a new job. If `(site_id, external_id)` already exists, returns the
 * existing row instead of erroring (dedup at the source).
 */
export function insertJob(db: DatabaseType, input: JobInsertInput): Job {
  const existing = db
    .prepare(`SELECT * FROM jobs WHERE site_id = ? AND external_id = ?`)
    .get(input.site_id, input.external_id) as JobRow | undefined;
  if (existing) return rowToJob(existing);

  const id = newId();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO jobs
       (id, site_id, external_id, url, external_apply_url, apply_method, original_source,
        title, company, location, description, salary_text, posted_at, discovered_at,
        match_score, match_justification, status)
     VALUES (@id, @site_id, @external_id, @url, @external_apply_url, @apply_method, @original_source,
             @title, @company, @location, @description, @salary_text, @posted_at, @discovered_at,
             NULL, NULL, @status)`,
  ).run({
    id,
    site_id: input.site_id,
    external_id: input.external_id,
    url: input.url,
    external_apply_url: input.external_apply_url ?? null,
    apply_method: input.apply_method,
    original_source: input.original_source ?? null,
    title: input.title,
    company: input.company,
    location: input.location ?? null,
    description: input.description,
    salary_text: input.salary_text ?? null,
    posted_at: input.posted_at ?? null,
    discovered_at: now,
    status: input.status ?? 'new',
  });

  return findJobById(db, id)!;
}

export function updateJobStatus(db: DatabaseType, id: string, status: JobStatus): Job | null {
  db.prepare(`UPDATE jobs SET status = ? WHERE id = ?`).run(status, id);
  return findJobById(db, id);
}

export function updateJobScore(
  db: DatabaseType,
  id: string,
  score: number,
  justification: string | null,
): Job | null {
  db.prepare(`UPDATE jobs SET match_score = ?, match_justification = ? WHERE id = ?`).run(
    score,
    justification,
    id,
  );
  return findJobById(db, id);
}
