import { beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { freshTestDb } from '../db/helpers.js';
import { createEventBus } from '../../src/events/bus.js';
import { insertCv } from '../../src/db/repositories/cvs.js';
import { insertJob } from '../../src/db/repositories/jobs.js';
import { enqueueEasyApplyForJob } from '../../src/queue/easy-apply-enqueuer.js';

let db: DatabaseType;

beforeEach(() => {
  db = freshTestDb();
  // Default CV is required for the enqueuer to attach to the application.
  insertCv(db, {
    label: 'Default',
    original_filename: 'cv.pdf',
    mime_type: 'application/pdf',
    file_path: '/tmp/cv.pdf',
    is_default: true,
  });
});

function makeAutoJob(externalId = 'auto-1'): ReturnType<typeof insertJob> {
  return insertJob(db, {
    site_id: 'linkedin',
    external_id: externalId,
    url: `https://www.linkedin.com/jobs/view/${externalId}`,
    apply_method: 'auto',
    title: 'Senior Engineer',
    company: 'Acme',
    description: 'Build things.',
  });
}

function makeManualJob(externalId = 'man-1'): ReturnType<typeof insertJob> {
  return insertJob(db, {
    site_id: 'linkedin',
    external_id: externalId,
    url: `https://www.linkedin.com/jobs/view/${externalId}`,
    apply_method: 'manual',
    title: 'Manual Engineer',
    company: 'Acme',
    description: 'External ATS.',
  });
}

describe('enqueueEasyApplyForJob', () => {
  it('creates an application + apply task and returns the new application id', () => {
    const bus = createEventBus();
    const job = makeAutoJob();

    const result = enqueueEasyApplyForJob(db, bus, job.id);

    expect(result.deduped).toBe(false);
    expect(result.status).toBe('queued');
    const tasks = db
      .prepare(`SELECT * FROM task_queue WHERE kind = 'apply'`)
      .all() as Array<{ payload: string; status: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe('pending');
    const payload = JSON.parse(tasks[0]!.payload) as { application_id: string };
    expect(payload.application_id).toBe(result.application_id);
    const apps = db
      .prepare(`SELECT * FROM applications WHERE job_id = ?`)
      .all(job.id) as Array<{ apply_method: string; status: string }>;
    expect(apps).toHaveLength(1);
    expect(apps[0]!.apply_method).toBe('auto');
  });

  it('dedupes when an active application already exists for the job', () => {
    const bus = createEventBus();
    const job = makeAutoJob();

    const first = enqueueEasyApplyForJob(db, bus, job.id);
    const second = enqueueEasyApplyForJob(db, bus, job.id);

    expect(second.deduped).toBe(true);
    expect(second.application_id).toBe(first.application_id);
    const tasks = db
      .prepare(`SELECT * FROM task_queue WHERE kind = 'apply'`)
      .all();
    expect(tasks).toHaveLength(1);
  });

  it('refuses to enqueue when the job is manual-apply (ConflictError)', () => {
    const bus = createEventBus();
    const job = makeManualJob();
    expect(() => enqueueEasyApplyForJob(db, bus, job.id)).toThrow(
      /not an Easy Apply/,
    );
  });

  it('throws when the job does not exist (ValidationError)', () => {
    const bus = createEventBus();
    expect(() => enqueueEasyApplyForJob(db, bus, 'nonexistent')).toThrow(
      /not found/,
    );
  });

  it('throws when no default CV exists (ValidationError)', () => {
    // Wipe the default-CV seed from beforeEach.
    db.prepare(`DELETE FROM cvs`).run();
    const bus = createEventBus();
    const job = makeAutoJob('auto-no-cv');
    expect(() => enqueueEasyApplyForJob(db, bus, job.id)).toThrow(
      /Upload a CV/,
    );
  });
});
