import type { Database as DatabaseType } from 'better-sqlite3';
import { ConflictError, ValidationError } from '@vina/shared';
import {
  findActiveApplicationForJob,
  insertApplication,
} from '../db/repositories/applications.js';
import { findJobById } from '../db/repositories/jobs.js';
import { listCvs } from '../db/repositories/cvs.js';
import { listCoverLetters } from '../db/repositories/cover-letters.js';
import { enqueue } from '../db/repositories/task-queue.js';
import type { EventBus } from '../events/bus.js';

export interface EnqueueResult {
  application_id: string;
  status: string;
  deduped: boolean;
}

/**
 * Idempotent: if there's already an active application for this job (i.e. one
 * that isn't terminal), return it without creating a duplicate. Used by both:
 *   - POST /api/jobs/:id/prepare (user-initiated)
 *   - score handler in autonomous mode (auto-enqueue)
 */
export function enqueueManualApplyForJob(
  db: DatabaseType,
  bus: EventBus,
  jobId: string,
): EnqueueResult {
  const job = findJobById(db, jobId);
  if (!job) throw new ValidationError(`Job ${jobId} not found`);
  if (job.apply_method !== 'manual') {
    throw new ConflictError(`Job ${jobId} is not a manual-apply job`);
  }

  const existing = findActiveApplicationForJob(db, jobId);
  if (existing) {
    return { application_id: existing.id, status: existing.status, deduped: true };
  }

  const cv = listCvs(db).find((c) => c.is_default);
  if (!cv) throw new ValidationError('Upload a CV in Profile first');

  const cl = listCoverLetters(db).find((c) => c.is_default) ?? null;

  const app = insertApplication(db, {
    job_id: jobId,
    cv_id: cv.id,
    cover_letter_id: cl?.id ?? null,
    apply_method: 'manual',
    status: 'queued',
  });

  enqueue(db, { kind: 'prepare_manual_apply', payload: { application_id: app.id } });
  bus.emit('jobs:updated', { ids: [jobId] });

  return { application_id: app.id, status: app.status, deduped: false };
}
