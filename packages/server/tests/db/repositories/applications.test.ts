import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '@vina/shared';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
  findActiveApplicationForJob,
  insertApplication,
  markApplicationApplied,
  markApplicationSkipped,
  updateApplicationStatus,
} from '../../../src/db/repositories/applications.js';
import { insertCv } from '../../../src/db/repositories/cvs.js';
import { insertJob } from '../../../src/db/repositories/jobs.js';
import { freshTestDb } from '../helpers.js';

function seedJobAndCv(db: DatabaseType): { cvId: string; jobId: string } {
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
  it('updateApplicationStatus to "submitted" auto-stamps submitted_at', () => {
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

  it('markApplicationApplied requires status=ready_for_manual_apply', () => {
    const db = freshTestDb();
    const { cvId, jobId } = seedJobAndCv(db);
    const wrong = insertApplication(db, {
      job_id: jobId,
      cv_id: cvId,
      apply_method: 'auto',
      status: 'submitted',
    });
    expect(() => markApplicationApplied(db, wrong.id)).toThrow(ConflictError);
    expect(() => markApplicationApplied(db, 'absent')).toThrow(NotFoundError);

    const ready = insertApplication(db, {
      job_id: jobId,
      cv_id: cvId,
      apply_method: 'manual',
      status: 'ready_for_manual_apply',
    });
    const result = markApplicationApplied(db, ready.id, '2026-04-29T10:00:00Z', 'via Workday');
    expect(result.status).toBe('applied_manually');
    expect(result.applied_manually_at).toBe('2026-04-29T10:00:00Z');
    expect(result.applied_manually_notes).toBe('via Workday');
    db.close();
  });
});

describe('applications repository — manual-apply helpers', () => {
  it('findActiveApplicationForJob returns the most recent non-terminal row', () => {
    const db = freshTestDb();
    const { cvId, jobId } = seedJobAndCv(db);
    insertApplication(db, {
      job_id: jobId,
      cv_id: cvId,
      apply_method: 'manual',
      status: 'skipped',
    });
    const ready = insertApplication(db, {
      job_id: jobId,
      cv_id: cvId,
      apply_method: 'manual',
      status: 'ready_for_manual_apply',
    });
    const found = findActiveApplicationForJob(db, jobId);
    expect(found?.id).toBe(ready.id);
    db.close();
  });

  it('returns null when only terminal applications exist for the job', () => {
    const db = freshTestDb();
    const { cvId, jobId } = seedJobAndCv(db);
    insertApplication(db, {
      job_id: jobId,
      cv_id: cvId,
      apply_method: 'manual',
      status: 'failed',
    });
    expect(findActiveApplicationForJob(db, jobId)).toBeNull();
    db.close();
  });

  it('markApplicationSkipped flips status and stores reason', () => {
    const db = freshTestDb();
    const { cvId, jobId } = seedJobAndCv(db);
    const app = insertApplication(db, {
      job_id: jobId,
      cv_id: cvId,
      apply_method: 'manual',
      status: 'ready_for_manual_apply',
    });
    const next = markApplicationSkipped(db, app.id, 'role mismatch');
    expect(next.status).toBe('skipped');
    expect(next.failure_reason).toBe('role mismatch');
    expect(() => markApplicationSkipped(db, 'absent')).toThrow(NotFoundError);
    db.close();
  });
});
