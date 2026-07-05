import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { ScoreMessages, StructuredScorer } from '@vina/orchestrator';
import { ScoreSchema } from '@vina/orchestrator';
import { NotFoundError } from '@vina/shared';
import { findJobById, insertJob } from '../../../src/db/repositories/jobs.js';
import { insertCv } from '../../../src/db/repositories/cvs.js';
import { insertProfile } from '../../../src/db/repositories/profile.js';
import { upsertSearchPreferences } from '../../../src/db/repositories/search-preferences.js';
import { createEventBus } from '../../../src/events/bus.js';
import { createScoreHandler } from '../../../src/queue/handlers/score.js';
import { freshTestDb } from '../../db/helpers.js';

function fakeScorer(score: number, justification = 'fake'): StructuredScorer {
  return {
    withStructuredOutput: () => ({
      invoke: async (_messages: ScoreMessages) => {
        ScoreSchema.parse({ score, justification }); // sanity
        return { score, justification };
      },
    }) as never,
  };
}

function capturingScorer(captured: { messages: ScoreMessages | null }): StructuredScorer {
  return {
    withStructuredOutput: () => ({
      invoke: async (messages: ScoreMessages) => {
        captured.messages = messages;
        return { score: 80, justification: 'ok' };
      },
    }) as never,
  };
}

let db: DatabaseType;
beforeEach(() => {
  db = freshTestDb();
  insertProfile(db, { full_name: 'Ada Lovelace', email: 'ada@x.com', bio: 'Engineer' });
  upsertSearchPreferences(db, {
    description: 'TS backend',
    keywords: ['typescript'],
    locations: ['Remote'],
    work_models: ['remote'],
    seniority: ['senior'],
    excluded_companies: [],
  });
});
afterEach(() => db.close());

