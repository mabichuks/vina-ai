import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { NotFoundError, ValidationError } from '@vina/shared';
import type { VinaServices } from '@vina/opencode-plugin';
import { freshTestDb } from '../db/helpers.js';
import { createEventBus, type EventBus } from '../../src/events/bus.js';
import { createVinaServices, type VinaServicesDeps } from '../../src/opencode/services.js';
import { insertProfile } from '../../src/db/repositories/profile.js';
import { insertCv } from '../../src/db/repositories/cvs.js';
import { insertJob, updateJobScore, findJobById } from '../../src/db/repositories/jobs.js';
import { insertApplication, findApplicationById } from '../../src/db/repositories/applications.js';
import { listEvents } from '../../src/db/repositories/application-events.js';
import { listAlerts } from '../../src/db/repositories/alerts.js';
import { upsertAnswer } from '../../src/db/repositories/profile-answers.js';
import { getRateLimit } from '../../src/db/repositories/apply-rate-limit.js';
import { updateSettings } from '../../src/db/repositories/settings.js';

let db: DatabaseType;
let bus: EventBus;
let dataDir: string;

beforeEach(() => {
  db = freshTestDb();
  bus = createEventBus();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-opencode-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function fakeModel(outputs: unknown[]): BaseChatModel {
  let i = 0;
  return {
    withStructuredOutput: () => ({
      invoke: async () => outputs[i++],
    }),
  } as unknown as BaseChatModel;
}

function makeServices(overrides: Partial<VinaServicesDeps> = {}): VinaServices {
  return createVinaServices({
    db,
    bus,
    dataDir,
    buildModel: async () => fakeModel([]),
    ...overrides,
  });
}

function seedProfile() {
  insertProfile(db, { full_name: 'Ada Lovelace', email: 'ada@x.com', bio: 'Engineer' });
}

function seedCv(label = 'main', extractedText = 'CV text') {
  return insertCv(db, {
    label,
    original_filename: 'cv.pdf',
    mime_type: 'application/pdf',
    file_path: '/tmp/cv.pdf',
    extracted_text: extractedText,
    is_default: true,
  });
}

function seedJob(externalId: string, applyMethod: 'auto' | 'manual' = 'manual') {
  return insertJob(db, {
    site_id: 'linkedin',
    external_id: externalId,
    url: 'https://linkedin.com/jobs/view/x',
    apply_method: applyMethod,
    title: 'Senior TS Engineer',
    company: 'Acme',
    description: 'TS APIs.',
    external_apply_url: 'https://greenhouse.io/apply/x',
  });
}

function seedApp(jobId: string, cvId: string, applyMethod: 'auto' | 'manual' = 'manual') {
  return insertApplication(db, {
    job_id: jobId,
    cv_id: cvId,
    apply_method: applyMethod,
    status: 'queued',
  });
}

// ---------------------------------------------------------------------------
// profile_read
// ---------------------------------------------------------------------------
describe('vina_profile_read', () => {
  it('returns the profile, CV list and answers as a slice', async () => {
    seedProfile();
    const cv = seedCv();
    upsertAnswer(db, 'years', 'Years of experience', '7');
    const services = makeServices();

    const out = await services.profileRead({});
    expect(out.profile).toMatchObject({ full_name: 'Ada Lovelace', email: 'ada@x.com' });
    expect(out.cvs).toEqual([{ id: cv.id, label: 'main', is_default: true }]);
    expect(out.answers).toEqual([{ key: 'years', label: 'Years of experience', value: '7' }]);
  });

  it('returns null profile and empty lists when nothing is configured', async () => {
    const out = await makeServices().profileRead({});
    expect(out.profile).toBeNull();
    expect(out.cvs).toEqual([]);
    expect(out.answers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// search_jobs
// ---------------------------------------------------------------------------
describe('vina_search_jobs', () => {
  async function* fakeSerpapi(): AsyncIterable<
    import('../../src/services/serpapi-service.js').GoogleJobsListing
  > {
    yield {
      external_id: 'g1',
      title: 'Engineer',
      company: 'Foo',
      location: 'Remote',
      description: 'd',
      via: 'LinkedIn',
      apply_url: 'https://foo.com/jobs/1',
      salary_text: null,
    };
  }

  it('inserts and dedupes Google Jobs listings (api-kind)', async () => {
    const { _resetVaultForTests, initVault } = await import('../../src/secrets/vault.js');
    const { setSerpApiKey } = await import('../../src/services/settings-service.js');
    process.env['VINA_DISABLE_KEYTAR'] = '1';
    _resetVaultForTests();
    await initVault(dataDir);
    delete process.env['VINA_DISABLE_KEYTAR'];
    setSerpApiKey(db, 'test-key');

    const services = makeServices({ serpapiSearch: () => fakeSerpapi() });
    const out = await services.searchJobs({ sources: ['google'], query: 'engineer' });

    expect(out.added).toBe(1);
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]).toMatchObject({ title: 'Engineer', company: 'Foo' });
    // dedupe: a second search of the same listing inserts no new row
    const again = await services.searchJobs({ sources: ['google'], query: 'engineer' });
    expect(again.added).toBe(1);
    expect(again.jobs[0]!.id).toBe(out.jobs[0]!.id);
  });

  it('rejects a browser-kind source with a clear message (not yet wired)', async () => {
    await expect(makeServices().searchJobs({ sources: ['linkedin'], query: 'x' })).rejects.toThrow(
      /not yet available/,
    );
  });

  it('rejects when the SerpAPI key is missing', async () => {
    await expect(makeServices().searchJobs({ sources: ['google'], query: 'x' })).rejects.toThrow(
      /SerpAPI key not configured/,
    );
  });
});

// ---------------------------------------------------------------------------
// jobs_list
// ---------------------------------------------------------------------------
describe('vina_jobs_list', () => {
  it('returns a job slice with a total count', async () => {
    seedProfile();
    seedJob('j1');
    seedJob('j2');
    const out = await makeServices().jobsList({});
    expect(out.total).toBe(2);
    expect(out.jobs).toHaveLength(2);
    expect(out.jobs[0]).toMatchObject({ title: 'Senior TS Engineer' });
  });

  it('returns an empty list when no jobs exist', async () => {
    const out = await makeServices().jobsList({});
    expect(out.total).toBe(0);
    expect(out.jobs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// job_get
// ---------------------------------------------------------------------------
describe('vina_job_get', () => {
  it('returns the job slice and the active application', async () => {
    seedProfile();
    const cv = seedCv();
    const job = seedJob('j1');
    const app = seedApp(job.id, cv.id);
    const out = await makeServices().jobGet({ jobId: job.id });
    expect(out.job.id).toBe(job.id);
    expect(out.application).toMatchObject({ id: app.id, status: 'queued' });
  });

  it('rejects an unknown job id with NotFoundError', async () => {
    await expect(makeServices().jobGet({ jobId: 'missing' })).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// score_job
// ---------------------------------------------------------------------------
describe('vina_score_job', () => {
  it('persists the score and transitions status to scored', async () => {
    seedProfile();
    const job = seedJob('j1');
    const services = makeServices({
      buildModel: async () => fakeModel([{ score: 82, justification: 'strong' }]),
    });
    const out = await services.scoreJob({ jobId: job.id });
    expect(out.score).toBe(82);
    expect(out.status).toBe('scored');
    const { findJobById } = await import('../../src/db/repositories/jobs.js');
    expect(findJobById(db, job.id)?.match_score).toBe(82);
  });

  it('rejects an unknown job with NotFoundError', async () => {
    seedProfile();
    await expect(makeServices().scoreJob({ jobId: 'missing' })).rejects.toThrow(NotFoundError);
  });

  it('rejects a missing profile with ConflictError', async () => {
    const job = seedJob('j1');
    await expect(makeServices().scoreJob({ jobId: job.id })).rejects.toThrow(
      /Profile not configured/,
    );
  });
});

// ---------------------------------------------------------------------------
// materials_save
// ---------------------------------------------------------------------------
describe('vina_materials_save', () => {
  function seedManualApp() {
    seedProfile();
    const cv = seedCv('main', 'Original CV text');
    const job = seedJob('j1', 'manual');
    const app = seedApp(job.id, cv.id, 'manual');
    return { cvId: cv.id, jobId: job.id, appId: app.id };
  }

  it('renders materials, writes the event, and marks ready_for_manual_apply', async () => {
    const { appId } = seedManualApp();
    const services = makeServices({
      buildModel: async () => fakeModel([{ summary: 's', bullets: [], skills: [] }]),
    });

    const out = await services.materialsSave({
      applicationId: appId,
      cvMarkdown: 'Tailored CV',
      formAnswers: { years: '7' },
    });

    expect(out.status).toBe('ready_for_manual_apply');
    expect(out.tailored_cv_path).toMatch(/\.docx$/);
    const after = findApplicationById(db, appId)!;
    expect(after.tailored_cv_path).toBeTruthy();
    expect(after.status).toBe('ready_for_manual_apply');
    // formAnswers persisted to form_state
    expect(after.form_state).toBe(JSON.stringify({ years: '7' }));
    // event written in the same transaction
    const events = listEvents(db, appId);
    expect(events.some((e) => e.kind === 'cv_tailored')).toBe(true);
  });

  it('is idempotent on (applicationId, contentHash)', async () => {
    const { appId } = seedManualApp();
    const services = makeServices({
      buildModel: async () => fakeModel([{ summary: 's', bullets: [], skills: [] }]),
    });
    await services.materialsSave({ applicationId: appId, cvMarkdown: 'Same prose' });
    const firstPath = findApplicationById(db, appId)!.tailored_cv_path;
    const eventCount = listEvents(db, appId).filter((e) => e.kind === 'cv_tailored').length;

    await services.materialsSave({ applicationId: appId, cvMarkdown: 'Same prose' });

    expect(findApplicationById(db, appId)!.tailored_cv_path).toBe(firstPath);
    expect(listEvents(db, appId).filter((e) => e.kind === 'cv_tailored')).toHaveLength(eventCount);
  });

  it('rejects an unknown application with NotFoundError', async () => {
    seedProfile();
    await expect(
      makeServices().materialsSave({ applicationId: 'missing', cvMarkdown: 'x' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('rejects a missing profile with ConflictError', async () => {
    const cv = seedCv();
    const job = seedJob('j1', 'manual');
    const app = seedApp(job.id, cv.id, 'manual');
    await expect(
      makeServices().materialsSave({ applicationId: app.id, cvMarkdown: 'x' }),
    ).rejects.toThrow(/Profile not configured/);
  });
});

// ---------------------------------------------------------------------------
// materials_read
// ---------------------------------------------------------------------------
describe('vina_materials_read', () => {
  function seedManualApp() {
    seedProfile();
    const cv = seedCv('main', 'Original CV text');
    const job = seedJob('j1', 'manual');
    const app = seedApp(job.id, cv.id, 'manual');
    return { appId: app.id };
  }

  it('returns the markdown, paths, and form answers after a save', async () => {
    const { appId } = seedManualApp();
    const services = makeServices();
    await services.materialsSave({
      applicationId: appId,
      cvMarkdown:
        '## Summary\nTailored summary\n\n## Experience\n### Acme\n- Built APIs.\n\n## Skills\n- TypeScript',
      coverLetterMarkdown: 'Dear team,\n\nI am a fit.\n\nSincerely, Ada',
      formAnswers: { years: '7' },
    });

    const out = await services.materialsRead({ applicationId: appId });
    expect(out.cvMarkdown).toContain('Tailored summary');
    expect(out.coverLetterMarkdown).toContain('Dear team,');
    expect(out.tailored_cv_path).toMatch(/\.docx$/);
    expect(out.tailored_cover_letter_path).toMatch(/\.docx$/);
    expect(out.formAnswers).toEqual({ years: '7' });
  });

  it('returns null markdown for an application that was never tailored', async () => {
    const { appId } = seedManualApp();
    const out = await makeServices().materialsRead({ applicationId: appId });
    expect(out.cvMarkdown).toBeNull();
    expect(out.coverLetterMarkdown).toBeNull();
    expect(out.formAnswers).toBeNull();
  });

  it('rejects an unknown application with NotFoundError', async () => {
    await expect(makeServices().materialsRead({ applicationId: 'missing' })).rejects.toThrow(
      NotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// review_record
// ---------------------------------------------------------------------------
describe('vina_review_record', () => {
  function seedManualApp() {
    seedProfile();
    const cv = seedCv();
    const job = seedJob('j1', 'manual');
    const app = seedApp(job.id, cv.id, 'manual');
    return app.id;
  }

  it('writes a cv_approved event on approve', async () => {
    const appId = seedManualApp();
    const out = await makeServices().reviewRecord({
      applicationId: appId,
      round: 1,
      verdict: 'approve',
      findings: ['ok'],
    });
    expect(out.verdict).toBe('cv_approved');
    const events = listEvents(db, appId);
    expect(events.some((e) => e.kind === 'cv_approved')).toBe(true);
  });

  it('writes a cv_rejected event on reject', async () => {
    const appId = seedManualApp();
    const out = await makeServices().reviewRecord({
      applicationId: appId,
      round: 1,
      verdict: 'reject',
    });
    expect(out.verdict).toBe('cv_rejected');
  });

  it('is idempotent on (applicationId, round)', async () => {
    const appId = seedManualApp();
    const services = makeServices();
    await services.reviewRecord({ applicationId: appId, round: 2, verdict: 'reject' });
    const first = await services.reviewRecord({
      applicationId: appId,
      round: 2,
      verdict: 'reject',
    });
    const events = listEvents(db, appId).filter((e) => e.kind === 'cv_rejected');
    expect(events).toHaveLength(1);
    expect(first.event_id).toBe(events[0]!.id);
  });

  it('rejects an unknown application with NotFoundError', async () => {
    await expect(
      makeServices().reviewRecord({ applicationId: 'missing', round: 1, verdict: 'approve' }),
    ).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// application_status
// ---------------------------------------------------------------------------
describe('vina_application_status', () => {
  function seedManualApp() {
    seedProfile();
    const cv = seedCv();
    const job = seedJob('j1', 'manual');
    const app = seedApp(job.id, cv.id, 'manual');
    return app.id;
  }

  it('transitions and writes the event in the same transaction', async () => {
    const appId = seedManualApp();
    const out = await makeServices().applicationStatus({ applicationId: appId, status: 'skipped' });
    expect(out.status).toBe('skipped');
    expect(findApplicationById(db, appId)!.status).toBe('skipped');
    expect(listEvents(db, appId).length).toBeGreaterThan(0);
  });

  it('marks applied_manually from ready_for_manual_apply and stamps the timestamp', async () => {
    const appId = seedManualApp();
    const services = makeServices();
    // move to ready_for_manual_apply first via a synthetic tailored row
    db.prepare(`UPDATE applications SET status = 'ready_for_manual_apply' WHERE id = ?`).run(appId);
    const out = await services.applicationStatus({
      applicationId: appId,
      status: 'applied_manually',
    });
    expect(out.status).toBe('applied_manually');
    expect(findApplicationById(db, appId)!.applied_manually_at).toBeTruthy();
  });

  it('rejects an illegal transition with ConflictError', async () => {
    const appId = seedManualApp();
    db.prepare(`UPDATE applications SET status = 'submitted' WHERE id = ?`).run(appId);
    await expect(
      makeServices().applicationStatus({ applicationId: appId, status: 'queued' }),
    ).rejects.toThrow(/Illegal transition/);
  });

  it('rejects an unknown application with NotFoundError', async () => {
    await expect(
      makeServices().applicationStatus({ applicationId: 'missing', status: 'skipped' }),
    ).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// easy_apply
// ---------------------------------------------------------------------------
describe('vina_easy_apply', () => {
  function seedAutoApp() {
    seedProfile();
    const cv = seedCv();
    const job = seedJob('j-auto', 'auto');
    updateJobScore(db, job.id, 80, 'strong');
    const app = seedApp(job.id, cv.id, 'auto');
    return { jobId: job.id, appId: app.id };
  }

  it('wraps the gate + runApply and records submitted in a transaction', async () => {
    const { appId } = seedAutoApp();
    const services = makeServices({
      runApply: async () => ({ outcome: 'submitted', events: [{ step: 'submitted' }] }),
    });
    const out = await services.easyApply({ applicationId: appId });
    expect(out.outcome).toBe('submitted');
    expect(findApplicationById(db, appId)!.status).toBe('submitted');
    expect(listEvents(db, appId).some((e) => e.kind === 'submitted')).toBe(true);
  });

  it('rejects an unknown application with NotFoundError', async () => {
    await expect(makeServices().easyApply({ applicationId: 'missing' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('rejects a manual-apply job with ConflictError', async () => {
    seedProfile();
    const cv = seedCv();
    const job = seedJob('j-manual', 'manual');
    const app = seedApp(job.id, cv.id, 'manual');
    await expect(makeServices().easyApply({ applicationId: app.id })).rejects.toThrow(
      /apply_method=manual/,
    );
  });

  it('rejects when the gate blocks (below threshold)', async () => {
    seedProfile();
    const cv = seedCv();
    const job = seedJob('j-low', 'auto'); // match_score stays null → treated as 0
    const app = seedApp(job.id, cv.id, 'auto');
    await expect(makeServices().easyApply({ applicationId: app.id })).rejects.toThrow(
      /blocked by gate/,
    );
  });

  it('short-circuits dry_run without running runApply or submitting', async () => {
    const { appId, jobId } = seedAutoApp();
    updateSettings(db, { autonomous_apply_dry_run: true });
    let runApplyCalled = false;
    const services = makeServices({
      runApply: async () => {
        runApplyCalled = true;
        return { outcome: 'submitted', events: [] };
      },
    });

    const out = await services.easyApply({ applicationId: appId });

    expect(out.outcome).toBe('awaiting_user');
    expect(out.reason).toBe('dry_run');
    expect(runApplyCalled).toBe(false);
    const app = findApplicationById(db, appId)!;
    expect(app.status).toBe('awaiting_user');
    expect(app.failure_reason).toBe('dry_run');
    expect(findJobById(db, jobId)!.status).not.toBe('submitted');
    expect(listEvents(db, appId).some((e) => e.kind === 'submitted')).toBe(false);
    // dry_run still consumes a velocity slot.
    expect(getRateLimit(db).last_attempt_at).toBeTruthy();
  });

  it('advances the rate-limit counter on a successful submit', async () => {
    const { appId } = seedAutoApp();
    const services = makeServices({
      runApply: async () => ({ outcome: 'submitted', events: [] }),
    });

    await services.easyApply({ applicationId: appId });

    const rl = getRateLimit(db);
    expect(rl.successful_today).toBe(1);
    expect(rl.last_success_at).toBeTruthy();
    expect(rl.consecutive_failures).toBe(0);
  });

  it('advances the consecutive-failure counter on a failed apply', async () => {
    const { appId } = seedAutoApp();
    const services = makeServices({
      runApply: async () => ({ outcome: 'failed', reason: 'other', events: [] }),
    });

    await services.easyApply({ applicationId: appId });

    expect(getRateLimit(db).consecutive_failures).toBe(1);
    expect(findApplicationById(db, appId)!.status).toBe('failed');
  });

  it('persists the graph event timeline into application_events', async () => {
    const { appId } = seedAutoApp();
    const services = makeServices({
      runApply: async () => ({
        outcome: 'submitted',
        events: [
          { step: 'started' },
          { step: 'field_filled', detail: { ref: 'email', label: 'Email' } },
          { step: 'submitted' },
        ],
      }),
    });

    await services.easyApply({ applicationId: appId });

    const kinds = listEvents(db, appId).map((e) => e.kind);
    expect(kinds).toContain('apply_started');
    expect(kinds).toContain('field_filled');
    expect(kinds).toContain('submitted');
  });

  it('does not write a spurious terminal event on the awaiting_user outcome', async () => {
    const { appId } = seedAutoApp();
    const services = makeServices({
      runApply: async () => ({ outcome: 'awaiting_user', reason: 'missing_field', events: [] }),
    });

    const out = await services.easyApply({ applicationId: appId });

    expect(out.outcome).toBe('awaiting_user');
    expect(findApplicationById(db, appId)!.status).toBe('awaiting_user');
    // The outcome branch appends nothing: only the walker's own events are written.
    expect(listEvents(db, appId)).toHaveLength(0);
  });

  it('writes a terminal submitted event exactly once', async () => {
    const { appId } = seedAutoApp();
    const services = makeServices({
      runApply: async () => ({
        outcome: 'submitted',
        events: [{ step: 'started' }, { step: 'submitted' }],
      }),
    });

    await services.easyApply({ applicationId: appId });

    const submitted = listEvents(db, appId).filter((e) => e.kind === 'submitted');
    expect(submitted).toHaveLength(1);
    expect(listEvents(db, appId).filter((e) => e.kind === 'apply_started')).toHaveLength(1);
  });

  it('writes a terminal failed event exactly once', async () => {
    const { appId } = seedAutoApp();
    const services = makeServices({
      runApply: async () => ({
        outcome: 'failed',
        reason: 'other',
        events: [{ step: 'started' }, { step: 'submit_failed' }],
      }),
    });

    await services.easyApply({ applicationId: appId });

    const failed = listEvents(db, appId).filter((e) => e.kind === 'failed');
    expect(failed).toHaveLength(1);
  });

  it('gate still blocks when a seam is supplied — permission cannot replace the gate', async () => {
    seedProfile();
    const cv = seedCv();
    const job = seedJob('j-gate', 'auto'); // match_score stays null → treated as 0 → below threshold
    const app = seedApp(job.id, cv.id, 'auto');
    let runApplyCalled = false;
    const services = makeServices({
      runApply: async () => {
        runApplyCalled = true;
        return { outcome: 'submitted', events: [] };
      },
    });

    await expect(services.easyApply({ applicationId: app.id })).rejects.toThrow(/blocked by gate/);
    expect(runApplyCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// external_submit
// ---------------------------------------------------------------------------
describe('vina_external_submit', () => {
  function seedManualApp() {
    seedProfile();
    const cv = seedCv();
    const job = seedJob('j-ext', 'manual');
    updateJobScore(db, job.id, 80, 'strong');
    const app = seedApp(job.id, cv.id, 'manual');
    return { jobId: job.id, appId: app.id };
  }

  it('submits in autonomous mode: transition + external_submitted event + rate-limit', async () => {
    const { appId, jobId } = seedManualApp();
    updateSettings(db, { external_apply_mode: 'autonomous' });
    const out = await makeServices().externalSubmit({ applicationId: appId });

    expect(out.outcome).toBe('submitted');
    expect(findApplicationById(db, appId)!.status).toBe('submitted');
    expect(findJobById(db, jobId)!.status).toBe('submitted');
    expect(listEvents(db, appId).some((e) => e.kind === 'external_submitted')).toBe(true);
    expect(getRateLimit(db).successful_today).toBe(1);
  });

  it('refuses in manual mode (ConflictError)', async () => {
    const { appId } = seedManualApp();
    updateSettings(db, { external_apply_mode: 'manual' });
    await expect(makeServices().externalSubmit({ applicationId: appId })).rejects.toThrow(
      /requires autonomous mode/,
    );
  });

  it('refuses in assisted mode (ConflictError)', async () => {
    const { appId } = seedManualApp();
    updateSettings(db, { external_apply_mode: 'assisted' });
    await expect(makeServices().externalSubmit({ applicationId: appId })).rejects.toThrow(
      /requires autonomous mode/,
    );
  });

  it('rejects an auto-apply job with ConflictError (inverted apply_method check)', async () => {
    seedProfile();
    const cv = seedCv();
    const job = seedJob('j-auto', 'auto');
    updateJobScore(db, job.id, 80, 'strong');
    const app = seedApp(job.id, cv.id, 'auto');
    updateSettings(db, { external_apply_mode: 'autonomous' });
    await expect(makeServices().externalSubmit({ applicationId: app.id })).rejects.toThrow(
      /apply_method=auto/,
    );
  });

  it('rejects when the gate blocks (below threshold)', async () => {
    seedProfile();
    const cv = seedCv();
    const job = seedJob('j-low', 'manual'); // match_score stays null → treated as 0
    const app = seedApp(job.id, cv.id, 'manual');
    updateSettings(db, { external_apply_mode: 'autonomous' });
    await expect(makeServices().externalSubmit({ applicationId: app.id })).rejects.toThrow(
      /blocked by gate/,
    );
  });

  it('short-circuits dry_run without submitting', async () => {
    const { appId, jobId } = seedManualApp();
    updateSettings(db, { external_apply_mode: 'autonomous', autonomous_apply_dry_run: true });

    const out = await makeServices().externalSubmit({ applicationId: appId });

    expect(out.outcome).toBe('awaiting_user');
    expect(out.reason).toBe('dry_run');
    expect(findApplicationById(db, appId)!.status).toBe('awaiting_user');
    expect(findJobById(db, jobId)!.status).not.toBe('submitted');
    expect(listEvents(db, appId).some((e) => e.kind === 'external_submitted')).toBe(false);
    expect(getRateLimit(db).last_attempt_at).toBeTruthy();
  });

  it('rejects an unknown application with NotFoundError', async () => {
    updateSettings(db, { external_apply_mode: 'autonomous' });
    await expect(makeServices().externalSubmit({ applicationId: 'missing' })).rejects.toThrow(
      NotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// ask_user
// ---------------------------------------------------------------------------
describe('vina_ask_user', () => {
  it('raises an alert and returns pending', async () => {
    const services = makeServices();
    const out = await services.askUser({
      questions: [
        { label: 'Years of experience' },
        { label: 'Visa status', detail: 'US/H1B/etc.' },
      ],
    });
    expect(out.status).toBe('pending');
    expect(out.question_count).toBe(2);
    const alerts = listAlerts(db, { kind: 'general' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.title).toContain('2 questions');
  });

  it('rejects an empty question list with ValidationError', async () => {
    await expect(makeServices().askUser({ questions: [] })).rejects.toThrow(ValidationError);
  });
});
