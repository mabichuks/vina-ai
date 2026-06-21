import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BrowserManagerHandle, SiteAdapter } from '@vina/automation';
import {
  runApply,
  type ApplyResult,
  type ManualApplyToolKit,
  type PromptLoader,
  type SkillRegistry,
  type StructuredApplyDecider,
} from '@vina/orchestrator';
import {
  ConflictError,
  createLogger,
  NotFoundError,
  type ApplicationEventKind,
} from '@vina/shared';
import {
  findApplicationById,
  updateApplicationStatus,
} from '../../db/repositories/applications.js';
import { appendEvent } from '../../db/repositories/application-events.js';
import { findJobById } from '../../db/repositories/jobs.js';
import { insertAlert } from '../../db/repositories/alerts.js';
import {
  recordAttempt,
  recordSuccess,
  recordFailure,
  getRateLimit,
} from '../../db/repositories/apply-rate-limit.js';
import { getOrInitSettings, updateSettings } from '../../db/repositories/settings.js';
import { checkEasyApplyGate, dayBucketFromIso } from '../../services/easy-apply-gate.js';
import { createAutoApplyToolKit } from '../../orchestrator/tools/auto-apply.js';
import type { EventBus } from '../../events/bus.js';

const log = createLogger('handler.apply');

export interface ApplyHandlerDeps {
  db: DatabaseType;
  bus: EventBus;
  browserManager: BrowserManagerHandle;
  adapters: Record<string, SiteAdapter>;
  manualApplyToolKit: ManualApplyToolKit;
  buildModel: () => Promise<BaseChatModel>;
  promptLoader?: PromptLoader;
  skillRegistry?: SkillRegistry;
}

export interface ApplyPayload {
  application_id: string;
}

/**
 * Maps a graph event step name to an `application_events.kind`. Events
 * the graph emits but that don't map to a DB-kind are skipped (the
 * server still logs them as a structured log line).
 */
const EVENT_KIND_MAP: Partial<Record<string, ApplicationEventKind>> = {
  started: 'apply_started',
  tailored: 'cv_tailored',
  field_filled: 'field_filled',
  field_unresolved: 'field_unknown',
  submit_failed: 'failed',
  submitted: 'submitted',
};

function recordApplyEvents(
  db: DatabaseType,
  applicationId: string,
  events: ApplyResult['events'],
): void {
  for (const event of events) {
    const kind = EVENT_KIND_MAP[event.step];
    if (!kind) continue;
    appendEvent(db, {
      application_id: applicationId,
      kind,
      ...(event.detail ? { payload: event.detail } : {}),
    });
  }
}

/**
 * Checks whether consecutive failures have hit the limit and, if so, flips
 * `easy_apply_mode` to `'manual'` and raises a system-level alert. Extracted
 * so both the normal failure branch and the unexpected-throw catch branch can
 * call it without duplication.
 */
function maybeFlipBreaker(deps: ApplyHandlerDeps, applicationId: string | null): void {
  const rl = getRateLimit(deps.db);
  const s = getOrInitSettings(deps.db);
  if (
    s.easy_apply_mode === 'autonomous' &&
    rl.consecutive_failures >= s.apply_consecutive_failure_limit
  ) {
    updateSettings(deps.db, { easy_apply_mode: 'manual' });
    insertAlert(deps.db, {
      kind: 'apply_failed',
      severity: 'error',
      title: 'Autonomous Easy Apply paused after consecutive failures',
      description: `${rl.consecutive_failures} apply attempts failed in a row. Mode was flipped to manual. Investigate before re-enabling.`,
      application_id: applicationId,
      payload: { consecutive_failures: rl.consecutive_failures },
    });
  }
}

/**
 * `apply` task handler. Defends against the manual-apply pipeline route
 * (per `docs/langgraph-orchestrator.md` §5.4) and translates the graph
 * result into application status + alert state.
 */
