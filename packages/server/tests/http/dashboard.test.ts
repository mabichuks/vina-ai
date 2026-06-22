import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertJob, updateJobScore } from '../../src/db/repositories/jobs.js';
import {
  insertApplication,
  updateApplicationStatus,
} from '../../src/db/repositories/applications.js';
import { insertCv } from '../../src/db/repositories/cvs.js';
import { updateSettings } from '../../src/db/repositories/settings.js';
import { auth, buildTestApp, type TestAppHandle } from './helpers.js';

let h: TestAppHandle;

beforeEach(async () => {
  h = await buildTestApp();
});
afterEach(() => h.cleanup());

function todayBucket(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe('GET /api/dashboard/easy-apply', () => {
  it('returns the rate-limit snapshot and recent auto-apply applications', async () => {
    const cv = insertCv(h.db, {
      label: 'Default',
      original_filename: 'cv.pdf',
      mime_type: 'application/pdf',
      file_path: '/tmp/cv.pdf',
      is_default: true,
    });
    const job = insertJob(h.db, {
      site_id: 'linkedin',
      external_id: 'auto-1',
      url: 'https://x',
      apply_method: 'auto',
      title: 'Senior Engineer',
      company: 'Acme',
      description: 'desc',
    });
    updateJobScore(h.db, job.id, 92, null);
    const app = insertApplication(h.db, {
      job_id: job.id,
      cv_id: cv.id,
      apply_method: 'auto',
      status: 'queued',
    });
    const now = new Date().toISOString();
    updateApplicationStatus(h.db, app.id, 'submitted', { submitted_at: now });
    h.db
      .prepare(
        `UPDATE apply_rate_limit SET successful_today = 2, day_bucket = ?, last_success_at = ?`,
      )
      .run(todayBucket(), now);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/dashboard/easy-apply',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      submitted_today: number;
      circuit_breaker_tripped: boolean;
      easy_apply_mode: string;
      daily_cap: number;
      recent: Array<{ application_id: string; title: string }>;
    };
    expect(body.submitted_today).toBe(2);
    expect(body.circuit_breaker_tripped).toBe(false);
    expect(body.easy_apply_mode).toBe('manual');
    expect(body.daily_cap).toBeGreaterThan(0);
    expect(body.recent.find((r) => r.application_id === app.id)?.title).toBe(
      'Senior Engineer',
    );
  });

  it('reports circuit_breaker_tripped when consecutive failures reach the limit', async () => {
    updateSettings(h.db, { apply_consecutive_failure_limit: 3 });
    h.db
      .prepare(`UPDATE apply_rate_limit SET consecutive_failures = 5`)
      .run();

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/dashboard/easy-apply',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      circuit_breaker_tripped: boolean;
      consecutive_failures: number;
    };
    expect(body.circuit_breaker_tripped).toBe(true);
    expect(body.consecutive_failures).toBe(5);
  });
});
