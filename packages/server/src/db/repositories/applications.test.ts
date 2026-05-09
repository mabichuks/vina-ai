import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '@vina/shared';
import type { Database as DatabaseType } from 'better-sqlite3';
import { freshTestDb } from '../test-helpers.js';
import { insertCv } from './cvs.js';
import { insertJob } from './jobs.js';
import {
  findApplicationById,
  insertApplication,
  listApplications,
  markApplicationApplied,
  updateApplicationStatus,
} from './applications.js';

function seedJobAndCv(db: DatabaseType) {
  const cv = insertCv(db, {
    label: 'Default',
    original_filename: 'cv.pdf',
    mime_type: 'application/pdf',
    file_path: 'cv.pdf',
  });
  const job = insertJob(db, {
    site_id: 'linkedin',
    external_id: 'abc',
    url: 'https://x',
    apply_method: 'manual',
    title: 't',
    company: 'c',
    description: 'd',
  });
  return { cvId: cv.id, jobId: job.id };
}

describe('applications repository', () => {
  it('insert + find + list', () => {
    const db = freshTestDb();
    const { cvId, jobId } = seedJobAndCv(db);
    const a = insertApplication(db, { job_id: jobId, cv_id: cvId, apply_method: 'manual' });
    expect(a.status).toBe('queued');
    expect(findApplicationById(db, a.id)).toEqual(a);
    expect(listApplications(db)).toHaveLength(1);
    db.close();
  });

  it('filters by status and apply_method', () => {
    const db = freshTestDb();
    const { cvId, jobId } = seedJobAndCv(db);
    insertApplication(db, { job_id: jobId, cv_id: cvId, apply_method: 'manual' });
    insertApplication(db, {
      job_id: jobId,
      cv_id: cvId,
      apply_method: 'auto',
      status: 'applying',
    });
    expect(listApplications(db, { status: 'queued' })).toHaveLength(1);
    expect(listApplications(db, { apply_method: 'auto' })).toHaveLength(1);
    db.close();
  });

  it('updateApplicationStatus to "submitted" stamps submitted_at automatically', () => {
    const db = freshTestDb();
    const { cvId, jobId } = seedJobAndCv(db);
    const a = insertApplication(db, {
      job_id: jobId,
      cv_id: cvId,
      apply_method: 'auto',
      status: 'applying',
    });
    expect(a.submitted_at).toBeNull();

    const submitted = updateApplicationStatus(db, a.id, 'submitted');
    expect(submitted.status).toBe('submitted');
    expect(submitted.submitted_at).not.toBeNull();
    db.close();
  });

  it('markApplicationApplied throws ConflictError when status is not ready_for_manual_apply', () => {
    const db = freshTestDb();
    const { cvId, jobId } = seedJobAndCv(db);
    const a = insertApplication(db, {
      job_id: jobId,
      cv_id: cvId,
      apply_method: 'auto',
      status: 'submitted',
    });
    expect(() => markApplicationApplied(db, a.id)).toThrow(ConflictError);
    db.close();
  });

  it('markApplicationApplied transitions ready_for_manual_apply → applied_manually', () => {
    const db = freshTestDb();
    const { cvId, jobId } = seedJobAndCv(db);
    const a = insertApplication(db, {
      job_id: jobId,
      cv_id: cvId,
      apply_method: 'manual',
      status: 'ready_for_manual_apply',
    });

    const ts = '2026-04-29T10:00:00Z';
    const result = markApplicationApplied(db, a.id, ts, 'Done via Workday');

    expect(result.status).toBe('applied_manually');
    expect(result.applied_manually_at).toBe(ts);
    expect(result.applied_manually_notes).toBe('Done via Workday');
    db.close();
  });

  it('markApplicationApplied on missing id throws NotFoundError', () => {
    const db = freshTestDb();
    expect(() => markApplicationApplied(db, 'absent')).toThrow(NotFoundError);
    db.close();
  });
});