export function createApplyHandler(
  deps: ApplyHandlerDeps,
): (payload: ApplyPayload) => Promise<void> {
  return async (payload) => {
    const app = findApplicationById(deps.db, payload.application_id);
    if (!app) throw new NotFoundError(`Application ${payload.application_id} not found`);

    const job = findJobById(deps.db, app.job_id);
    if (!job) throw new NotFoundError(`Job ${app.job_id} not found`);

    if (job.apply_method !== 'auto') {
      // Routing bug — surface, but don't crash the worker. Mark the
      // application failed so it doesn't loop, and raise an alert.
      log.error(
        { application_id: app.id, apply_method: job.apply_method },
        'apply handler invoked with non-auto job',
      );
      updateApplicationStatus(deps.db, app.id, 'failed', {
        failure_reason: 'apply_method_mismatch',
      });
      insertAlert(deps.db, {
        kind: 'apply_failed',
        severity: 'error',
        title: `Apply handler routed a manual-apply job (${job.title} @ ${job.company})`,
        description: 'This is a routing bug — manual-apply jobs should run prepare-manual-apply.',
        application_id: app.id,
        payload: { apply_method: job.apply_method },
      });
      throw new ConflictError(`Job ${job.id} is apply_method=manual — routing bug`);
    }

    // -----------------------------------------------------------------------
    // Task 4.1 — Gate check: consult the rate-limit / circuit-breaker gate
    // before spending any browser or model resources. Pure check — never
    // mutates state. recordAttempt() below is the one write.
    // -----------------------------------------------------------------------
    const nowIso = new Date().toISOString();
    const today = dayBucketFromIso(nowIso);
    const gate = checkEasyApplyGate(deps.db, {
      jobId: job.id,
      nowIso,
      today,
      excludeApplicationId: app.id,
    });

    if (gate.decision === 'block') {
      updateApplicationStatus(deps.db, app.id, 'failed', {
        failure_reason: `gate_blocked: ${gate.reason}`,
      });
      insertAlert(deps.db, {
        kind: 'apply_failed',
        severity: 'action_required',
        title: `Apply skipped: ${job.title} @ ${job.company}`,
        description: `Gate blocked this apply (${gate.reason}).`,
        application_id: app.id,
        payload: { gate_reason: gate.reason },
      });
      deps.bus.emit('jobs:updated', { ids: [app.job_id] });
      log.info({ application_id: app.id, gate_reason: gate.reason }, 'apply skipped by gate');
      return;
    }

    // Record the attempt regardless of dry_run vs allow. Dry-run still
    // consumes a velocity slot so the user can see the throttle in action.
    recordAttempt(deps.db, nowIso, today);

    if (gate.decision === 'dry_run') {
      log.info(
        { application_id: app.id, job_id: job.id },
        'apply dry-run: would have invoked runApply',
      );
      updateApplicationStatus(deps.db, app.id, 'awaiting_user', {
        failure_reason: 'dry_run',
      });
      deps.bus.emit('jobs:updated', { ids: [app.job_id] });
      return;
    }

    const model = await deps.buildModel();
    const toolKit = createAutoApplyToolKit({
      db: deps.db,
      browserManager: deps.browserManager,
      adapters: deps.adapters,
      manualApplyToolKit: deps.manualApplyToolKit,
      buildModel: deps.buildModel,
    });

    let result: ApplyResult;
    try {
      result = await runApply(
        { applicationId: app.id, jobId: app.job_id, cvId: app.cv_id },
        model as unknown as StructuredApplyDecider,
        toolKit,
        {
          ...(deps.promptLoader ? { promptLoader: deps.promptLoader } : {}),
          ...(deps.skillRegistry ? { skillRegistry: deps.skillRegistry } : {}),
        },
      );
    } catch (err) {
      // Defence in depth: any unexpected exception inside runApply (selector
      // throws, browser disconnects, Playwright type errors) should still
      // mark the application failed and raise an alert — not silently die
      // with the task in `failed` state while the application stays queued.
      const detail = err instanceof Error ? err.message : String(err);
      log.error(
        { err, application_id: app.id },
        'apply task threw unexpectedly',
      );
      updateApplicationStatus(deps.db, app.id, 'failed', {
        failure_reason: detail.slice(0, 500),
      });
      insertAlert(deps.db, {
        kind: 'apply_failed',
        severity: 'error',
        title: `Apply failed: ${job.title} @ ${job.company}`,
        description: detail.slice(0, 1000),
        application_id: app.id,
        payload: { error: detail.slice(0, 2000) },
      });
      // Task 4.2 — count the unexpected throw as a failure; the consecutive
      // failure counter may trip the circuit breaker.
      recordFailure(deps.db);
      maybeFlipBreaker(deps, app.id);
      deps.bus.emit('jobs:updated', { ids: [app.job_id] });
      throw err;
    }

    recordApplyEvents(deps.db, app.id, result.events);

    if (result.outcome === 'submitted') {
      updateApplicationStatus(deps.db, app.id, 'submitted', {
        submitted_at: new Date().toISOString(),
      });
      // Task 4.2 — successful submit resets consecutive failures + increments
      // daily count. Use a fresh ISO timestamp for accuracy.
      const completedAt = new Date().toISOString();
      recordSuccess(deps.db, completedAt, dayBucketFromIso(completedAt));
      deps.bus.emit('application:updated', { id: app.id, status: 'submitted' });
    } else if (result.outcome === 'awaiting_user') {
      // missing_field / captcha / session_expired — these pause the application for the user.
      // Task 4.2 — awaiting_user does NOT count as success or failure; the
      // attempt timestamp was already stamped by recordAttempt() above.
      updateApplicationStatus(deps.db, app.id, 'awaiting_user', {
        failure_reason: result.reason ?? null,
      });
      // Alert already created by the graph.
    } else {
      // outcome === 'failed' — open_form / tailoring / other graph-level
      // failure. Some paths inside the graph raise their own alerts (step
      // cap exceeded, submit_failed). Others don't (tailoring throw,
      // openJobApplication throw). Raise unconditionally here so every
      // failed outcome has a visible alert.
      const detail =
        result.failureDetail ?? result.reason ?? 'apply failed without detail';
      updateApplicationStatus(deps.db, app.id, 'failed', {
        failure_reason: detail.slice(0, 500),
      });
      insertAlert(deps.db, {
        kind: 'apply_failed',
        severity: 'error',
        title: `Apply failed: ${job.title} @ ${job.company}`,
        description: detail.slice(0, 1000),
        application_id: app.id,
        payload: { reason: result.reason ?? 'other' },
      });
      // Task 4.2 — increment consecutive failures; check whether the
      // circuit breaker threshold has been reached.
      recordFailure(deps.db);
      maybeFlipBreaker(deps, app.id);
    }
    deps.bus.emit('jobs:updated', { ids: [app.job_id] });
    log.info(
      { application_id: app.id, outcome: result.outcome, reason: result.reason },
      'apply task complete',
    );
  };
}
