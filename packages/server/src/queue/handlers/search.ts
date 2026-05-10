import type { Database as DatabaseType } from 'better-sqlite3';
import { createLogger, ValidationError } from '@vina/shared';
import type { BrowserManagerHandle, SiteAdapter } from '@vina/automation';
import { findSiteById, updateSiteSession } from '../../db/repositories/sites.js';
import { insertJob } from '../../db/repositories/jobs.js';
import { enqueue } from '../../db/repositories/task-queue.js';
import { insertAlert } from '../../db/repositories/alerts.js';
import {
  findScheduleById,
  incrementScheduleFailures,
  resetScheduleFailures,
  setSchedulePaused,
} from '../../db/repositories/schedules.js';
import { getOrInitSearchPreferences } from '../../db/repositories/search-preferences.js';
import type { EventBus } from '../../events/bus.js';
import { LinkedInSessionExpiredError } from './errors.js';

const log = createLogger('handler.search');

const FEED_URL = 'https://www.linkedin.com/feed';
const STRIKE_LIMIT = 3;

export interface SearchHandlerDeps {
  db: DatabaseType;
  bus: EventBus;
  browserManager: BrowserManagerHandle;
  adapters: Record<string, SiteAdapter>;
  /** Test seam: overrides the navigation target before the session check. */
  feedUrlOverride?: string;
}

export interface SearchPayload {
  site_id: string;
  /** Only set when a scheduler tick enqueues; manual Search-now omits it. */
  schedule_id?: string;
  /** Optional task id for WS event attribution. */
  task_id?: string;
}

export function createSearchHandler(
  deps: SearchHandlerDeps,
): (payload: SearchPayload) => Promise<void> {
  return async (payload) => {
    const site = findSiteById(deps.db, payload.site_id);
    if (!site) throw new ValidationError(`Unknown site_id: ${payload.site_id}`);

    const adapter = deps.adapters[site.id];
    if (!adapter) throw new ValidationError(`No adapter registered for site: ${site.id}`);

    const prefs = getOrInitSearchPreferences(deps.db);
    deps.bus.emit('search:started', {
      task_id: payload.task_id ?? 'unknown',
      site_id: site.id,
    });

    let listingsAdded = 0;
    let scoredEnqueued = 0;

    try {
      const ctx = await deps.browserManager.getContext(site.id);
      const page = await ctx.newPage();
      try {
        await page.goto(deps.feedUrlOverride ?? FEED_URL);

        if (await adapter.onSessionExpired(page)) {
          throw new LinkedInSessionExpiredError();
        }

        // Buffer the listings before opening detail pages — the search
        // iterator's Locators live on the search-results page, and openListing
        // navigates the same Page away, which would detach later iterations.
        const listings = [];
        for await (const raw of adapter.search(page, prefs)) {
          listings.push(raw);
        }

        for (const raw of listings) {
          try {
            const job = insertJob(deps.db, {
              site_id: site.id,
              external_id: raw.externalId,
              url: raw.url,
              apply_method: 'auto',
              title: raw.title,
              company: raw.company,
              location: raw.location,
              description: raw.snippet ?? '',
              posted_at: raw.postedAt,
            });
            const detail = await adapter.openListing(page, raw);
            const apply = await adapter.detectApplyMethod(page, raw);
            const externalUrl =
              apply.method === 'manual' ? apply.externalApplyUrl : null;
            deps.db
              .prepare(
                `UPDATE jobs
                   SET description = ?, salary_text = ?, apply_method = ?, external_apply_url = ?
                 WHERE id = ?`,
              )
              .run(detail.description, detail.salaryText, apply.method, externalUrl, job.id);
            enqueue(deps.db, { kind: 'score', payload: { job_id: job.id } });
            scoredEnqueued += 1;
            listingsAdded += 1;
            deps.bus.emit('jobs:updated', { ids: [job.id] });
          } catch (err) {
            log.warn(
              { err, externalId: raw.externalId },
              'listing extraction failed; skipping',
            );
          }
        }
      } finally {
        await page.close().catch(() => undefined);
      }

      if (payload.schedule_id) resetScheduleFailures(deps.db, payload.schedule_id);

      updateSiteSession(deps.db, site.id, {
        session_path: site.session_path ?? site.id,
        session_valid_at: new Date().toISOString(),
        last_search_at: new Date().toISOString(),
      });

      deps.bus.emit('search:completed', {
        task_id: payload.task_id ?? 'unknown',
        site_id: site.id,
        listings_added: listingsAdded,
        scored: scoredEnqueued,
      });
    } catch (err) {
      const isSessionExpired = err instanceof LinkedInSessionExpiredError;
      const errorKind = isSessionExpired ? 'session_expired' : 'unknown';
      deps.bus.emit('search:failed', {
        task_id: payload.task_id ?? 'unknown',
        site_id: site.id,
        error_kind: errorKind,
      });

      if (isSessionExpired) {
        insertAlert(deps.db, {
          kind: 'linkedin_session_expired',
          severity: 'action_required',
          title: 'LinkedIn session expired',
          description: 'Re-connect LinkedIn from Settings to resume searches.',
          site_id: site.id,
        });
        deps.bus.emit('linkedin:session-expired', { at: new Date().toISOString() });
      } else {
        insertAlert(deps.db, {
          kind: 'search_failed',
          severity: 'error',
          title: 'Search failed',
          description: err instanceof Error ? err.message : String(err),
          site_id: site.id,
        });
      }

      if (payload.schedule_id) {
        incrementScheduleFailures(deps.db, payload.schedule_id);
        const schedule = findScheduleById(deps.db, payload.schedule_id);
        if (schedule && schedule.consecutive_failures >= STRIKE_LIMIT) {
          setSchedulePaused(deps.db, payload.schedule_id, true);
          insertAlert(deps.db, {
            kind: 'schedule_paused',
            severity: 'action_required',
            title: 'Schedule paused',
            description: '3 consecutive search failures. Re-enable from Settings.',
            site_id: site.id,
          });
        }
      }

      throw err;
    }
  };
}
