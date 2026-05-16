import fs from 'node:fs/promises';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { createLogger, ValidationError } from '@vina/shared';
import {
  capturePageDomSummary,
  iterateLinkedInCards,
  type BrowserManagerHandle,
  type Page,
  type SiteAdapter,
} from '@vina/automation';
import type { ResolveSelectorInput, SelectorResult } from '@vina/orchestrator';
import { findSiteById, updateSiteSession, type SiteRow } from '../../db/repositories/sites.js';
import { insertJob } from '../../db/repositories/jobs.js';
import { enqueue, getInFlightScoreJobIds } from '../../db/repositories/task-queue.js';
import { insertAlert } from '../../db/repositories/alerts.js';
import {
  findScheduleById,
  incrementScheduleFailures,
  resetScheduleFailures,
  setSchedulePaused,
} from '../../db/repositories/schedules.js';
import { getOrInitSearchPreferences } from '../../db/repositories/search-preferences.js';
import type { EventBus } from '../../events/bus.js';
import { AbortedError, LinkedInSessionExpiredError } from './errors.js';
import {
  searchGoogleJobs,
  SerpapiKeyInvalidError,
  SerpapiQuotaExhaustedError,
  type GoogleJobsListing,
  type GoogleJobsSearchInput,
} from '../../services/serpapi-service.js';
import { getDecryptedSerpApiKey } from '../../services/settings-service.js';

const log = createLogger('handler.search');

const FEED_URL = 'https://www.linkedin.com/feed';
const STRIKE_LIMIT = 3;

export interface SearchHandlerDeps {
  db: DatabaseType;
  bus: EventBus;
  browserManager: BrowserManagerHandle;
  adapters: Record<string, SiteAdapter>;
  /** Vina data directory — used for diagnostic artefacts (failure screenshots). */
  dataDir?: string;
  /**
   * LLM-driven selector resolver. When the static selector list misses on
   * the SRP, the handler asks this resolver to propose a selector from the
   * page's accessibility tree, then retries iteration. Wired in main.ts via
   * the orchestrator's `runResolveSelector` graph and the active chat model.
   */
  selectorResolver?: (input: ResolveSelectorInput) => Promise<SelectorResult>;
  /** Test seam: overrides the navigation target before the session check. */
  feedUrlOverride?: string;
  /**
   * Test seam for the SerpAPI search iterator. Defaults to `searchGoogleJobs`
   * from `serpapi-service.ts` at runtime.
   */
  serpapiSearch?: (
    input: GoogleJobsSearchInput,
    opts: { apiKey: string; signal?: AbortSignal },
  ) => AsyncIterable<GoogleJobsListing>;
}

interface SelectorCacheFile {
  /** Map of intent key → selector record. */
  intents?: Record<
    string,
    {
      selector: string;
      discovered_at: string;
      confidence?: number;
    }
  >;
}

const SEARCH_CARD_INTENT_KEY = 'linkedin:search-card';

async function loadSelectorCache(dataDir: string): Promise<SelectorCacheFile> {
  try {
    const file = path.join(dataDir, 'selector-cache.json');
    const content = await fs.readFile(file, 'utf-8');
    return JSON.parse(content) as SelectorCacheFile;
  } catch {
    return {};
  }
}

async function saveSelectorCache(
  dataDir: string,
  intentKey: string,
  selector: string,
  confidence?: number,
): Promise<void> {
  try {
    const file = path.join(dataDir, 'selector-cache.json');
    const cache = await loadSelectorCache(dataDir);
    cache.intents = cache.intents ?? {};
    cache.intents[intentKey] = {
      selector,
      discovered_at: new Date().toISOString(),
      ...(confidence !== undefined ? { confidence } : {}),
    };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(cache, null, 2));
  } catch (err) {
    log.warn({ err }, 'failed to save selector cache');
  }
}

/**
 * Try iterating cards with a candidate selector. Returns the listings
 * extracted, or an empty array if the selector matched nothing or threw.
 */
