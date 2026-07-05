import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobStatus } from '@vina/shared';
import {
  findJobById,
  insertJob,
  updateJobScore,
  updateJobStatus,
} from '../../src/db/repositories/jobs.js';
import { insertCv } from '../../src/db/repositories/cvs.js';
import { auth, buildTestApp, type TestAppHandle } from './helpers.js';

let h: TestAppHandle;
beforeEach(async () => {
  h = await buildTestApp();
});
afterEach(async () => {
  await h.cleanup();
});

function seedJob(
  opts: {
    score?: number;
    status?: JobStatus;
    title?: string;
    site_id?: string;
    apply_method?: 'auto' | 'manual';
  } = {},
) {
  const job = insertJob(h.db, {
    site_id: opts.site_id ?? 'linkedin',
    external_id: `ext-${Math.random().toString(36).slice(2)}`,
    url: 'https://linkedin.com/x',
    apply_method: opts.apply_method ?? 'auto',
    title: opts.title ?? 'Engineer',
    company: 'Acme',
    description: 'desc',
  });
  if (opts.score !== undefined) updateJobScore(h.db, job.id, opts.score, 'reason');
  if (opts.status) updateJobStatus(h.db, job.id, opts.status);
  return job;
}

describe('GET /api/jobs', () => {
  it('filters by status and min_score', async () => {
    seedJob({ score: 50, status: 'scored', title: 'Lo' });
    seedJob({ score: 80, status: 'scored', title: 'Hi' });
    seedJob({ status: 'skipped' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/jobs?status=scored&min_score=70',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { title: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.title).toBe('Hi');
  });

  it('paginates', async () => {
    for (let i = 0; i < 5; i++) seedJob({ score: 70 + i, status: 'scored' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/jobs?status=scored&page=2&page_size=2',
      headers: auth(h.token),
    });
    expect(res.json().items).toHaveLength(2);
    expect(res.json().page).toBe(2);
  });

  it('returns a filter-aware total independent of page size', async () => {
    for (let i = 0; i < 5; i++) seedJob({ score: 80, status: 'scored' });
    seedJob({ score: 10, status: 'scored' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/jobs?status=scored&min_score=70&page=1&page_size=2',
      headers: auth(h.token),
    });
    expect(res.json().items).toHaveLength(2);
    expect(res.json().total).toBe(5);
  });

  it('filters by apply_method and reflects it in total', async () => {
    seedJob({ score: 80, status: 'scored', apply_method: 'auto' });
    seedJob({ score: 81, status: 'scored', apply_method: 'manual' });
    seedJob({ score: 82, status: 'scored', apply_method: 'manual' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/jobs?status=scored&apply_method=auto',
      headers: auth(h.token),
    });
    expect(res.json().items).toHaveLength(1);
    expect(res.json().total).toBe(1);
  });

  it('filters by site_id', async () => {
    seedJob({ score: 80, status: 'scored', site_id: 'linkedin' });
    seedJob({ score: 81, status: 'scored', site_id: 'google' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/jobs?status=scored&site_id=google',
      headers: auth(h.token),
    });
    expect(res.json().items).toHaveLength(1);
    expect(res.json().total).toBe(1);
  });

  it('sort=date orders newest-first regardless of score', async () => {
    // seedJob inserts sequentially — discovered_at is monotonically increasing,
    // so the LAST seeded job is the newest. Give it the LOWEST score so the
    // two sort orders disagree.
    seedJob({ score: 90, status: 'scored', title: 'Old high' });
    seedJob({ score: 50, status: 'scored', title: 'New low' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/jobs?status=scored&sort=date',
      headers: auth(h.token),
    });
    const titles = (res.json().items as { title: string }[]).map((j) => j.title);
    expect(titles[0]).toBe('New low');
    const byScore = await h.app.inject({
      method: 'GET',
      url: '/api/jobs?status=scored',
      headers: auth(h.token),
    });
    expect((byScore.json().items as { title: string }[])[0]!.title).toBe('Old high');
  });

  it('rejects unknown sort and site_id values', async () => {
    for (const url of ['/api/jobs?sort=title', '/api/jobs?site_id=monster']) {
      const res = await h.app.inject({ method: 'GET', url, headers: auth(h.token) });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('GET /api/jobs/:id', () => {
  it('returns the row', async () => {
    const job = seedJob({});
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}`,
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(job.id);
  });
  it('404s on missing id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/jobs/missing',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('job status flips', () => {
  it('POST /api/jobs/:id/applied flips to applied_manually', async () => {
    const job = seedJob({ status: 'scored' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/applied`,
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    expect(findJobById(h.db, job.id)?.status).toBe('applied_manually');
  });

  it('POST /api/jobs/:id/skip flips to skipped', async () => {
    const job = seedJob({ status: 'scored' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/skip`,
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    expect(findJobById(h.db, job.id)?.status).toBe('skipped');
  });

  it('POST /api/jobs/:id/scored flips back to scored (undo path)', async () => {
    const job = seedJob({ status: 'skipped' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/scored`,
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    expect(findJobById(h.db, job.id)?.status).toBe('scored');
  });

  it('flip endpoints 404 on missing id', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/missing/applied',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/jobs/:id/apply', () => {
  function seedDefaultCv(): void {
    insertCv(h.db, {
      label: 'Default',
      original_filename: 'cv.pdf',
      mime_type: 'application/pdf',
      file_path: '/tmp/cv.pdf',
      is_default: true,
    });
  }

  it('enqueues an apply task for an auto-apply job', async () => {
    seedDefaultCv();
    const job = seedJob({ score: 90, status: 'scored' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/apply`,
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { application_id: string; deduped: boolean };
    expect(body.deduped).toBe(false);
    const tasks = h.db
      .prepare(`SELECT * FROM task_queue WHERE kind = 'apply'`)
      .all();
    expect(tasks).toHaveLength(1);
  });

  it('returns 409 when the job is manual-apply', async () => {
    seedDefaultCv();
    const job = insertJob(h.db, {
      site_id: 'linkedin',
      external_id: 'man-x',
      url: 'https://linkedin.com/man-x',
      apply_method: 'manual',
      title: 'Manual',
      company: 'Acme',
      description: 'External ATS',
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/apply`,
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 404 when the job does not exist', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/no-such-id/apply',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(404);
  });
});