describe('score handler', () => {
  it('writes match_score + justification and transitions status to scored', async () => {
    const job = insertJob(db, {
      site_id: 'linkedin',
      external_id: 'ext1',
      url: 'https://x',
      apply_method: 'auto',
      title: 'Senior TS Engineer',
      company: 'Acme',
      description: 'TS backend role',
    });

    const handler = createScoreHandler({
      db,
      bus: createEventBus(),
      buildModel: async () => fakeScorer(82, 'Strong title and skill match'),
    });

    await handler({ job_id: job.id });

    const fresh = findJobById(db, job.id);
    expect(fresh?.match_score).toBe(82);
    expect(fresh?.match_justification).toBe('Strong title and skill match');
    expect(fresh?.status).toBe('scored');
  });

  it('clamps + rounds out-of-range model output before persisting', async () => {
    const job = insertJob(db, {
      site_id: 'linkedin',
      external_id: 'ext2',
      url: 'https://x',
      apply_method: 'auto',
      title: 'Junior dev',
      company: 'Acme',
      description: 'Junior',
    });

    const handler = createScoreHandler({
      db,
      bus: createEventBus(),
      buildModel: async () => fakeScorer(150, 'over'),
    });

    await handler({ job_id: job.id });
    expect(findJobById(db, job.id)?.match_score).toBe(100);
  });

  it('throws if the job no longer exists', async () => {
    const handler = createScoreHandler({
      db,
      bus: createEventBus(),
      buildModel: async () => fakeScorer(50),
    });
    await expect(handler({ job_id: 'missing' })).rejects.toThrow(NotFoundError);
  });

  it('does not clobber status when the user has already skipped the job mid-score', async () => {
    const job = insertJob(db, {
      site_id: 'linkedin',
      external_id: 'race-1',
      url: 'https://x',
      apply_method: 'auto',
      title: 'Engineer',
      company: 'Acme',
      description: 'TS',
    });
    // Simulate the user clicking Skip between enqueue and run.
    const { updateJobStatus } = await import('../../../src/db/repositories/jobs.js');
    updateJobStatus(db, job.id, 'skipped');

    const handler = createScoreHandler({
      db,
      bus: createEventBus(),
      buildModel: async () => fakeScorer(82, 'fine'),
    });
    await handler({ job_id: job.id });

    const fresh = findJobById(db, job.id);
    // Score and justification persist so the alternate filters still see it,
    // but status remains 'skipped' — the user's triage decision wins.
    expect(fresh?.match_score).toBe(82);
    expect(fresh?.status).toBe('skipped');
  });

  it('folds the default CV extracted_text into the prompt as the CV section', async () => {
    insertCv(db, {
      label: 'main',
      original_filename: 'cv.pdf',
      mime_type: 'application/pdf',
      file_path: '/tmp/cv.pdf',
      extracted_text: 'CV-FINGERPRINT-12345',
      is_default: true,
    });
    const job = insertJob(db, {
      site_id: 'linkedin',
      external_id: 'ext3',
      url: 'https://x',
      apply_method: 'auto',
      title: 'Senior Engineer',
      company: 'Acme',
      description: 'TS APIs.',
    });

    const captured: { messages: ScoreMessages | null } = { messages: null };
    const handler = createScoreHandler({
      db,
      bus: createEventBus(),
      buildModel: async () => capturingScorer(captured),
    });
    await handler({ job_id: job.id });

    const userMsg = captured.messages?.find((m) => m.role === 'user');
    expect(String(userMsg?.content)).toContain('## CV');
    expect(String(userMsg?.content)).toContain('CV-FINGERPRINT-12345');
  });

  it('omits the CV section when no default CV is set', async () => {
    insertCv(db, {
      label: 'main',
      original_filename: 'cv.pdf',
      mime_type: 'application/pdf',
      file_path: '/tmp/cv.pdf',
      extracted_text: 'NOT-DEFAULT',
      is_default: false,
    });
    // insertCv auto-promotes the first CV when no default exists; demote it
    // here to construct the "no default CV" state this test is exercising.
    db.exec(`UPDATE cvs SET is_default = 0`);
    const job = insertJob(db, {
      site_id: 'linkedin',
      external_id: 'ext4',
      url: 'https://x',
      apply_method: 'auto',
      title: 'Senior Engineer',
      company: 'Acme',
      description: 'TS APIs.',
    });

    const captured: { messages: ScoreMessages | null } = { messages: null };
    const handler = createScoreHandler({
      db,
      bus: createEventBus(),
      buildModel: async () => capturingScorer(captured),
    });
    await handler({ job_id: job.id });

    const userMsg = captured.messages?.find((m) => m.role === 'user');
    expect(String(userMsg?.content)).not.toContain('## CV');
    expect(String(userMsg?.content)).not.toContain('NOT-DEFAULT');
  });
});