async function tryCardSelector(
  page: Page,
  selector: string,
): Promise<{ listings: import('@vina/automation').RawListing[]; error: Error | null }> {
  const collected: import('@vina/automation').RawListing[] = [];
  try {
    for await (const raw of iterateLinkedInCards(page, selector)) {
      collected.push(raw);
    }
    return { listings: collected, error: null };
  } catch (err) {
    return {
      listings: collected,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

async function captureFailureSnapshot(
  page: Page,
  dataDir: string | undefined,
  siteId: string,
): Promise<string | null> {
  if (!dataDir) return null;
  try {
    const dir = path.join(dataDir, 'debug');
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `search-${siteId}-${stamp}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch (err) {
    log.warn({ err }, 'failed to capture failure screenshot');
    return null;
  }
}

/**
 * Selector-drift probe used when the search returned 0 listings. Counts how
 * many elements match each candidate card selector + dumps the first card's
 * outerHTML so we can update the adapter selectors from real-LinkedIn DOM
 * without round-tripping the user.
 */
const CARD_PROBE_SELECTORS = [
  '[data-occludable-job-id]',
  '[data-job-id]',
  'li:has(a[href*="currentJobId="])',
  'a[href*="currentJobId="]',
  'li:has(a[href*="/jobs/view/"])',
  'a[href*="/jobs/view/"]',
  '[role="listitem"]',
  '[role="article"]',
  'li.scaffold-layout__list-item',
  'li.scaffold-finite-scroll__container-item',
  '[class*="search-results-list__list-item"]',
  '[class*="jobs-search-results-list__list-item"]',
] as const;

async function probeSearchPage(
  page: Page,
): Promise<{
  url: string;
  title: string;
  selectorCounts: Record<string, number>;
  firstCardHtml: string | null;
}> {
  const url = page.url();
  const title = await page.title().catch(() => '<title-fail>');
  const selectorCounts: Record<string, number> = {};
  let firstCardHtml: string | null = null;
  for (const selector of CARD_PROBE_SELECTORS) {
    try {
      const count = await page.locator(selector).count();
      selectorCounts[selector] = count;
      if (count > 0 && firstCardHtml === null) {
        // reason: `el` is a DOM Element inside the page context, but the
        // server tsconfig doesn't include the DOM lib — cast through unknown
        // to a minimal shape rather than pulling in browser globals.
        firstCardHtml = await page
          .locator(selector)
          .first()
          .evaluate((el) => (el as unknown as { outerHTML: string }).outerHTML)
          .then((html: string) => html.slice(0, 4000))
          .catch(() => null);
      }
    } catch {
      selectorCounts[selector] = -1;
    }
  }
  return { url, title, selectorCounts, firstCardHtml };
}

export interface SearchPayload {
  site_id: string;
  /** Only set when a scheduler tick enqueues; manual Search-now omits it. */
  schedule_id?: string;
  /** Optional task id for WS event attribution. */
  task_id?: string;
}

/**
 * Payload as seen by the branch functions: the persisted `SearchPayload`
 * plus a non-persisted `_signal` slot the worker mutates onto the parsed
 * object before invoking the handler. The leading underscore marks it as
 * transient (it is never re-serialized).
 */
type RunPayload = SearchPayload & { _signal?: AbortSignal };

export function createSearchHandler(
  deps: SearchHandlerDeps,
): (payload: SearchPayload) => Promise<void> {
  return async (payload) => {
    const p = payload as RunPayload;
    const site = findSiteById(deps.db, p.site_id);
    if (!site) throw new ValidationError(`Unknown site_id: ${p.site_id}`);

    if (site.kind === 'api') return runApiSearch(deps, site, p);

    const adapter = deps.adapters[site.id];
    if (!adapter) throw new ValidationError(`No adapter registered for site: ${site.id}`);
    return runBrowserSearch(deps, site, adapter, p);
  };
}

// ---------------------------------------------------------------------------
// Browser-kind sites (LinkedIn, Indeed)
// ---------------------------------------------------------------------------

async function runBrowserSearch(
  deps: SearchHandlerDeps,
  site: SiteRow,
  adapter: SiteAdapter,
  payload: RunPayload,
): Promise<void> {
  const signal = payload._signal;
  const prefs = getOrInitSearchPreferences(deps.db);
  deps.bus.emit('search:started', {
    task_id: payload.task_id ?? 'unknown',
    site_id: site.id,
  });

  let listingsAdded = 0;
  let scoredEnqueued = 0;
  let snapshotForFailure: string | null = null;
  let zeroListingsDiagnostics: Awaited<ReturnType<typeof probeSearchPage>> | null = null;
  let zeroListingsScreenshot: string | null = null;

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
      let listings: import('@vina/automation').RawListing[] = [];

      /**
       * Try cached selector → LLM resolver → fresh cache write. Returns
       * the extracted listings, or [] if neither path produced any.
       * Inline-defined so it captures `page`, `site`, `deps`.
       */
      const recoverViaSelectorResolver = async (): Promise<
        import('@vina/automation').RawListing[]
      > => {
        if (site.id !== 'linkedin' || !deps.dataDir) return [];
        const cache = await loadSelectorCache(deps.dataDir);
        const cached = cache.intents?.[SEARCH_CARD_INTENT_KEY]?.selector;

        if (cached) {
          const cachedTry = await tryCardSelector(page, cached);
          if (cachedTry.listings.length > 0) {
            log.info(
              { selector: cached, count: cachedTry.listings.length },
              'selector-drift recovery: cached selector matched',
            );
            return cachedTry.listings;
          }
        }

        if (!deps.selectorResolver) return [];
        try {
          const domSummary = await capturePageDomSummary(page);
          const resolved = await deps.selectorResolver({
            intent:
              'job-listing cards on the LinkedIn search-results page — each card represents one listing the user can click to view',
            pageUrl: page.url(),
            pageTitle: await page.title().catch(() => ''),
            domSummary,
          });
          log.info(
            { selector: resolved.selector, confidence: resolved.confidence },
            'selector-drift recovery: LLM proposed selector',
          );
          const llmTry = await tryCardSelector(page, resolved.selector);
          if (llmTry.listings.length > 0) {
            await saveSelectorCache(
              deps.dataDir,
              SEARCH_CARD_INTENT_KEY,
              resolved.selector,
              resolved.confidence,
            );
            return llmTry.listings;
          }
          log.warn(
            { selector: resolved.selector },
            'LLM selector matched nothing on retry',
          );
        } catch (llmErr) {
          log.warn({ err: llmErr }, 'LLM selector resolution failed');
        }
        return [];
      };

      try {
        for await (const raw of adapter.search(page, prefs)) {
          if (signal?.aborted) break;
          listings.push(raw);
        }
        // SUCCESS PATH but yielded nothing — common when the static selector
        // matched something visually card-shaped but `extractRawListing`
        // couldn't extract a usable id/title (e.g. the bare anchor on the
        // 2026 AI-search SRP). Run the same recovery flow.
        if (!signal?.aborted && listings.length === 0) {
          const recovered = await recoverViaSelectorResolver();
          if (recovered.length > 0) listings = recovered;
        }
      } catch (err) {
        // If the user cancelled mid-iteration, the iterator may throw because
        // its underlying page was closed or the loop body raced the abort.
        // Skip the recovery/diagnostics path and let the post-loop abort
        // branch emit `search:cancelled` instead of a misleading error alert.
        if (!signal?.aborted) {
          if (await adapter.onSessionExpired(page)) {
            throw new LinkedInSessionExpiredError();
          }
          const recovered = await recoverViaSelectorResolver();
          if (recovered.length > 0) {
            listings = recovered;
          } else {
            snapshotForFailure = await captureFailureSnapshot(page, deps.dataDir, site.id);
            zeroListingsDiagnostics = await probeSearchPage(page);
            zeroListingsScreenshot = snapshotForFailure;
            throw err;
          }
        }
      }

      // Snapshot the in-flight score-task set before iterating. We use
      // this to skip enqueueing a duplicate score for any job that already
      // has one pending or running. Tracked locally so concurrent insertJob
      // calls in this loop also dedupe against each other.
      const inFlightScoreIds = getInFlightScoreJobIds(deps.db);
      const updatedJobIds: string[] = [];

      for (const raw of listings) {
        if (signal?.aborted) break;
        // Search-pass keeps it cheap: insertJob with card-level data, then
        // enqueue score. No detail-page navigation, no apply-method
        // classification here — both burn 5–15s per listing of strict
        // selector waits that don't matter at score time. Apply-method
        // classification matters at apply-time (M14/M15); it can run as a
        // separate task when the user actually picks a job.
        //
        // `apply_method` comes from the card itself when present;
        // otherwise default to 'manual' (most LinkedIn jobs redirect
        // externally, so 'manual' produces fewer visible mislabels than
        // a blanket 'auto' default).
        const applyMethod = raw.cardApplyMethod ?? 'manual';
        let job;
        try {
          job = insertJob(deps.db, {
            site_id: site.id,
            external_id: raw.externalId,
            url: raw.url,
            apply_method: applyMethod,
            title: raw.title,
            company: raw.company,
            location: raw.location,
            description: raw.snippet ?? '',
            posted_at: raw.postedAt,
          });
        } catch (err) {
          log.warn(
            { err, externalId: raw.externalId },
            'insertJob failed; skipping listing',
          );
          continue;
        }

        // Idempotent score enqueue. Skip when:
        //   - job already has a score task in flight (pending/running), OR
        //   - job has already been scored (status !== 'new') — the search
        //     just re-encountered an existing listing and re-scoring would
        //     overwrite a valid score with a fresh LLM call for no gain.
        // The `listingsAdded` counter still increments so the "Search
        // returned 0 listings" alert doesn't fire when the search worked
        // but everything is up to date.
        listingsAdded += 1;
        updatedJobIds.push(job.id);
        if (job.status !== 'new') continue;
        if (inFlightScoreIds.has(job.id)) continue;
        enqueue(deps.db, { kind: 'score', payload: { job_id: job.id } });
        inFlightScoreIds.add(job.id);
        scoredEnqueued += 1;
      }

      // Single batched event — emitting per-listing caused each connected
      // client to refetch /api/jobs once per discovery (25× per SRP).
      if (updatedJobIds.length > 0) {
        deps.bus.emit('jobs:updated', { ids: updatedJobIds });
      }

      // Capture diagnostics BEFORE the page closes if extraction yielded
      // nothing — selectors drifted, or LinkedIn served a non-search page.
      // Skip when aborted: zero listings is the expected shape of a cancel.
      if (!signal?.aborted && listingsAdded === 0) {
        zeroListingsDiagnostics = await probeSearchPage(page);
        zeroListingsScreenshot = await captureFailureSnapshot(
          page,
          deps.dataDir,
          site.id,
        );
        log.warn(
          {
            url: zeroListingsDiagnostics.url,
            title: zeroListingsDiagnostics.title,
            counts: zeroListingsDiagnostics.selectorCounts,
            firstCardHtmlLength: zeroListingsDiagnostics.firstCardHtml?.length ?? 0,
            screenshot: zeroListingsScreenshot,
          },
          'search returned 0 listings — selector probe',
        );
      }
    } finally {
      await page.close().catch(() => undefined);
    }

    if (signal?.aborted) {
      deps.bus.emit('search:cancelled', {
        task_id: payload.task_id ?? 'unknown',
        site_id: site.id,
        listings_added: listingsAdded,
        scored: scoredEnqueued,
      });
      throw new AbortedError();
    }

    if (payload.schedule_id) resetScheduleFailures(deps.db, payload.schedule_id);

    updateSiteSession(deps.db, site.id, {
      session_path: site.session_path ?? site.id,
      session_valid_at: new Date().toISOString(),
      last_search_at: new Date().toISOString(),
    });

    if (listingsAdded === 0) {
      const counts = zeroListingsDiagnostics?.selectorCounts ?? {};
      const summary = Object.entries(counts)
        .map(([sel, n]) => `${sel}: ${n}`)
        .join('  |  ');
      const description = [
        'LinkedIn loaded but no job cards were extracted.',
        zeroListingsDiagnostics?.url ? `URL: ${zeroListingsDiagnostics.url}` : '',
        zeroListingsDiagnostics?.title ? `Page title: ${zeroListingsDiagnostics.title}` : '',
        summary ? `Selector probe — ${summary}` : '',
        zeroListingsScreenshot ? `Screenshot: ${zeroListingsScreenshot}` : '',
        'Open the screenshot or share the daemon log block tagged "search returned 0 listings — selector probe" to update selectors.',
      ]
        .filter(Boolean)
        .join('\n');
      insertAlert(deps.db, {
        kind: 'search_failed',
        severity: 'action_required',
        title: 'Search returned 0 listings',
        description,
        site_id: site.id,
        payload: {
          url: zeroListingsDiagnostics?.url ?? null,
          page_title: zeroListingsDiagnostics?.title ?? null,
          selector_counts: counts,
          first_card_html: zeroListingsDiagnostics?.firstCardHtml ?? null,
          screenshot: zeroListingsScreenshot,
        },
      });
    }

    deps.bus.emit('search:completed', {
      task_id: payload.task_id ?? 'unknown',
      site_id: site.id,
      listings_added: listingsAdded,
      scored: scoredEnqueued,
    });
  } catch (err) {
    // Cancellation is not a failure — the search:cancelled event has already
    // been emitted above. Rethrow so the worker maps it to a `cancelled`
    // row, but skip alert insertion and schedule-failure accounting.
    if (err instanceof AbortedError) throw err;
    if (
      (err instanceof Error && err.name === 'AbortError') ||
      signal?.aborted
    ) {
      deps.bus.emit('search:cancelled', {
        task_id: payload.task_id ?? 'unknown',
        site_id: site.id,
        listings_added: listingsAdded,
        scored: scoredEnqueued,
      });
      throw new AbortedError();
    }
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
      const raw = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout|Timeout|waitForSelector/.test(raw);
      const counts = zeroListingsDiagnostics?.selectorCounts ?? {};
      const summary = Object.entries(counts)
        .map(([sel, n]) => `${sel}: ${n}`)
        .join('  |  ');
      const description = [
        isTimeout
          ? 'LinkedIn took too long to render results. This usually means the headless browser got blocked, your session is stale, or LinkedIn changed selectors.'
          : raw,
        zeroListingsDiagnostics?.url ? `URL: ${zeroListingsDiagnostics.url}` : '',
        zeroListingsDiagnostics?.title ? `Page title: ${zeroListingsDiagnostics.title}` : '',
        summary ? `Selector probe — ${summary}` : '',
        snapshotForFailure ? `Screenshot: ${snapshotForFailure}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      insertAlert(deps.db, {
        kind: 'search_failed',
        severity: 'error',
        title: 'Search failed',
        description,
        site_id: site.id,
        payload: {
          raw,
          snapshot: snapshotForFailure,
          url: zeroListingsDiagnostics?.url ?? null,
          page_title: zeroListingsDiagnostics?.title ?? null,
          selector_counts: counts,
          first_card_html: zeroListingsDiagnostics?.firstCardHtml ?? null,
        },
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
}

// ---------------------------------------------------------------------------
// API-kind sites (Google Jobs via SerpAPI)
// ---------------------------------------------------------------------------

async function runApiSearch(
  deps: SearchHandlerDeps,
  site: SiteRow,
  payload: RunPayload,
): Promise<void> {
  const signal = payload._signal;
  const prefs = getOrInitSearchPreferences(deps.db);
  deps.bus.emit('search:started', { task_id: payload.task_id ?? 'unknown', site_id: site.id });

  const apiKey = getDecryptedSerpApiKey(deps.db);
  if (!apiKey) {
    insertAlert(deps.db, {
      kind: 'serpapi_key_missing',
      severity: 'action_required',
      title: 'SerpAPI key missing',
      description:
        'Google Jobs is enabled but no SerpAPI key is configured. Add one in Settings → Sites.',
      site_id: site.id,
    });
    deps.bus.emit('search:failed', {
      task_id: payload.task_id ?? 'unknown',
      site_id: site.id,
      error_kind: 'unknown',
    });
    if (payload.schedule_id) incrementScheduleFailures(deps.db, payload.schedule_id);
    throw new ValidationError('SerpAPI key not configured');
  }

  const searchImpl = deps.serpapiSearch ?? searchGoogleJobs;
  // Google Jobs is keyword-only. `prefs.description` is a long natural-language
  // paragraph used by the scoring LLM — concatenating it onto the query string
  // produces a query Google rejects as "no results". Match the LinkedIn
  // adapter's behaviour and feed only `prefs.keywords`. The role description
  // still influences which listings *match* (via the score handler downstream).
  const input: GoogleJobsSearchInput = {
    keywords: prefs.keywords.filter(Boolean).join(' ') || prefs.description,
    location: prefs.locations[0],
  };

  let listingsAdded = 0;
  let scoredEnqueued = 0;
  const inFlightScoreIds = getInFlightScoreJobIds(deps.db);
  const updatedJobIds: string[] = [];

  try {
    // Check before opening the iterator so a pre-aborted controller persists
    // zero jobs and emits an empty `search:cancelled` payload — the route
    // can throw the cancellation away cleanly without ever hitting SerpAPI.
    if (signal?.aborted) {
      deps.bus.emit('search:cancelled', {
        task_id: payload.task_id ?? 'unknown',
        site_id: site.id,
        listings_added: 0,
        scored: 0,
      });
      throw new AbortedError();
    }

    for await (const listing of searchImpl(input, { apiKey, signal })) {
      if (signal?.aborted) break;
      try {
        const job = insertJob(deps.db, {
          site_id: site.id,
          external_id: listing.external_id,
          url: listing.apply_url,
          external_apply_url: listing.apply_url,
          apply_method: 'manual',
          original_source: listing.via,
          title: listing.title,
          company: listing.company,
          location: listing.location,
          description: listing.description,
          salary_text: listing.salary_text,
        });
        listingsAdded += 1;
        updatedJobIds.push(job.id);
        if (job.status !== 'new') continue;
        if (inFlightScoreIds.has(job.id)) continue;
        enqueue(deps.db, { kind: 'score', payload: { job_id: job.id } });
        inFlightScoreIds.add(job.id);
        scoredEnqueued += 1;
      } catch (err) {
        log.warn({ err, external_id: listing.external_id }, 'google: insertJob failed; skipping');
      }
    }

    if (signal?.aborted) {
      // Mid-iteration cancel: emit a snapshot of what landed, then bail.
      // updatedJobIds is intentionally NOT broadcast because the UI sees
      // the cancel event and refreshes the jobs list off of it.
      if (updatedJobIds.length > 0) deps.bus.emit('jobs:updated', { ids: updatedJobIds });
      deps.bus.emit('search:cancelled', {
        task_id: payload.task_id ?? 'unknown',
        site_id: site.id,
        listings_added: listingsAdded,
        scored: scoredEnqueued,
      });
      throw new AbortedError();
    }

    if (updatedJobIds.length > 0) deps.bus.emit('jobs:updated', { ids: updatedJobIds });
    if (payload.schedule_id) resetScheduleFailures(deps.db, payload.schedule_id);
    updateSiteSession(deps.db, site.id, {
      last_search_at: new Date().toISOString(),
    });
    deps.bus.emit('search:completed', {
      task_id: payload.task_id ?? 'unknown',
      site_id: site.id,
      listings_added: listingsAdded,
      scored: scoredEnqueued,
    });
  } catch (err) {
    if (err instanceof AbortedError) throw err;

    // A native AbortError out of fetch means the user clicked Stop while a
    // SerpAPI request was in flight. Translate to the cancellation contract:
    // emit search:cancelled with current counts and throw AbortedError so the
    // worker maps the row to 'cancelled' (not 'failed' + alert).
    if (
      (err instanceof Error && err.name === 'AbortError') ||
      signal?.aborted
    ) {
      deps.bus.emit('search:cancelled', {
        task_id: payload.task_id ?? 'unknown',
        site_id: site.id,
        listings_added: listingsAdded,
        scored: scoredEnqueued,
      });
      throw new AbortedError();
    }

    const alertKind =
      err instanceof SerpapiKeyInvalidError
        ? 'serpapi_key_invalid'
        : err instanceof SerpapiQuotaExhaustedError
          ? 'serpapi_quota_exhausted'
          : 'search_failed';
    const severity =
      err instanceof SerpapiQuotaExhaustedError ? 'info' : 'action_required';
    insertAlert(deps.db, {
      kind: alertKind,
      severity,
      title:
        err instanceof SerpapiKeyInvalidError
          ? 'SerpAPI key rejected'
          : err instanceof SerpapiQuotaExhaustedError
            ? 'SerpAPI quota exhausted'
            : 'Google Jobs search failed',
      description: err instanceof Error ? err.message : String(err),
      site_id: site.id,
    });
    deps.bus.emit('search:failed', {
      task_id: payload.task_id ?? 'unknown',
      site_id: site.id,
      error_kind: 'unknown',
    });
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
}
