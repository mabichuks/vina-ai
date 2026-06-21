/**
 * Tests for Tasks 4.1 and 4.2: easy-apply-gate enforcement + outcome recording
 * in the apply task handler.
 *
 * This file tests unit-level behaviour of the handler without a real browser;
 * end-to-end browser tests live in tests/integration/apply-e2e.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { BrowserManagerHandle } from '@vina/automation';
import type { ApplyResult } from '@vina/orchestrator';
import { createApplyHandler } from '../../../src/queue/handlers/apply.js';
import {
  insertApplication,
  findApplicationById,
} from '../../../src/db/repositories/applications.js';
import { insertJob } from '../../../src/db/repositories/jobs.js';
import { insertCv } from '../../../src/db/repositories/cvs.js';
import { listAlerts } from '../../../src/db/repositories/alerts.js';
import { freshTestDb } from '../../db/helpers.js';
import { createEventBus } from '../../../src/events/bus.js';
import { upsertSearchPreferences } from '../../../src/db/repositories/search-preferences.js';

// ---------------------------------------------------------------------------
// Shared runApply mock — replaced per-fixture via buildHandlerFixture()
// ---------------------------------------------------------------------------

// We need to be able to control what runApply returns from our fixture helper.
// The handler imports runApply from @vina/orchestrator, so we mock the whole
// module and expose a setter that individual fixtures call.
let _runApplyImpl: (() => Promise<ApplyResult>) | null = null;

vi.mock('@vina/orchestrator', async (importOriginal) => {
  const original = await importOriginal<typeof import('@vina/orchestrator')>();
  return {
    ...original,
    runApply: async (..._args: unknown[]) => {
      if (_runApplyImpl === null) {
        throw new Error('runApply mock: no impl set — call fx.setRunApply*() first');
      }
      return _runApplyImpl();
    },
  };
});

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

type OutcomeKind = 'submitted' | 'failed' | 'awaiting_user';

interface FixtureOptions {
  /** Default outcome runApply resolves to. */
  outcome?: OutcomeKind;
  /**
   * When true, the buildModel stub throws — use for gate/dry_run paths that
   * must not reach the model-build step. Defaults to false so that allow-path
   * tests (submitted / failed / awaiting_user) can reach runApply without
   * failing on the model build.
   */
  strictBuildModel?: boolean;
}

function buildHandlerFixture(outcomeOrOpts: OutcomeKind | FixtureOptions = 'submitted') {
  const opts: FixtureOptions =
    typeof outcomeOrOpts === 'string' ? { outcome: outcomeOrOpts } : outcomeOrOpts;
  const defaultOutcome: OutcomeKind = opts.outcome ?? 'submitted';

  const db = freshTestDb();

  // Lower the score threshold so a freshly-inserted job (match_score=NULL → 0)
  // passes the gate's below_threshold check.
  upsertSearchPreferences(db, { score_threshold: 0 });

  const cv = insertCv(db, {
    label: 'Default',
    original_filename: 'cv.docx',
    mime_type:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    file_path: '/tmp/cv.docx',
    extracted_text: 'Engineer with broad experience.',
    is_default: true,
  });

  const job = insertJob(db, {
    site_id: 'linkedin',
    external_id: `gate-test-${Math.random()}`,
    url: 'https://www.linkedin.com/jobs/view/gate-1',
    apply_method: 'auto',
    title: 'Senior Engineer',
    company: 'Acme',
    description: 'Build things.',
  });

  const app = insertApplication(db, {
    job_id: job.id,
    cv_id: cv.id,
    apply_method: 'auto',
    status: 'queued',
  });

  // Default impl: produce the requested outcome with no events.
  _runApplyImpl = async () => outcomeResult(defaultOutcome);

  const STUB_MANAGER: BrowserManagerHandle = {
    async getContext() {
      throw new Error('STUB_MANAGER.getContext should not be called in gate tests');
    },
    async closeContext() { /* noop */ },
    async closeAll() { /* noop */ },
  };

  const handler = createApplyHandler({
    db,
    bus: createEventBus(),
    browserManager: STUB_MANAGER,
    adapters: {},
    manualApplyToolKit: {
      async saveTailoredCv() { return { path: '/dev/null' }; },
      async saveTailoredCoverLetter() { return { path: '/dev/null' }; },
      async saveTailoredCvPdf() { return { path: '/dev/null' }; },
      async saveTailoredCoverLetterPdf() { return { path: '/dev/null' }; },
    },
    // For gate/dry_run tests the handler should return before reaching
    // buildModel. For allow-path tests (submitted/failed/awaiting_user),
    // runApply is mocked so the model object is constructed but never used.
    buildModel: opts.strictBuildModel
      ? async () => { throw new Error('buildModel must not be called here'); }
      : async () => ({} as never),
  });

  return {
    db,
    applicationId: app.id,
    jobId: job.id,
    handler,
    /** Override the default outcome. */
    setRunApply(outcome: OutcomeKind) {
      _runApplyImpl = async () => outcomeResult(outcome);
    },
    /** Make runApply throw — tests that dry_run / block paths skip it. */
    setRunApplyShouldNotBeCalled() {
      _runApplyImpl = async () => {
        throw new Error('runApply was called but should not have been');
      };
    },
    /** Make runApply throw an unexpected error (for catch-block tests). */
    setRunApplyThrows(err: Error) {
      _runApplyImpl = async () => { throw err; };
    },
    teardown() {
      db.close();
      _runApplyImpl = null;
    },
  };
}

