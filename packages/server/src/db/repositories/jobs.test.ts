import { describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { JobInsertInput } from './jobs.js';
import { freshTestDb } from '../test-helpers.js';
import { findJobById, insertJob, listJobs, updateJobScore, updateJobStatus } from './jobs.js';

function jobInput(overrides: Partial<JobInsertInput> = {}): JobInsertInput {
  return {
    site_id: 'linkedin',
    external_id: 'abc123',
    url: 'https://www.linkedin.com/jobs/view/abc123',
    apply_method: 'auto',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    description: 'Backend role.',
    ...overrides,
  };
}

function seedJobs(db: DatabaseType) {
  insertJob(db, jobInput({ external_id: 'a', title: 'Senior TypeScript Engineer' }));
  insertJob(
    db,
    jobInput({
      external_id: 'b',
      site_id: 'google',
      apply_method: 'manual',
      external_apply_url: 'https://acme.greenhouse.io/jobs/1',
      original_source: 'Greenhouse',
      title: 'Staff Go Engineer',
      company: 'Globex',
      description: 'We use Go and Kafka.',
    }),
  );
  insertJob(db, jobInput({ external_id: 'c', title: 'Junior Frontend' }));
}

describe('jobs repository', () => {
  it('insertJob dedups by (site_id, external_id) and returns the existing row', () => {
    const db = freshTestDb();
    const a = insertJob(db, jobInput({ external_id: 'a' }));
    const again = insertJob(db, jobInput({ external_id: 'a', title: 'IGNORED' }));
    expect(again.id).toBe(a.id);
    expect(again.title).toBe(a.title); // existing row, not replaced
    expect(listJobs(db)).toHaveLength(1);
    db.close();
  });

  it('different sites with same external_id are distinct rows', () => {
    const db = freshTestDb();
    insertJob(db, jobInput({ site_id: 'linkedin', external_id: 'shared' }));
    insertJob(db, jobInput({ site_id: 'indeed', external_id: 'shared' }));
    expect(listJobs(db)).toHaveLength(2);
    db.close();
  });

  it('filters by apply_method=manual', () => {
    const db = freshTestDb();
    seedJobs(db);
    const manual = listJobs(db, { apply_method: 'manual' });
    expect(manual).toHaveLength(1);
    expect(manual[0]?.apply_method).toBe('manual');
    db.close();
  });

  it('filters by site_id and status', () => {
    const db = freshTestDb();
    seedJobs(db);
    const linkedinNew = listJobs(db, { site_id: 'linkedin', status: 'new' });
    expect(linkedinNew).toHaveLength(2);
    expect(linkedinNew.every((j) => j.site_id === 'linkedin')).toBe(true);
    db.close();
  });

  it('filters by min_score', () => {
    const db = freshTestDb();
    seedJobs(db);
    const all = listJobs(db);
    updateJobScore(db, all[0]!.id, 90, 'Strong match');
    updateJobScore(db, all[1]!.id, 60, 'OK match');

    const hits = listJobs(db, { min_score: 80 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.match_score).toBe(90);
    db.close();
  });

  it('full-text search hits title, company, and description', () => {
    const db = freshTestDb();
    seedJobs(db);

    expect(listJobs(db, { search: 'TypeScript' })).toHaveLength(1);
    expect(listJobs(db, { search: 'Globex' })).toHaveLength(1);
    expect(listJobs(db, { search: 'kafka' }).map((j) => j.external_id)).toEqual(['b']); // case-insensitive
    db.close();
  });

  it('updateJobStatus persists and round-trips', () => {
    const db = freshTestDb();
    const j = insertJob(db, jobInput());
    const updated = updateJobStatus(db, j.id, 'queued');
    expect(updated?.status).toBe('queued');
    expect(findJobById(db, j.id)?.status).toBe('queued');
    db.close();
  });
});
