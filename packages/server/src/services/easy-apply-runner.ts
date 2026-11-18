import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BrowserManagerHandle, SiteAdapter } from '@vina/automation';
import {
  runApply,
  type ApplyEvent,
  type ApplyOutcome,
  type ApplyResult,
  type ManualApplyToolKit,
  type RunApplyOptions,
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
} from '../db/repositories/applications.js';
import { appendEvent } from '../db/repositories/application-events.js';
import { findJobById, updateJobStatus } from '../db/repositories/jobs.js';
import { insertAlert } from '../db/repositories/alerts.js';
import {
  recordAttempt,
  recordSuccess,
  recordFailure,
  getRateLimit,
} from '../db/repositories/apply-rate-limit.js';
import { getOrInitSettings, updateSettings } from '../db/repositories/settings.js';
import { checkEasyApplyGate, dayBucketFromIso, type GateBlockReason } from './easy-apply-gate.js';
import { createAutoApplyToolKit } from '../orchestrator/tools/auto-apply.js';
import type { EventBus } from '../events/bus.js';

const log = createLogger('service.easy-apply-runner');

/**
 * Maps a graph event step name to an `application_events.kind`. Events the
 * graph emits but that don't map to a DB-kind are skipped (the server still
 * logs them as a structured log line).
 */
const EVENT_KIND_MAP: Partial<Record<string, ApplicationEventKind>> = {
  started: 'apply_started',
  tailored: 'cv_tailored',
  field_filled: 'field_filled',
  field_unresolved: 'field_unknown',
  submit_failed: 'failed',
  submitted: 'submitted',
};

/**
 * The sole writer of the walker's timeline into `application_events`. Terminal
 * `submitted`/`failed` events come only from the walker's own
 * `submitted`/`submit_failed` steps; the outcome branches never append them
 * (see `runEasyApply`). This keeps the activity log (#27) a single correct feed.
 */