function outcomeResult(outcome: OutcomeKind): ApplyResult {
  // applicationId is required by the type but ignored by the handler (it uses
  // app.id from closure) — provide a placeholder so the type is satisfied.
  const applicationId = 'placeholder';
  switch (outcome) {
    case 'submitted':
      return { outcome: 'submitted', applicationId, events: [] };
    case 'failed':
      return { outcome: 'failed', applicationId, reason: 'other', events: [] };
    case 'awaiting_user':
      return { outcome: 'awaiting_user', applicationId, reason: 'missing_field', events: [] };
  }
}

// ---------------------------------------------------------------------------
// Task 4.1 — Gate enforcement at handler entry
// ---------------------------------------------------------------------------

describe('apply handler — Task 4.1: gate enforcement', () => {
  afterEach(() => {
    _runApplyImpl = null;
  });

  it('blocks via gate (circuit_breaker_tripped) and raises apply_failed alert', async () => {
    // strictBuildModel: the handler must return before reaching buildModel.
    const fx = buildHandlerFixture({ strictBuildModel: true });
    try {
      // Trip the circuit breaker (default limit = 5; set well above it).
      fx.db.prepare(`UPDATE apply_rate_limit SET consecutive_failures = 99`).run();

      await fx.handler({ application_id: fx.applicationId });

      const app = findApplicationById(fx.db, fx.applicationId);
      expect(app?.status).toBe('failed');
      expect(app?.failure_reason).toMatch(/gate_blocked/);

      const alerts = listAlerts(fx.db, { application_id: fx.applicationId });
      const alert = alerts.find((a) => a.kind === 'apply_failed');
      expect(alert).toBeDefined();
      // The gate_reason surfaces in the description.
      expect(alert?.description).toMatch(/circuit_breaker/);
    } finally {
      fx.teardown();
    }
  });

  it('respects dry_run setting — marks awaiting_user without launching runApply', async () => {
    // strictBuildModel: dry_run path must exit before buildModel.
    const fx = buildHandlerFixture({ strictBuildModel: true });
    try {
      fx.setRunApplyShouldNotBeCalled();
      // Enable dry-run mode (SQLite stores booleans as 0/1).
      fx.db.prepare(`UPDATE settings SET autonomous_apply_dry_run = 1 WHERE id = 'app'`).run();

      await fx.handler({ application_id: fx.applicationId });

      const app = findApplicationById(fx.db, fx.applicationId);
      expect(app?.status).toBe('awaiting_user');
      expect(app?.failure_reason).toMatch(/dry_run/);
    } finally {
      fx.teardown();
    }
  });

  it('stamps last_attempt_at when gate allows (submitted outcome)', async () => {
    const fx = buildHandlerFixture({ outcome: 'submitted' });
    try {
      await fx.handler({ application_id: fx.applicationId });

      const rl = fx.db.prepare(`SELECT * FROM apply_rate_limit`).get() as Record<string, unknown>;
      expect(rl['last_attempt_at']).not.toBeNull();
    } finally {
      fx.teardown();
    }
  });

  it('stamps last_attempt_at even on dry_run', async () => {
    // strictBuildModel: dry_run path must exit before buildModel.
    const fx = buildHandlerFixture({ strictBuildModel: true });
    try {
      fx.setRunApplyShouldNotBeCalled();
      fx.db.prepare(`UPDATE settings SET autonomous_apply_dry_run = 1 WHERE id = 'app'`).run();

      await fx.handler({ application_id: fx.applicationId });

      const rl = fx.db.prepare(`SELECT * FROM apply_rate_limit`).get() as Record<string, unknown>;
      expect(rl['last_attempt_at']).not.toBeNull();
    } finally {
      fx.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// Task 4.2 — Outcome recording + circuit-breaker auto-flip
// ---------------------------------------------------------------------------

describe('apply handler — Task 4.2: outcome recording', () => {
  afterEach(() => {
    _runApplyImpl = null;
  });

  it('recordSuccess on submitted outcome', async () => {
    const fx = buildHandlerFixture({ outcome: 'submitted' });
    try {
      await fx.handler({ application_id: fx.applicationId });

      const rl = fx.db.prepare(`SELECT * FROM apply_rate_limit`).get() as Record<string, unknown>;
      expect(rl['successful_today']).toBe(1);
      expect(rl['consecutive_failures']).toBe(0);
      expect(rl['last_success_at']).not.toBeNull();
    } finally {
      fx.teardown();
    }
  });

  it('recordFailure on failed outcome', async () => {
    const fx = buildHandlerFixture({ outcome: 'failed' });
    try {
      await fx.handler({ application_id: fx.applicationId });

      const rl = fx.db.prepare(`SELECT * FROM apply_rate_limit`).get() as Record<string, unknown>;
      expect(rl['consecutive_failures']).toBe(1);
      expect(rl['successful_today']).toBe(0);
    } finally {
      fx.teardown();
    }
  });

  it('awaiting_user neither succeeds nor fails the counters', async () => {
    const fx = buildHandlerFixture({ outcome: 'awaiting_user' });
    try {
      await fx.handler({ application_id: fx.applicationId });

      const rl = fx.db.prepare(`SELECT * FROM apply_rate_limit`).get() as Record<string, unknown>;
      expect(rl['consecutive_failures']).toBe(0);
      expect(rl['successful_today']).toBe(0);
      // last_attempt_at is stamped by recordAttempt in Task 4.1.
      expect(rl['last_attempt_at']).not.toBeNull();
    } finally {
      fx.teardown();
    }
  });

  it('flips easy_apply_mode to manual after consecutive failure limit hit', async () => {
    const fx = buildHandlerFixture({ outcome: 'failed' });
    try {
      // Set mode = autonomous with a limit of 1 so a single failure flips it.
      fx.db
        .prepare(
          `UPDATE settings SET easy_apply_mode = 'autonomous', apply_consecutive_failure_limit = 1 WHERE id = 'app'`,
        )
        .run();

      await fx.handler({ application_id: fx.applicationId });

      const settings = fx.db.prepare(`SELECT * FROM settings`).get() as Record<string, unknown>;
      expect(settings['easy_apply_mode']).toBe('manual');

      const alerts = listAlerts(fx.db);
      const breakerAlert = alerts.find(
        (a) => a.kind === 'apply_failed' && /autonomous.*paused/i.test(a.title),
      );
      expect(breakerAlert).toBeDefined();
    } finally {
      fx.teardown();
    }
  });

  it('does not flip mode when already in manual', async () => {
    const fx = buildHandlerFixture({ outcome: 'failed' });
    try {
      // Limit = 1, but mode is already manual — no breaker alert should fire.
      fx.db
        .prepare(
          `UPDATE settings SET easy_apply_mode = 'manual', apply_consecutive_failure_limit = 1 WHERE id = 'app'`,
        )
        .run();

      await fx.handler({ application_id: fx.applicationId });

      const settings = fx.db.prepare(`SELECT * FROM settings`).get() as Record<string, unknown>;
      expect(settings['easy_apply_mode']).toBe('manual');

      const alerts = listAlerts(fx.db);
      const breakerAlert = alerts.find(
        (a) => a.kind === 'apply_failed' && /autonomous.*paused/i.test(a.title),
      );
      expect(breakerAlert).toBeUndefined();
    } finally {
      fx.teardown();
    }
  });

  it('recordFailure when runApply throws unexpectedly', async () => {
    // Default outcome ignored; setRunApplyThrows overrides it.
    const fx = buildHandlerFixture({ outcome: 'submitted' });
    try {
      fx.setRunApplyThrows(new Error('unexpected playwright crash'));

      // The handler re-throws after marking the application failed.
      await fx.handler({ application_id: fx.applicationId }).catch(() => undefined);

      const rl = fx.db.prepare(`SELECT * FROM apply_rate_limit`).get() as Record<string, unknown>;
      expect(rl['consecutive_failures']).toBe(1);
    } finally {
      fx.teardown();
    }
  });

  it('flips mode to manual when catch path trips breaker', async () => {
    const fx = buildHandlerFixture({ outcome: 'submitted' });
    try {
      fx.db
        .prepare(
          `UPDATE settings SET easy_apply_mode = 'autonomous', apply_consecutive_failure_limit = 1 WHERE id = 'app'`,
        )
        .run();
      fx.setRunApplyThrows(new Error('playwright crash'));

      await fx.handler({ application_id: fx.applicationId }).catch(() => undefined);

      const settings = fx.db.prepare(`SELECT * FROM settings`).get() as Record<string, unknown>;
      expect(settings['easy_apply_mode']).toBe('manual');
    } finally {
      fx.teardown();
    }
  });
});