describe('score handler — autonomous-mode auto-enqueue', () => {
  function seedManualJob(externalId: string, applyMethod: 'manual' | 'auto' = 'manual') {
    return insertJob(db, {
      site_id: 'linkedin',
      external_id: externalId,
      url: 'https://x',
      apply_method: applyMethod,
      title: 'T',
      company: 'C',
      description: 'd',
      external_apply_url: 'https://greenhouse.io/apply',
    });
  }

  function autonomousHandler(scoreResult: number) {
    return createScoreHandler({
      db,
      bus: createEventBus(),
      buildModel: async () => fakeScorer(scoreResult, 'ok'),
    });
  }

  it('enqueues prepare_manual_apply when mode=autonomous + score>=threshold + apply_method=manual', async () => {
    insertCv(db, {
      label: 'main',
      original_filename: 'cv.pdf',
      mime_type: 'application/pdf',
      file_path: '/tmp/cv.pdf',
      extracted_text: 'x',
      is_default: true,
    });
    const { updateSettings } = await import('../../../src/db/repositories/settings.js');
    updateSettings(db, { easy_apply_mode: 'autonomous' });
    const { upsertSearchPreferences } = await import(
      '../../../src/db/repositories/search-preferences.js'
    );
    upsertSearchPreferences(db, { score_threshold: 70 });

    const job = seedManualJob('auto-1');
    await autonomousHandler(82)({ job_id: job.id });

    const { listPending } = await import('../../../src/db/repositories/task-queue.js');
    const pending = listPending(db);
    expect(pending.find((t) => t.kind === 'prepare_manual_apply')).toBeDefined();
  });

  it('does NOT enqueue when easy_apply_mode=manual', async () => {
    insertCv(db, {
      label: 'main',
      original_filename: 'cv.pdf',
      mime_type: 'application/pdf',
      file_path: '/tmp/cv.pdf',
      extracted_text: 'x',
      is_default: true,
    });
    const { updateSettings } = await import('../../../src/db/repositories/settings.js');
    updateSettings(db, { easy_apply_mode: 'manual' });
    const job = seedManualJob('auto-2');
    await autonomousHandler(82)({ job_id: job.id });
    const { listPending } = await import('../../../src/db/repositories/task-queue.js');
    expect(listPending(db).find((t) => t.kind === 'prepare_manual_apply')).toBeUndefined();
  });

  it('does NOT enqueue when score < threshold', async () => {
    insertCv(db, {
      label: 'main',
      original_filename: 'cv.pdf',
      mime_type: 'application/pdf',
      file_path: '/tmp/cv.pdf',
      extracted_text: 'x',
      is_default: true,
    });
    const { updateSettings } = await import('../../../src/db/repositories/settings.js');
    updateSettings(db, { easy_apply_mode: 'autonomous' });
    const { upsertSearchPreferences } = await import(
      '../../../src/db/repositories/search-preferences.js'
    );
    upsertSearchPreferences(db, { score_threshold: 90 });
    const job = seedManualJob('auto-3');
    await autonomousHandler(60)({ job_id: job.id });
    const { listPending } = await import('../../../src/db/repositories/task-queue.js');
    expect(listPending(db).find((t) => t.kind === 'prepare_manual_apply')).toBeUndefined();
  });

  it('enqueues an apply task when autonomous + apply_method=auto + gate allows', async () => {
    insertCv(db, {
      label: 'main',
      original_filename: 'cv.pdf',
      mime_type: 'application/pdf',
      file_path: '/tmp/cv.pdf',
      extracted_text: 'x',
      is_default: true,
    });
    const { updateSettings } = await import('../../../src/db/repositories/settings.js');
    updateSettings(db, { easy_apply_mode: 'autonomous' });
    const { upsertSearchPreferences } = await import(
      '../../../src/db/repositories/search-preferences.js'
    );
    upsertSearchPreferences(db, { score_threshold: 70 });
    const job = seedManualJob('auto-4', 'auto');

    await autonomousHandler(82)({ job_id: job.id });

    const { listPending } = await import('../../../src/db/repositories/task-queue.js');
    const pending = listPending(db);
    expect(pending.find((t) => t.kind === 'apply')).toBeDefined();
    // Manual-apply enqueuer must not have fired for an auto-apply job.
    expect(pending.find((t) => t.kind === 'prepare_manual_apply')).toBeUndefined();
  });

  it('does NOT enqueue an apply task when the gate blocks (circuit breaker tripped)', async () => {
    insertCv(db, {
      label: 'main',
      original_filename: 'cv.pdf',
      mime_type: 'application/pdf',
      file_path: '/tmp/cv.pdf',
      extracted_text: 'x',
      is_default: true,
    });
    const { updateSettings } = await import('../../../src/db/repositories/settings.js');
    updateSettings(db, {
      easy_apply_mode: 'autonomous',
      apply_consecutive_failure_limit: 5,
    });
    const { upsertSearchPreferences } = await import(
      '../../../src/db/repositories/search-preferences.js'
    );
    upsertSearchPreferences(db, { score_threshold: 70 });
    // Trip the breaker by pushing consecutive_failures past the limit.
    db.prepare(`UPDATE apply_rate_limit SET consecutive_failures = 99`).run();

    const job = seedManualJob('auto-5', 'auto');
    await autonomousHandler(95)({ job_id: job.id });

    const { listPending } = await import('../../../src/db/repositories/task-queue.js');
    expect(listPending(db).find((t) => t.kind === 'apply')).toBeUndefined();
  });
});
