import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobStatus } from '@vina/shared';
import {
  findJobById,
  insertJob,
  updateJobScore,
  updateJobStatus,
} from '../../src/db/repositories/jobs.js';
import { auth, buildTestApp, type TestAppHandle } from './helpers.js';

let h: TestAppHandle;
beforeEach(async () => {
  h = await buildTestApp();
});
afterEach(async () => {
  await h.cleanup();
});

function seedJob(opts: { score?: number; status?: JobStatus; title?: string } = {}) {
  const job = insertJob(h.db, {
    site_id: 'linkedin',
    external_id: `ext-${Math.random().toString(36).slice(2)}`,
    url: 'https://linkedin.com/x',
    apply_method: 'auto',
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