function recordApplyEvents(
  db: DatabaseType,
  applicationId: string,
  events: ApplyEvent[],
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
 * `easy_apply_mode` to `'manual'` and raises a system-level alert. Exported so
 * both the runner's failure branch and the handler's unexpected-throw catch
 * branch can call it without duplication.
 */
export function maybeFlipBreaker(db: DatabaseType, applicationId: string | null): void {
  const rl = getRateLimit(db);
  const s = getOrInitSettings(db);
  if (
    s.easy_apply_mode === 'autonomous' &&
    rl.consecutive_failures >= s.apply_consecutive_failure_limit
  ) {
    updateSettings(db, { easy_apply_mode: 'manual' });
    insertAlert(db, {
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
 * The walker result the runner consumes: the outcome plus the fields it needs
 * for recording (the `applicationId` already known to the runner is omitted).
 */
export type EasyApplySeamResult = {
  outcome: ApplyOutcome;
  reason?: ApplyResult['reason'];
  failureDetail?: string;
  alertRaised?: boolean;
  events: ApplyEvent[];
};

/**
 * The injected walker seam: runs the real `runApply` graph for one application.
 * The gate is consulted by `runEasyApply`, never by the seam itself.
 */
export type EasyApplySeam = (applicationId: string) => Promise<EasyApplySeamResult>;

export interface EasyApplyRunnerDeps {
  db: DatabaseType;
  bus: EventBus;
  buildModel: () => Promise<BaseChatModel>;
  browserManager?: BrowserManagerHandle;
  adapters?: Record<string, SiteAdapter>;
  manualApplyToolKit?: ManualApplyToolKit;
  skillRegistry?: SkillRegistry;
  /**
   * Easy Apply submit seam: runs the real `runApply` graph. Defaults to wiring
   * `runApply` to the browser via `createAutoApplyToolKit` when the browser
   * deps are supplied. Tests inject a fake so no browser is required.
   */
  runApply?: EasyApplySeam;
}

/** Default walker seam: `runApply` wired to the browser via `createAutoApplyToolKit`. */
function defaultEasyApplySeam(deps: EasyApplyRunnerDeps): EasyApplySeam {
  return async (applicationId: string): Promise<EasyApplySeamResult> => {
    if (!deps.browserManager || !deps.adapters || !deps.manualApplyToolKit) {
      throw new ConflictError(
        'Easy Apply is not wired: supply browserManager/adapters/manualApplyToolKit or a runApply seam',
      );
    }
    const app = findApplicationById(deps.db, applicationId);
    if (!app) throw new NotFoundError(`Application ${applicationId} not found`);
    const model = await deps.buildModel();
    const toolKit = createAutoApplyToolKit({
      db: deps.db,
      browserManager: deps.browserManager,
      adapters: deps.adapters,
      manualApplyToolKit: deps.manualApplyToolKit,
      buildModel: deps.buildModel,
    });
    return runApply(
      { applicationId: app.id, jobId: app.job_id, cvId: app.cv_id },
      model as unknown as StructuredApplyDecider,
      toolKit,
      {
        ...(deps.skillRegistry ? { skillRegistry: deps.skillRegistry } : {}),
      } satisfies RunApplyOptions,
    );
  };
}

/**
 * Discriminated result the handler and the `vina_easy_apply` tool each map.
 * `blocked`/`dry_run` carry no outcome because the caller decides what to do
 * (the handler marks the application failed and returns; the tool throws a
 * `ConflictError`). `done` means the runner already recorded status, rate-limit,
 * circuit-breaker and alert state.
 */
export type EasyApplyRunnerResult =
  | { kind: 'blocked'; reason: GateBlockReason }
  | { kind: 'dry_run' }
  | { kind: 'done'; outcome: ApplyOutcome; reason?: ApplyResult['reason'] };

/**
 * The single authoritative Easy Apply submit path (ADR-023). Owns the order:
 * `checkEasyApplyGate` → `recordAttempt` → `dry_run` short-circuit → `runApply`
 * (injected seam) → `recordApplyEvents` (sole event writer) → outcome (status
 * transition + rate-limit + circuit-breaker flip + alert).
 *
 * Both the queue handler (`apply.ts`) and the `vina_easy_apply` tool delegate to
 * this seam. The walker itself (`runApply`/`decideUnresolvedField`) is unchanged;
 * the gate is consulted here regardless of any permission outcome upstream, so
 * passing permission can never skip the gate.
 */
export async function runEasyApply(
  deps: EasyApplyRunnerDeps,
  applicationId: string,
): Promise<EasyApplyRunnerResult> {
  const { db } = deps;

  const app = findApplicationById(db, applicationId);
  if (!app) throw new NotFoundError(`Application ${applicationId} not found`);

  const job = findJobById(db, app.job_id);
  if (!job) throw new NotFoundError(`Job ${app.job_id} not found`);

  const nowIso = new Date().toISOString();
  const today = dayBucketFromIso(nowIso);
  const gate = checkEasyApplyGate(db, {
    jobId: job.id,
    nowIso,
    today,
    excludeApplicationId: app.id,
  });

  if (gate.decision === 'block') {
    return { kind: 'blocked', reason: gate.reason };
  }

  // Record the attempt regardless of dry_run vs allow. Dry-run still consumes
  // a velocity slot so the user can see the throttle in action.
  recordAttempt(db, nowIso, today);

  if (gate.decision === 'dry_run') {
    log.info({ application_id: app.id, job_id: job.id }, 'apply dry-run: would have invoked runApply');
    updateApplicationStatus(db, app.id, 'awaiting_user', { failure_reason: 'dry_run' });
    return { kind: 'dry_run' };
  }

  const seam = deps.runApply ?? defaultEasyApplySeam(deps);
  const result = await seam(app.id);

  recordApplyEvents(db, app.id, result.events);

  if (result.outcome === 'submitted') {
    updateApplicationStatus(db, app.id, 'submitted', {
      submitted_at: new Date().toISOString(),
    });
    // The job row mirrors the terminal application state so the Jobs worklist
    // drops it and the Applied tab picks it up.
    updateJobStatus(db, job.id, 'submitted');
    // Successful submit resets consecutive failures + increments daily count.
    const completedAt = new Date().toISOString();
    recordSuccess(db, completedAt, dayBucketFromIso(completedAt));
  } else if (result.outcome === 'awaiting_user') {
    // missing_field / captcha / session_expired — pause for the user. Does not
    // count as success or failure; the attempt timestamp was already stamped.
    updateApplicationStatus(db, app.id, 'awaiting_user', {
      failure_reason: result.reason ?? null,
    });
  } else {
    // outcome === 'failed'. Some graph paths raise their own alerts (step cap,
    // submit_failed); `alertRaised` suppresses the duplicate plain alert.
    const detail = result.failureDetail ?? result.reason ?? 'apply failed without detail';
    updateApplicationStatus(db, app.id, 'failed', {
      failure_reason: detail.slice(0, 500),
    });
    if (!result.alertRaised) {
      insertAlert(db, {
        kind: 'apply_failed',
        severity: 'error',
        title: `Apply failed: ${job.title} @ ${job.company}`,
        description: detail.slice(0, 1000),
        application_id: app.id,
        payload: { reason: result.reason ?? 'other' },
      });
    }
    recordFailure(db);
    maybeFlipBreaker(db, app.id);
  }

  return { kind: 'done', outcome: result.outcome, reason: result.reason };
}
