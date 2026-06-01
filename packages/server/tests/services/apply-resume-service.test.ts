import { describe, expect, it, beforeEach } from 'vitest';
import { resumeFromAlertResolution } from '../../src/services/apply-resume-service.js';
import {
  insertApplication,
  findApplicationById,
  updateApplicationStatus,
} from '../../src/db/repositories/applications.js';
import { insertJob } from '../../src/db/repositories/jobs.js';
import { insertCv } from '../../src/db/repositories/cvs.js';
import { insertAlert, resolveAlert } from '../../src/db/repositories/alerts.js';
import { findAnswer } from '../../src/db/repositories/profile-answers.js';
import { listEvents } from '../../src/db/repositories/application-events.js';
import { freshTestDb } from '../db/helpers.js';

let db: ReturnType<typeof freshTestDb>;

function seedApp(opts: { status?: 'queued' | 'awaiting_approval' | 'submitted' } = {}) {
  const cv = insertCv(db, {
    label: 'Default',
    original_filename: 'cv.docx',
    mime_type:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    file_path: '/tmp/cv.docx',
    extracted_text: 'CV',
    is_default: true,
  });
  const job = insertJob(db, {
    site_id: 'linkedin',
    external_id: 'job-1',
    url: 'https://www.linkedin.com/jobs/view/1',
    apply_method: 'auto',
    title: 'Senior',
    company: 'Acme',
    description: 'role',
  });
  const app = insertApplication(db, {
    job_id: job.id,
    cv_id: cv.id,
    apply_method: 'auto',
    status: opts.status ?? 'awaiting_approval',
  });
  return { cv, job, app };
}

function findQueuedApplyTasks(): Array<{ application_id: string }> {
  // task_queue payload column is JSON string.
  const rows = db
    .prepare(
      `SELECT payload FROM task_queue WHERE kind = 'apply' AND status = 'pending'`,
    )
    .all() as Array<{ payload: string }>;
  return rows.map((r) => JSON.parse(r.payload) as { application_id: string });
}

beforeEach(() => {
  db = freshTestDb();
});

describe('resumeFromAlertResolution — missing_field', () => {
  it('saves the resolution to profile_answers and re-enqueues an apply task', async () => {
    const { app } = seedApp();
    const alert = insertAlert(db, {
      kind: 'missing_field',
      severity: 'action_required',
      title: 'Need your input',
      description: 'Highest qualification?',
      application_id: app.id,
      payload: { field_label: 'Highest qualification', field_kind: 'text' },
    });
    const resolved = resolveAlert(db, alert.id, "Master's");
    const outcome = resumeFromAlertResolution(db, resolved, "Master's");
    expect(outcome).toEqual({ resumed: true, savedAnswer: true });

    const saved = findAnswer(db, 'highest_qualification');
    expect(saved?.label).toBe('Highest qualification');
    expect(saved?.value).toBe("Master's");

    const queued = findQueuedApplyTasks();
    expect(queued).toContainEqual({ application_id: app.id });

    expect(findApplicationById(db, app.id)?.status).toBe('queued');

    const events = listEvents(db, app.id);
    expect(events.some((e) => e.kind === 'resumed')).toBe(true);
  });

  it('does not save an answer when no resolution value is provided', () => {
    const { app } = seedApp();
    const alert = insertAlert(db, {
      kind: 'missing_field',
      severity: 'action_required',
      title: 't',
      description: 'd',
      application_id: app.id,
      payload: { field_label: 'Some field', field_kind: 'text' },
    });
    const resolved = resolveAlert(db, alert.id);
    const outcome = resumeFromAlertResolution(db, resolved, null);
    // Still re-enqueues (user might be marking as resolved without an answer),
    // but no answer is saved.
    expect(outcome.savedAnswer).toBe(false);
    expect(findAnswer(db, 'some_field')).toBeNull();
  });
});

describe('resumeFromAlertResolution — non-missing-field alerts', () => {
  it('re-enqueues for awaiting_approval and moves the app to queued', () => {
    const { app } = seedApp({ status: 'awaiting_approval' });
    const alert = insertAlert(db, {
      kind: 'awaiting_approval',
      severity: 'action_required',
      title: 't',
      description: 'd',
      application_id: app.id,
    });
    const resolved = resolveAlert(db, alert.id);
    const outcome = resumeFromAlertResolution(db, resolved);
    expect(outcome.resumed).toBe(true);
    expect(findQueuedApplyTasks()).toContainEqual({ application_id: app.id });
    expect(findApplicationById(db, app.id)?.status).toBe('queued');
  });

  it('re-enqueues for captcha + session_expired', () => {
    const { app } = seedApp({ status: 'awaiting_approval' });
    const alert = insertAlert(db, {
      kind: 'captcha',
      severity: 'action_required',
      title: 't',
      description: 'd',
      application_id: app.id,
    });
    const resolved = resolveAlert(db, alert.id);
    const outcome = resumeFromAlertResolution(db, resolved);
    expect(outcome.resumed).toBe(true);
  });
});

describe('resumeFromAlertResolution — guards', () => {
  it('does nothing for an alert kind that is not resumable', () => {
    const { app } = seedApp();
    const alert = insertAlert(db, {
      kind: 'score_failed',
      severity: 'error',
      title: 't',
      description: 'd',
      application_id: app.id,
    });
    const resolved = resolveAlert(db, alert.id);
    const outcome = resumeFromAlertResolution(db, resolved);
    expect(outcome.resumed).toBe(false);
    expect(findQueuedApplyTasks()).toHaveLength(0);
  });

  it('does not resume an already-submitted application', () => {
    const { app } = seedApp();
    updateApplicationStatus(db, app.id, 'submitted');
    const alert = insertAlert(db, {
      kind: 'missing_field',
      severity: 'action_required',
      title: 't',
      description: 'd',
      application_id: app.id,
      payload: { field_label: 'X' },
    });
    const resolved = resolveAlert(db, alert.id, 'val');
    const outcome = resumeFromAlertResolution(db, resolved, 'val');
    expect(outcome.resumed).toBe(false);
    expect(outcome.savedAnswer).toBe(false);
  });

  it('does nothing when the alert has no application_id', () => {
    const alert = insertAlert(db, {
      kind: 'captcha',
      severity: 'action_required',
      title: 't',
      description: 'd',
    });
    const resolved = resolveAlert(db, alert.id);
    const outcome = resumeFromAlertResolution(db, resolved);
    expect(outcome.resumed).toBe(false);
  });
});
