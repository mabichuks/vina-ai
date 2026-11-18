import type { Database as DatabaseType } from 'better-sqlite3';
import { ConflictError, createLogger, NotFoundError } from '@vina/shared';
import { findApplicationById } from '../../db/repositories/applications.js';
import { findJobById } from '../../db/repositories/jobs.js';
import { findCvById } from '../../db/repositories/cvs.js';
import { findCoverLetterById } from '../../db/repositories/cover-letters.js';
import { findProfile } from '../../db/repositories/profile.js';
import { insertAlert, listAlerts } from '../../db/repositories/alerts.js';
import { enqueue } from '../../db/repositories/task-queue.js';
import type { SessionDriver } from '../../opencode/session-driver.js';
import type { EventBus } from '../../events/bus.js';

const log = createLogger('handler.prepare_manual_apply');

/**
 * Manual-apply preparation now runs on a `vina-materials` agent session
 * (ADR-024 §6). The handler no longer tailors directly: it spawns a session,
 * the agent reads job + profile and writes markdown prose, then
 * `vina_materials_save` renders it deterministically and transitions the
 * application to `ready_for_manual_apply`. The handler verifies that terminal
 * state, raises the ready alert, and enqueues a single review round.
 */

export interface PrepareManualApplyHandlerDeps {
  db: DatabaseType;
  bus: EventBus;
  /** Session driver spawning the `vina-materials` session (fake in tests). */
  sessionDriver: SessionDriver;
}

export interface PrepareManualApplyPayload {
  application_id: string;
}

export function createPrepareManualApplyHandler(
  deps: PrepareManualApplyHandlerDeps,
): (payload: PrepareManualApplyPayload) => Promise<void> {
  return async (payload) => {
    const app = findApplicationById(deps.db, payload.application_id);
    if (!app) throw new NotFoundError(`Application ${payload.application_id} not found`);

    // Idempotent fast-path: a retried task whose session already reached the
    // terminal state skips the second session and just re-raises the review
    // enqueue (both are idempotent).
    if (app.status !== 'ready_for_manual_apply') {
      const job = findJobById(deps.db, app.job_id);
      if (!job) throw new NotFoundError(`Job ${app.job_id} not found`);
      const cv = findCvById(deps.db, app.cv_id);
      if (!cv) throw new ConflictError('Application has no CV — upload one in Profile first');
      const coverLetter = app.cover_letter_id
        ? findCoverLetterById(deps.db, app.cover_letter_id)
        : null;
      const profile = findProfile(deps.db);
      if (!profile) throw new ConflictError('Profile not configured — cannot tailor');

      const prompt = buildMaterialsPrompt({ applicationId: app.id, job, coverLetter });
      const result = await deps.sessionDriver.run({ agent: 'vina-materials', prompt });

      if (result.outcome.reason !== 'idle') {
        throw new Error(
          `vina-materials session ${result.outcome.reason}: ${
            result.outcome.reason === 'failed' ? result.outcome.error : ''
          }`.trim(),
        );
      }

      const fresh = findApplicationById(deps.db, app.id);
      if (fresh?.status !== 'ready_for_manual_apply') {
        throw new Error(
          `vina-materials session ended without reaching ready_for_manual_apply (status=${fresh?.status})`,
        );
      }
    }

    const ready = findApplicationById(deps.db, app.id)!;
    const job = findJobById(deps.db, ready.job_id)!;

    // Raise the ready alert once — a retried run must not duplicate it.
    const existing = listAlerts(deps.db, {
      kind: 'ready_for_manual_apply',
      application_id: ready.id,
    });
    if (existing.length === 0) {
      const external_apply_url = job.external_apply_url ?? job.url;
      insertAlert(deps.db, {
        kind: 'ready_for_manual_apply',
        severity: 'action_required',
        title: `Tailored materials ready for ${job.title} @ ${job.company}`,
        description: 'Download the tailored CV and apply externally, then mark applied.',
        application_id: ready.id,
        payload: {
          application_id: ready.id,
          job_id: job.id,
          external_apply_url,
          tailored_cv_path: ready.tailored_cv_path,
          tailored_cover_letter_path: ready.tailored_cover_letter_path,
        },
      });
    }

    // One review round per ready application (single round; reject→revise loop
    // is deferred). The enqueue is idempotent on (kind, payload).
    enqueue(deps.db, {
      kind: 'review',
      payload: { application_id: ready.id },
    });
    deps.bus.emit('jobs:updated', { ids: [job.id] });

    log.info({ application_id: ready.id }, 'manual-apply preparation complete');
  };
}

function buildMaterialsPrompt(opts: {
  applicationId: string;
  job: { title: string; company: string; description: string };
  coverLetter: { extracted_text: string | null } | null;
}): string {
  const lines = [
    `Prepare the application package for one role using the job-materials skill.`,
    ``,
    `applicationId: ${opts.applicationId}`,
    `Job: ${opts.job.title} @ ${opts.job.company}`,
    ``,
    opts.coverLetter?.extracted_text
      ? `A cover-letter template is available; tailor it too.`
      : `No cover letter is required for this role.`,
  ];
  return lines.join('\n');
}
