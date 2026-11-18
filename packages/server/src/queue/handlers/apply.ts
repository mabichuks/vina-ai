import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BrowserManagerHandle, SiteAdapter } from '@vina/automation';
import type { ManualApplyToolKit, SkillRegistry } from '@vina/orchestrator';
import { ConflictError, createLogger, NotFoundError } from '@vina/shared';
import {
  findApplicationById,
  updateApplicationStatus,
} from '../../db/repositories/applications.js';
import { findJobById } from '../../db/repositories/jobs.js';
import { insertAlert } from '../../db/repositories/alerts.js';
import { recordFailure } from '../../db/repositories/apply-rate-limit.js';
import { runEasyApply, maybeFlipBreaker } from '../../services/easy-apply-runner.js';
import type { EventBus } from '../../events/bus.js';

const log = createLogger('handler.apply');

export interface ApplyHandlerDeps {
  db: DatabaseType;
  bus: EventBus;
  browserManager: BrowserManagerHandle;
  adapters: Record<string, SiteAdapter>;
  manualApplyToolKit: ManualApplyToolKit;
  buildModel: () => Promise<BaseChatModel>;
  skillRegistry?: SkillRegistry;
}

export interface ApplyPayload {
  application_id: string;
}

/**
 * `apply` task handler. Defends against the manual-apply pipeline route
 * (per `docs/langgraph-orchestrator.md` §5.4) and delegates the gate + walker +
 * event/outcome recording to the shared `runEasyApply` seam (the single
 * authoritative submit path). Keeps only its route-defence and catch/rethrow
 * semantics; the walker itself is unchanged.
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

    let result;
    try {
      result = await runEasyApply(deps, app.id);
    } catch (err) {
      // Defence in depth: any unexpected exception inside runApply (selector
      // throws, browser disconnects, Playwright type errors) should still mark
      // the application failed and raise an alert — not silently die with the
      // task in `failed` state while the application stays queued.
      const detail = err instanceof Error ? err.message : String(err);
      log.error({ err, application_id: app.id }, 'apply task threw unexpectedly');
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
      // Count the unexpected throw as a failure; the consecutive failure
      // counter may trip the circuit breaker.
      recordFailure(deps.db);
      maybeFlipBreaker(deps.db, app.id);
      deps.bus.emit('jobs:updated', { ids: [app.job_id] });
      throw err;
    }

    if (result.kind === 'blocked') {
      updateApplicationStatus(deps.db, app.id, 'failed', {
        failure_reason: `gate_blocked: ${result.reason}`,
      });
      insertAlert(deps.db, {
        kind: 'apply_failed',
        severity: 'action_required',
        title: `Apply skipped: ${job.title} @ ${job.company}`,
        description: `Gate blocked this apply (${result.reason}).`,
        application_id: app.id,
        payload: { gate_reason: result.reason },
      });
      deps.bus.emit('jobs:updated', { ids: [app.job_id] });
      log.info({ application_id: app.id, gate_reason: result.reason }, 'apply skipped by gate');
      return;
    }

    if (result.kind === 'dry_run') {
      deps.bus.emit('jobs:updated', { ids: [app.job_id] });
      return;
    }

    if (result.outcome === 'submitted') {
      deps.bus.emit('application:updated', { id: app.id, status: 'submitted' });
    }
    deps.bus.emit('jobs:updated', { ids: [app.job_id] });
    log.info(
      { application_id: app.id, outcome: result.outcome, reason: result.reason },
      'apply task complete',
    );
  };
}
