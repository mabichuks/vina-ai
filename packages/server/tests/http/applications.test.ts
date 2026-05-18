import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auth, buildTestApp, type TestAppHandle } from './helpers.js';
import { insertJob } from '../../src/db/repositories/jobs.js';
import { insertCv } from '../../src/db/repositories/cvs.js';
import {
  insertApplication,
  setApplicationTailored,
} from '../../src/db/repositories/applications.js';
import { insertAlert, listAlerts } from '../../src/db/repositories/alerts.js';
import { listPending } from '../../src/db/repositories/task-queue.js';

let h: TestAppHandle;
let cvId: string;

beforeEach(async () => {
  h = await buildTestApp();
  const cv = insertCv(h.db, {
    label: 'main',
    original_filename: 'cv.pdf',
    mime_type: 'application/pdf',
    file_path: '/tmp/cv.pdf',
    extracted_text: 'x',
    is_default: true,
  });
  cvId = cv.id;
});
afterEach(async () => {
  await h.cleanup();
});

let jobCounter = 0;
function seedManualJob(): ReturnType<typeof insertJob> {
  jobCounter += 1;
  return insertJob(h.db, {
    site_id: 'linkedin',
    external_id: `j-${jobCounter}`,
    url: 'https://x',
    apply_method: 'manual',
    title: 'T',
    company: 'C',
    description: 'd',
    external_apply_url: 'https://greenhouse.io/apply',
  });
}

describe('POST /api/jobs/:id/prepare', () => {
  it('creates an application and enqueues a prepare_manual_apply task', async () => {
    const job = seedManualJob();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/prepare`,
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { application_id: string; status: string; deduped: boolean };
    expect(body.status).toBe('queued');
    expect(body.deduped).toBe(false);
    const pending = listPending(h.db);
    expect(pending.find((t) => t.kind === 'prepare_manual_apply')).toBeDefined();
  });

  it('is idempotent: returns the existing active application without enqueueing twice', async () => {
    const job = seedManualJob();
    const a = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/prepare`,
      headers: auth(h.token),
    });
    const b = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/prepare`,
      headers: auth(h.token),
    });
    expect(a.json().application_id).toBe(b.json().application_id);
    expect(b.json().deduped).toBe(true);
    const pending = listPending(h.db);
    expect(pending.filter((t) => t.kind === 'prepare_manual_apply')).toHaveLength(1);
  });

  it('returns 400 when no default CV exists', async () => {
    h.db.exec(`DELETE FROM applications`);
    h.db.exec(`DELETE FROM cvs`);
    const job = seedManualJob();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/prepare`,
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/cv/i);
  });
});

describe('GET /api/applications', () => {
  it('filters by status (default ready_for_manual_apply)', async () => {
    const job = seedManualJob();
    insertApplication(h.db, {
      job_id: job.id,
      cv_id: cvId,
      apply_method: 'manual',
      status: 'ready_for_manual_apply',
    });
    insertApplication(h.db, {
      job_id: job.id,
      cv_id: cvId,
      apply_method: 'manual',
      status: 'skipped',
    });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/applications',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
  });
});

describe('GET /api/applications/:id/tailored-cv', () => {
  it('404s when the application is not yet tailored', async () => {
    const job = seedManualJob();
    const a = insertApplication(h.db, {
      job_id: job.id,
      cv_id: cvId,
      apply_method: 'manual',
      status: 'queued',
    });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/applications/${a.id}/tailored-cv`,
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('streams the DOCX when the row has a path on disk', async () => {
    const job = seedManualJob();
    const a = insertApplication(h.db, {
      job_id: job.id,
      cv_id: cvId,
      apply_method: 'manual',
      status: 'queued',
    });
    const tmpFile = path.join(h.config.dataDir, 'files', 'tailored', `${a.id}.docx`);
    const tmpPdf = path.join(h.config.dataDir, 'files', 'tailored-pdf', `${a.id}.pdf`);
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, 'PK\x03\x04fake', { mode: 0o600 });
    fs.mkdirSync(path.dirname(tmpPdf), { recursive: true });
    fs.writeFileSync(tmpPdf, '%PDF-1.4 fake', { mode: 0o600 });
    setApplicationTailored(h.db, a.id, {
      tailored_cv_path: tmpFile,
      tailored_cover_letter_path: null,
      tailored_cv_pdf_path: tmpPdf,
      tailored_cover_letter_pdf_path: null,
      tailored_at: new Date().toISOString(),
      new_status: 'ready_for_manual_apply',
    });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/applications/${a.id}/tailored-cv`,
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
  });
});

describe('POST /api/applications/:id/mark-applied', () => {
  it('flips status to applied_manually, stores notes, auto-resolves the alert', async () => {
    const job = seedManualJob();
    const a = insertApplication(h.db, {
      job_id: job.id,
      cv_id: cvId,
      apply_method: 'manual',
      status: 'ready_for_manual_apply',
    });
    const alert = insertAlert(h.db, {
      kind: 'ready_for_manual_apply',
      severity: 'action_required',
      title: 't',
      description: 'd',
      application_id: a.id,
      payload: {},
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/applications/${a.id}/mark-applied`,
      headers: auth(h.token),
      payload: { notes: 'applied via greenhouse' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('applied_manually');
    expect(body.applied_manually_notes).toBe('applied via greenhouse');

    const refreshed = listAlerts(h.db, { application_id: a.id });
    expect(refreshed.find((al) => al.id === alert.id)?.status).toBe('resolved');
  });
});

describe('POST /api/applications/:id/skip', () => {
  it('flips status to skipped, stores reason', async () => {
    const job = seedManualJob();
    const a = insertApplication(h.db, {
      job_id: job.id,
      cv_id: cvId,
      apply_method: 'manual',
      status: 'ready_for_manual_apply',
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/applications/${a.id}/skip`,
      headers: auth(h.token),
      payload: { reason: 'too junior' },
    });
    const body = res.json();
    expect(body.status).toBe('skipped');
    expect(body.failure_reason).toBe('too junior');
  });
});
