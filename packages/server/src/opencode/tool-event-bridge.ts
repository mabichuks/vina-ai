import type { Database as DatabaseType } from 'better-sqlite3';
import type { ApplicationEventKind } from '@vina/shared';
import type { SessionToolEvent } from './session-driver.js';
import { appendEvent } from '../db/repositories/application-events.js';

/**
 * The external form-fill event bridge (issue #21): mirrors the `vina-manual`
 * session's browser tool calls onto `application_events` so the activity log
 * (#27) can render a per-application timeline. The bridge is a pure mapping —
 * it never drives the browser, never submits, and never invents events; it only
 * translates an observed tool sequence into audit rows.
 *
 * `vina_external_submit` writes its own terminal `external_submitted` event (it
 * is a gated Vina tool, not a browser MCP call), so no browser tool here maps
 * to `external_submitted`.
 */

/**
 * Map a flattened tool name to an external event kind. Names are normalised by
 * stripping the MCP/`browser_` namespace prefixes so `playwright_browser_type`,
 * `browser_type`, and `playwright_type` all map consistently.
 *
 * - navigation/snapshot → `external_form_opened`
 * - a field write (type/fill/click/select/check/upload) → `external_field_filled`
 * - anything else (incl. a submit click) → `null` (not an external event)
 */
export function externalToolEventKind(tool: string): ApplicationEventKind | null {
  const name = tool.replace(/^playwright_/, '').replace(/^browser_/, '');

  if (name === 'navigate' || name === 'snapshot') return 'external_form_opened';
  if (
    name === 'type' ||
    name === 'fill' ||
    name === 'fill_form' ||
    name === 'click' ||
    name === 'select_option' ||
    name === 'check' ||
    name === 'uncheck' ||
    name === 'file_upload'
  ) {
    return 'external_field_filled';
  }
  return null;
}

/**
 * Append `application_events` rows for each observed browser tool call whose
 * name maps to an external event kind. Non-matching tools are skipped. The
 * payload carries the tool's raw input (ref + value + source) so the activity
 * log can show what was filled.
 */
export function bridgeExternalToolEvents(
  db: DatabaseType,
  applicationId: string,
  events: SessionToolEvent[],
): void {
  for (const event of events) {
    const kind = externalToolEventKind(event.tool);
    if (!kind) continue;
    appendEvent(db, {
      application_id: applicationId,
      kind,
      ...(event.input !== undefined ? { payload: event.input } : {}),
    });
  }
}
