import type { Database as DatabaseType } from 'better-sqlite3';
import { ConflictError, ValidationError } from '@vina/shared';
import {
  findActiveApplicationForJob,
  insertApplication,
} from '../db/repositories/applications.js';
import { findJobById } from '../db/repositories/jobs.js';
import { listCvs } from '../db/repositories/cvs.js';
import { enqueue } from '../db/repositories/task-queue.js';
import type { EventBus } from '../events/bus.js';

export interface EnqueueResult {
  application_id: string;
  status: string;
  deduped: boolean;
}

/**
 * Idempotent: if an active (non-terminal) application already exists for this
 * auto-apply job, return it without piling up tasks. Used by:
 *   - POST /api/jobs/:id/apply (manual JobCard button)
 *   - score handler in autonomous mode (auto-enqueue)
 *
 * Gate checks (cap, throttle, freshness, circuit breaker) are NOT done here —
 * the apply handler performs the authoritative check at task pickup. Calling
 * this is always advisory; the gate has the final say.
 */
export function enqueueEasyApplyForJob(
  db: DatabaseType,
  bus: EventBus,
  jobId: string,
): EnqueueResult {
  const job = findJobById(db, jobId);
  if (!job) throw new ValidationError(`Job ${jobId} not found`);
  if (job.apply_method !== 'auto') {
    throw new ConflictError(`Job ${jobId} is not an Easy Apply job`);
  }

  const existing = findActiveApplicationForJob(db, jobId);
  if (existing) {
    return { application_id: existing.id, status: existing.status, deduped: true };
  }

  const cv = listCvs(db).find((c) => c.is_default);
  if (!cv) throw new ValidationError('Upload a CV in Profile first');

  const app = insertApplication(db, {
    job_id: jobId,
    cv_id: cv.id,
    cover_letter_id: null,
    apply_method: 'auto',
    status: 'queued',
  });

  enqueue(db, { kind: 'apply', payload: { application_id: app.id } });
  bus.emit('jobs:updated', { ids: [jobId] });

  return { application_id: app.id, status: app.status, deduped: false };
}
