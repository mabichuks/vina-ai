import type { Database as DatabaseType } from 'better-sqlite3';
import { createLogger, NotFoundError } from '@vina/shared';
import { findApplicationById } from '../../db/repositories/applications.js';
import { findJobById } from '../../db/repositories/jobs.js';
import { appendEvent, listEvents } from '../../db/repositories/application-events.js';
import { getOrInitSettings } from '../../db/repositories/settings.js';
import type { SessionDriver } from '../../opencode/session-driver.js';
import { bridgeExternalToolEvents } from '../../opencode/tool-event-bridge.js';
import type { EventBus } from '../../events/bus.js';

const log = createLogger('handler.external-form-fill');

/**
 * External ATS form fill (issue #21). Spawns a fresh `vina-manual` session that
 * opens the external form in Vina's managed Chromium and fills it via Playwright
 * MCP snapshot/act (zero selector code), then either stops before submit
 * (`assisted`) or submits through `vina_external_submit` (`autonomous`).
 *
 * The session is never the source of truth: on idle the handler verifies the DB
 * reached the expected terminal state for the current `external_apply_mode` and
 * mirrors the observed tool sequence to `application_events` via the bridge.
 */

export interface ExternalFormFillDeps {
  db: DatabaseType;
  bus: EventBus;
  /** Session driver spawning the fresh `vina-manual` session (fake in tests). */
  sessionDriver: SessionDriver;
}

export interface ExternalFormFillPayload {
  application_id: string;
}

export function createExternalFormFillHandler(
  deps: ExternalFormFillDeps,
): (payload: ExternalFormFillPayload) => Promise<void> {
  return async (payload) => {
    const app = findApplicationById(deps.db, payload.application_id);
    if (!app) throw new NotFoundError(`Application ${payload.application_id} not found`);
    const job = findJobById(deps.db, app.job_id);
    if (!job) throw new NotFoundError(`Job ${app.job_id} not found`);

    const mode = getOrInitSettings(deps.db).external_apply_mode;

    const prompt = buildExternalFormFillPrompt(app.id, job.title, job.company, mode);
    const result = await deps.sessionDriver.run({
      agent: 'vina-manual',
      prompt,
      collectToolEvents: true,
    });

    if (result.outcome.reason !== 'idle') {
      throw new Error(
        `vina-manual session ${result.outcome.reason}: ${
          result.outcome.reason === 'failed' ? result.outcome.error : ''
        }`.trim(),
      );
    }

    // Mirror the observed browser tool calls to application_events.
    bridgeExternalToolEvents(deps.db, app.id, result.toolEvents ?? []);

    if (mode === 'autonomous') {
      // The agent must have submitted via vina_external_submit (the only external
      // submit path) — a raw browser click is mode-denied and never records here.
      if (!hasEvent(deps.db, app.id, 'external_submitted')) {
        throw new Error('vina-manual session ended without external_submitted');
      }
    } else {
      // assisted (and any non-autonomous mode): the agent filled and stopped
      // before the submit control. Record the ready-for-review terminal event
      // exactly once so the user knows the live window is ready for their click.
      if (!hasEvent(deps.db, app.id, 'external_ready_for_review')) {
        appendEvent(deps.db, {
          application_id: app.id,
          kind: 'external_ready_for_review',
          payload: { mode },
        });
      }
    }

    deps.bus.emit('jobs:updated', { ids: [job.id] });
    log.info({ application_id: app.id, mode }, 'external form fill complete');
  };
}

function hasEvent(
  db: DatabaseType,
  applicationId: string,
  kind: 'external_submitted' | 'external_ready_for_review',
): boolean {
  return listEvents(db, applicationId).some((e) => e.kind === kind);
}

function buildExternalFormFillPrompt(
  applicationId: string,
  title: string,
  company: string,
  mode: string,
): string {
  const stopLine =
    mode === 'autonomous'
      ? `Fill the form, read every field back, then submit with vina_external_submit (the only submit path).`
      : `Fill the form, read every field back, then STOP before the submit control — the user reviews and clicks in the live window. Never submit.`;

  return [
    `Open and fill the external application form for this application using the job-manual skill.`,
    ``,
    `applicationId: ${applicationId}`,
    `Job: ${title} @ ${company}`,
    ``,
    `Use accessibility snapshots (browser_snapshot) and ref-based browser_type/click — never CSS selectors.`,
    stopLine,
  ].join('\n');
}
