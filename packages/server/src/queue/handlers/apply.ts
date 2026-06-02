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
  awaiting_approval: 'cv_rejected', // closest existing kind; see README
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
      deps.bus.emit('jobs:updated', { ids: [app.job_id] });
      throw err;
    }

    recordApplyEvents(deps.db, app.id, result.events);

    if (result.outcome === 'submitted') {
      updateApplicationStatus(deps.db, app.id, 'submitted', {
        submitted_at: new Date().toISOString(),
      });
      deps.bus.emit('application:updated', { id: app.id, status: 'submitted' });
    } else if (result.outcome === 'awaiting_approval') {
      updateApplicationStatus(deps.db, app.id, 'awaiting_approval');
      // Alert already created by the graph via toolKit.createAlert.
    } else if (result.outcome === 'awaiting_user') {
      updateApplicationStatus(deps.db, app.id, 'awaiting_approval', {
        failure_reason: result.reason ?? null,
      });
      // Alert already created by the graph.
    } else {
      // outcome === 'failed'
      updateApplicationStatus(deps.db, app.id, 'failed', {
        failure_reason: result.failureDetail ?? result.reason ?? 'other',
      });
    }
    deps.bus.emit('jobs:updated', { ids: [app.job_id] });
    log.info(
      { application_id: app.id, outcome: result.outcome, reason: result.reason },
      'apply task complete',
    );
  };
}
