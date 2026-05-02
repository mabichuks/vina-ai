import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '@vina/shared';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
  insertApplication,
  markApplicationApplied,
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
