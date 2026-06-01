import type { Database as DatabaseType } from 'better-sqlite3';
import { createLogger, type Alert, type AlertKind } from '@vina/shared';
import {
  findApplicationById,
  updateApplicationStatus,
} from '../db/repositories/applications.js';
import { findJobById } from '../db/repositories/jobs.js';
import { appendEvent } from '../db/repositories/application-events.js';
import { upsertAnswer } from '../db/repositories/profile-answers.js';
import { enqueue } from '../db/repositories/task-queue.js';

const log = createLogger('apply-resume');

/**
 * Alert kinds the resume service responds to. Resolving any of these on an
 * application that's still pending re-enqueues an `apply` task — the next
 * run picks up where this one left off (the field's value, the user's
 * approval, a freshly-logged-in session, or a manually-solved CAPTCHA).
 */
const RESUMABLE_ALERT_KINDS = new Set<AlertKind>([
  'missing_field',
  'awaiting_approval',
  'captcha',
  'session_expired',
  'linkedin_session_expired',
]);

function labelToAnswerKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

export interface ResumeOutcome {
  /** True when the resolution led to an apply task being re-enqueued. */
  resumed: boolean;
  /** True when a profile_answers row was written from a missing_field resolution. */
  savedAnswer: boolean;
}

/**
 * Handle an alert resolution. Idempotent — the alert's status is checked
 * by the caller; this function trusts the alert is freshly resolved.
 *
 *   - `missing_field`: write the user's value to `profile_answers` keyed
 *     by the field label, then re-enqueue the apply task.
 *   - `awaiting_approval`: mark the application approved (status→queued)
 *     and re-enqueue.
 *   - `captcha` / `session_expired` / `linkedin_session_expired`:
 *     re-enqueue without touching application state — the next run
 *     re-snapshots; if the blocker persists it raises another alert.
 */
export function resumeFromAlertResolution(
  db: DatabaseType,
  alert: Alert,
  resolutionValue?: string | null,
): ResumeOutcome {
  if (!RESUMABLE_ALERT_KINDS.has(alert.kind)) {
    return { resumed: false, savedAnswer: false };
  }
  if (!alert.application_id) {
    log.warn({ alert_id: alert.id, kind: alert.kind }, 'resumable alert has no application_id');
    return { resumed: false, savedAnswer: false };
  }
  const app = findApplicationById(db, alert.application_id);
  if (!app) {
    log.warn({ alert_id: alert.id }, 'resumable alert references missing application');
    return { resumed: false, savedAnswer: false };
  }
  // Already-terminal applications don't resume.
  if (
    app.status === 'submitted' ||
    app.status === 'applied_manually' ||
    app.status === 'skipped'
  ) {
    log.debug(
      { alert_id: alert.id, status: app.status },
      'resume skipped — application already terminal',
    );
    return { resumed: false, savedAnswer: false };
  }

  let savedAnswer = false;
  if (alert.kind === 'missing_field') {
    const payload = parsePayload(alert.payload);
    const label =
      typeof payload['field_label'] === 'string' ? payload['field_label'] : null;
    if (label && resolutionValue) {
      const key = labelToAnswerKey(label) || `answer_${Date.now()}`;
      upsertAnswer(db, key, label, resolutionValue);
      savedAnswer = true;
    }
  }

  // Reset status so the queue worker picks it up.
  const nextStatus = alert.kind === 'awaiting_approval' ? 'queued' : 'queued';
  updateApplicationStatus(db, app.id, nextStatus);

  enqueue(db, {
    kind: 'apply',
    payload: { application_id: app.id },
    priority: 5,
  });
  appendEvent(db, {
    application_id: app.id,
    kind: 'resumed',
    payload: { alert_id: alert.id, alert_kind: alert.kind },
  });
  log.info(
    {
      application_id: app.id,
      alert_id: alert.id,
      alert_kind: alert.kind,
      savedAnswer,
    },
    'resumed application after alert resolution',
  );
  return { resumed: true, savedAnswer };
}

function parsePayload(payload: string | null): Record<string, unknown> {
  if (!payload) return {};
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return {};
  }
}
