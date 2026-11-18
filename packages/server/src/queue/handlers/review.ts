import type { Database as DatabaseType } from 'better-sqlite3';
import { createLogger, NotFoundError } from '@vina/shared';
import { findApplicationById } from '../../db/repositories/applications.js';
import { findJobById } from '../../db/repositories/jobs.js';
import { listEvents } from '../../db/repositories/application-events.js';
import type { SessionDriver } from '../../opencode/session-driver.js';
import type { EventBus } from '../../events/bus.js';

const log = createLogger('handler.review');

/**
 * Review runs in a **fresh** `vina-review` session that has never seen the
 * writer's transcript (structural isolation, ADR-024 §5). The handler creates
 * a brand-new session — it never reuses or is handed the `vina-materials`
 * session id — and the reviewer reads job + materials + profile via
 * `vina_job_get` / `vina_materials_read` / `vina_profile_read` and records a
 * verdict with `vina_review_record` (idempotent on `(applicationId, round)`).
 *
 * One round only; the reject→revise loop is deferred to a follow-up.
 */

export interface ReviewHandlerDeps {
  db: DatabaseType;
  bus: EventBus;
  /** Session driver spawning the fresh `vina-review` session (fake in tests). */
  sessionDriver: SessionDriver;
}

export interface ReviewPayload {
  application_id: string;
}

const REVIEW_ROUND = 1;

export function createReviewHandler(
  deps: ReviewHandlerDeps,
): (payload: ReviewPayload) => Promise<void> {
  return async (payload) => {
    const app = findApplicationById(deps.db, payload.application_id);
    if (!app) throw new NotFoundError(`Application ${payload.application_id} not found`);
    const job = findJobById(deps.db, app.job_id);
    if (!job) throw new NotFoundError(`Job ${app.job_id} not found`);

    // Idempotent fast-path: a retried review task whose session already
    // recorded a verdict skips the second session.
    if (!hasVerdict(deps.db, app.id)) {
      const prompt = buildReviewPrompt(app.id, job.title, job.company);
      const result = await deps.sessionDriver.run({ agent: 'vina-review', prompt });

      if (result.outcome.reason !== 'idle') {
        throw new Error(
          `vina-review session ${result.outcome.reason}: ${
            result.outcome.reason === 'failed' ? result.outcome.error : ''
          }`.trim(),
        );
      }

      if (!hasVerdict(deps.db, app.id)) {
        throw new Error('vina-review session ended without recording a verdict');
      }
    }

    deps.bus.emit('jobs:updated', { ids: [job.id] });
    log.info({ application_id: app.id }, 'review complete');
  };
}

function hasVerdict(db: DatabaseType, applicationId: string): boolean {
  return listEvents(db, applicationId).some((e) => {
    if (e.kind !== 'cv_approved' && e.kind !== 'cv_rejected') return false;
    if (!e.payload) return false;
    try {
      return (JSON.parse(e.payload) as { round?: number }).round === REVIEW_ROUND;
    } catch {
      return false;
    }
  });
}

function buildReviewPrompt(applicationId: string, title: string, company: string): string {
  return [
    `Independently audit the tailored materials for this application using the job-review skill, in a fresh context.`,
    ``,
    `applicationId: ${applicationId}`,
    `Job: ${title} @ ${company}`,
    ``,
    `Read the job, the tailored materials, and the profile, then record a single verdict for round ${REVIEW_ROUND} with vina_review_record.`,
  ].join('\n');
}
