import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@vina/shared';
import { migrate } from '../../src/db/migrate.js';
import { checkEasyApplyGate, type GateDecision } from '../../src/services/easy-apply-gate.js';
import { insertJob, updateJobScore } from '../../src/db/repositories/jobs.js';
import { insertCv } from '../../src/db/repositories/cvs.js';
import { insertApplication } from '../../src/db/repositories/applications.js';
import { updateSettings } from '../../src/db/repositories/settings.js';

/** Narrow the discriminated union to the block variant for assertion convenience. */
function asBlock(r: GateDecision) {
  if (r.decision !== 'block') throw new Error(`Expected block, got ${r.decision}`);
  return r;
}

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function makeJob(
  db: Database.Database,
  opts: { posted_at?: string | null; score?: number | null; method?: 'auto' | 'manual' } = {},
) {
  const job = insertJob(db, {
    site_id: 'linkedin',
    external_id: newId(),
    url: 'https://example.test/job',
    title: 'Engineer',
    company: 'Acme',
    location: 'Remote',
    description: 'desc',
    posted_at: opts.posted_at ?? '2026-06-20T00:00:00.000Z',
    apply_method: opts.method ?? 'auto',
    external_apply_url: null,
    original_source: null,
    salary_text: null,
    status: 'scored',
  });
  // insertJob always sets match_score to NULL — set via the dedicated updater
  const score = opts.score ?? 80;
  return updateJobScore(db, job.id, score, null)!;
}

describe('checkEasyApplyGate', () => {
  let db: Database.Database;
  const NOW = '2026-06-21T12:00:00.000Z';
  const TODAY = '2026-06-21';

  beforeEach(() => {
    db = freshDb();
  });

  it('allow when all gates pass', () => {
    const job = makeJob(db);
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('allow');
  });

  it('blocks when job is not found', () => {
    const r = checkEasyApplyGate(db, { jobId: 'no-such-job', nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('block');
    expect(asBlock(r).reason).toBe('job_not_found');
  });

  it('blocks when apply_method is not auto', () => {
    const job = makeJob(db, { method: 'manual' });
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('block');
    expect(asBlock(r).reason).toBe('wrong_apply_method');
  });

  it('blocks when score below threshold', () => {
    db.prepare(`UPDATE search_preferences SET score_threshold = 90`).run();
    const job = makeJob(db, { score: 50 });
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('block');
    expect(asBlock(r).reason).toBe('below_threshold');
  });

  it('blocks when posted_at is older than the configured age cap', () => {
    updateSettings(db, { apply_listing_max_age_days: 7 });
    const job = makeJob(db, { posted_at: '2026-06-01T00:00:00.000Z' });
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('block');
    expect(asBlock(r).reason).toBe('listing_stale');
  });

  it('blocks when daily cap already met', () => {
    updateSettings(db, { apply_daily_cap: 3 });
    db.prepare(`UPDATE apply_rate_limit SET successful_today = 3, day_bucket = ?`).run(TODAY);
    const job = makeJob(db);
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('block');
    expect(asBlock(r).reason).toBe('daily_cap_reached');
  });

  it('blocks on velocity throttle when last_attempt is recent', () => {
    updateSettings(db, { apply_min_interval_seconds: 600 });
    db.prepare(`UPDATE apply_rate_limit SET last_attempt_at = ?, day_bucket = ?`).run(
      '2026-06-21T11:55:00.000Z',
      TODAY,
    );
    const job = makeJob(db);
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('block');
    expect(asBlock(r).reason).toBe('velocity_throttle');
  });

  it('blocks when consecutive failure limit hit (circuit breaker)', () => {
    updateSettings(db, { apply_consecutive_failure_limit: 5 });
    db.prepare(`UPDATE apply_rate_limit SET consecutive_failures = 5`).run();
    const job = makeJob(db);
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('block');
    expect(asBlock(r).reason).toBe('circuit_breaker_tripped');
  });

  it('blocks when an active apply task already exists for the job (idempotency)', () => {
    const job = makeJob(db);
    const cv = insertCv(db, {
      label: 'Default',
      original_filename: 'cv.pdf',
      mime_type: 'application/pdf',
      file_path: '/tmp/cv.pdf',
    });
    const app = insertApplication(db, {
      job_id: job.id,
      cv_id: cv.id,
      apply_method: 'auto',
      status: 'queued',
    });
    const now = NOW;
    db.prepare(`
      INSERT INTO task_queue (id, kind, payload, status, attempts, max_attempts, priority, next_attempt_at, created_at)
      VALUES (?, 'apply', ?, 'pending', 0, 3, 5, ?, ?)
    `).run(newId(), JSON.stringify({ application_id: app.id }), now, now);
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('block');
    expect(asBlock(r).reason).toBe('apply_task_in_flight');
  });

  it('returns dry_run when dry-run setting is true (but still allow)', () => {
    updateSettings(db, { autonomous_apply_dry_run: true });
    const job = makeJob(db);
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('dry_run');
  });
});
