import type { Locator, Page } from 'playwright';
import type { SearchPreferences, WorkModel } from '@vina/shared';
import { firstVisible, getHref, isExternalUrl } from '../../detect/apply-method.js';
import { isSessionExpiredOnPage } from '../../detect/session.js';
import { sleepBetweenListings } from '../../browser/humanise.js';
import type { SiteAdapter } from '../adapter.js';
import { actOnSession, snapshotSession } from '../session-actions.js';
import {
  advanceLinkedInStep,
  closeLinkedInApplication,
  fillLinkedInField,
  inspectLinkedInFields,
  startLinkedInApplication,
  submitLinkedInApplication,
  takeLinkedInScreenshot,
  uploadLinkedInCoverLetter,
  uploadLinkedInCv,
} from './application.js';
import { LINKEDIN_SESSION_HEURISTICS } from './heuristics.js';
import type { JobDetail, RawListing } from '../types.js';
import {
  APPLY_BUTTON_ROOT_SELECTOR,
  EASY_APPLY_SELECTORS,
  EXTERNAL_APPLY_SELECTORS,
  JOB_CARD_COMPANY_SELECTOR,
  JOB_CARD_LINK_SELECTOR,
  JOB_CARD_LOCATION_SELECTOR,
  JOB_CARD_POSTED_AT_SELECTOR,
  JOB_CARD_SELECTOR,
  JOB_CARD_SNIPPET_SELECTOR,
  JOB_CARD_TITLE_SELECTORS,
  JOB_DESCRIPTION_SELECTOR,
  JOB_SALARY_SELECTOR,
} from './selectors.js';

const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

// 10s ceiling on readiness waits — surfaces selector drift / anti-bot
// interstitials as a typed Playwright timeout instead of hanging the
// worker for the default 30s.
const SELECTOR_TIMEOUT_MS = 10_000;

/**
 * LinkedIn `f_WT` (work type) filter codes — empirically observed by walking
 * through the live UI, per `docs/linkedin-playwright-automation.md`. The
 * filter is *load-bearing*: present-but-permissive (`f_WT=1,2`) forces
 * LinkedIn to honor the filter and render the SRP rather than collapsing to
 * a single "highlighted match" page, which is what bare `/jobs/search` queries
 * have been doing. Default is Remote+Hybrid (the most common Vina use case);
 * `prefs.work_models` overrides.
 */
const WORK_MODEL_TO_F_WT: Record<WorkModel, string> = {
  remote: '1',
  hybrid: '2',
  onsite: '3',
};
const DEFAULT_F_WT = '1,2';

function fWtFromPrefs(prefs: SearchPreferences): string {
  const codes = new Set<string>();
  for (const wm of prefs.work_models) codes.add(WORK_MODEL_TO_F_WT[wm]);
  if (codes.size === 0) return DEFAULT_F_WT;
  return [...codes].join(',');
}

/**
 * Build the canonical SRP URL. We deliberately do **not** go through
 * LinkedIn's search-bar typeahead (`combobox` autocomplete) because Enter
 * either submits a generic search or no-ops depending on whether autocomplete
 * has resolved — per `docs/linkedin-playwright-automation.md`. The URL-driven
 * approach is 100% reliable as long as a strict filter param is included to
 * prevent single-job collapse.
 *
 * Parameters:
 *   keywords     — from `prefs.keywords`
 *   location     — first of `prefs.locations`
 *   f_WT         — work-type codes from `prefs.work_models` (default remote+hybrid)
 *   f_TPR=r<seconds> — Time Posted Range (`r<seconds>`). Restricts results to
 *                  fresh listings only; secondary effect is that it's a strict
 *                  filter LinkedIn must honor, reinforcing the SRP-rather-than-
 *                  single-job-collapse behaviour. Defaulted to 1 week to match
 *                  the Google Jobs side — narrower windows empty the worklist
 *                  in niche stacks and mid-sized cities. User-configurable via
 *                  Settings is a follow-up; the constant is the seam.
 *   sortBy=DD    — date descending (most recent first)
 *   start=0      — paginated layout (resists single-job collapse)
 */
const POSTED_WITHIN_SECONDS = 7 * 86_400;

function buildSearchUrl(origin: string, prefs: SearchPreferences): string {
  const url = new URL('/jobs/search/', origin);
  if (prefs.keywords.length > 0) {
    url.searchParams.set('keywords', prefs.keywords.join(' '));
  }
  const [firstLocation] = prefs.locations;
  if (firstLocation) {
    url.searchParams.set('location', firstLocation);
  }
  url.searchParams.set('f_WT', fWtFromPrefs(prefs));
  url.searchParams.set('f_TPR', `r${POSTED_WITHIN_SECONDS}`);
  url.searchParams.set('sortBy', 'DD');
  url.searchParams.set('start', '0');
  return url.toString();
}

async function readInner(scope: Locator | Page, selector: string): Promise<string | null> {
  const locator = scope.locator(selector).first();
  if ((await locator.count()) === 0) return null;
  return await locator.innerText();
}

async function readAttr(
  scope: Locator,
  selector: string,
  attr: string,
): Promise<string | null> {
  const locator = scope.locator(selector).first();
  if ((await locator.count()) === 0) return null;
  return await locator.getAttribute(attr);
}

async function readCardTitle(card: Locator): Promise<string | null> {
  for (const selector of JOB_CARD_TITLE_SELECTORS) {
    const text = await readInner(card, selector);
    if (text && text.trim().length > 0) return text.trim();
  }
  // Real-LinkedIn cards expose the title via the primary anchor's
  // aria-label or inner text. Try the job-routing anchors in order: the
  // 2026 AI-search SRP uses `?currentJobId=` links; older cohorts use
  // `/jobs/view/`. Then fall back to any anchor on the card.
  for (const selector of [
    'a[href*="currentJobId="]',
    'a[href*="/jobs/view/"]',
    JOB_CARD_LINK_SELECTOR,
  ]) {
    const aria = await readAttr(card, selector, 'aria-label');
    if (aria && aria.trim().length > 0) return aria.trim();
    const text = await readInner(card, selector);
    if (text && text.trim().length > 0) return text.trim();
  }
  // Last-resort: the card element IS the title-bearing element (e.g. the
  // 2026 AI-search SRP renders each card as a bare <a> with no descendants
  // — the title is the anchor's own aria-label or inner text). The earlier
  // loops only check descendants, so they miss this case.
  const ownAria = await card.getAttribute('aria-label');
  if (ownAria && ownAria.trim().length > 0) return ownAria.trim();
  const ownText = await card.innerText().catch(() => '');
  if (ownText && ownText.trim().length > 0) return ownText.trim();
  return null;
}

/**
 * Extract the LinkedIn job id from any of the formats the adapter sees:
 * `/jobs/view/<id>` (classic + fixture), `?currentJobId=<id>` (2026
 * AI-search), `?jobId=<id>` (older variants). Returns the first match.
 */
function externalIdFromHref(href: string | null): string | null {
  if (!href) return null;
  const view = /\/jobs\/view\/(\d+)/.exec(href);
  if (view) return view[1] ?? null;
  const current = /[?&]currentJobId=(\d+)/.exec(href);
  if (current) return current[1] ?? null;
  const job = /[?&]jobId=(\d+)/.exec(href);
  if (job) return job[1] ?? null;
  return null;
}

async function extractRawListing(card: Locator, baseUrl: string): Promise<RawListing | null> {
  // Prefer explicit data attributes (classic / fixture / mid-2024 cohort);
  // fall back to whatever job id is encoded in any anchor on the card. The
  // 2026 AI-search cards only encode the id via `?currentJobId=<id>` —
  // and when the card IS the anchor itself, the href is on `card` not a
  // descendant, so we check both.
  const cardOwnHref = await card.getAttribute('href');
  const currentJobLinkHref = await readAttr(card, 'a[href*="currentJobId="]', 'href');
  const viewLinkHref = await readAttr(card, 'a[href*="/jobs/view/"]', 'href');
  const externalId =
    (await card.getAttribute('data-occludable-job-id')) ??
    (await card.getAttribute('data-job-id')) ??
    externalIdFromHref(cardOwnHref) ??
    externalIdFromHref(currentJobLinkHref) ??
    externalIdFromHref(viewLinkHref);
  if (!externalId) return null;
  const title = await readCardTitle(card);
  if (!title) return null;
  const company = (await readInner(card, JOB_CARD_COMPANY_SELECTOR)) ?? '';
  const location = await readInner(card, JOB_CARD_LOCATION_SELECTOR);
  const snippet = await readInner(card, JOB_CARD_SNIPPET_SELECTOR);
  const postedAt = await readAttr(card, JOB_CARD_POSTED_AT_SELECTOR, 'datetime');
  // Card-level apply-method signal. The card renders a small "Easy Apply"
  // pill when LinkedIn supports the in-site apply flow; external-redirect
  // jobs don't show this. Reading it here means we get a confident
  // apply-method classification at search time without needing to navigate
  // to the detail page (which costs 5-15s per listing). If the badge
  // element isn't present we don't know yet — return null.
  const cardApplyMethod = await readCardApplyMethod(card);
  // Build a stable URL Vina can re-open later. Prefer a `/jobs/view/` URL
  // (works without a session) over `currentJobId` (which is SPA-state and
  // depends on the user being on /jobs/search-results/). Synthesise a
  // canonical /jobs/view/ URL from the external id when we only have a
  // currentJobId-style link.
  const cardLinkHref = await readAttr(card, JOB_CARD_LINK_SELECTOR, 'href');
  const directHref = viewLinkHref ?? cardLinkHref ?? cardOwnHref ?? currentJobLinkHref;
  const url = directHref && /\/jobs\/view\//.test(directHref)
    ? new URL(directHref, baseUrl).toString()
    : `${LINKEDIN_ORIGIN}/jobs/view/${externalId}/`;
  return {
    externalId,
    title,
    company,
    location,
    url,
    snippet,
    postedAt,
    cardApplyMethod,
  };
}

/**
 * Read the card-level apply-method signal. Looks for an "Easy Apply" pill
 * inside the card via either text content or the `.job-card-container__apply-method`
 * class real LinkedIn uses. Returns `'auto'` (Easy Apply confirmed),
 * `'manual'` (no Easy Apply badge found despite a recognisable apply
 * section), or `null` (couldn't tell — caller decides default).
 */
async function readCardApplyMethod(card: Locator): Promise<'auto' | 'manual' | null> {
  const applyMethodText = await readInner(card, '.job-card-container__apply-method');
  if (applyMethodText !== null) {
    return /easy\s*apply/i.test(applyMethodText) ? 'auto' : 'manual';
  }
  // Fallback for cohorts without the `.job-card-container__apply-method`
  // node: look for the literal "Easy Apply" text anywhere inside the card.
  // If we find it → 'auto'. If the card renders apply-related text but no
  // Easy Apply mention → 'manual'. If nothing readable → null.
  const cardText = await card.innerText().catch(() => '');
  if (!cardText) return null;
  if (/easy\s*apply/i.test(cardText)) return 'auto';
  // If the card has any apply-related text but not Easy Apply, treat as
  // manual. Otherwise we genuinely don't know yet.
  if (/\bapply\b/i.test(cardText)) return 'manual';
  return null;
}

/**
 * LinkedIn `SiteAdapter` — discovery only (M11-subset). Form-walker
 * methods land in M15. Predicates use path-based URL checks so the
 * adapter works against both real LinkedIn and the test fixture (same
 * `/feed` and `/login` paths, different hosts).
 */
export const linkedInAdapter: SiteAdapter = {
  id: 'linkedin',
  displayName: 'LinkedIn',
  loginUrl: `${LINKEDIN_ORIGIN}/login`,

  async onLoginSuccess(page) {
    return new URL(page.url()).pathname.startsWith('/feed');
  },

  async onSessionExpired(page) {
    return isSessionExpiredOnPage(page, LINKEDIN_SESSION_HEURISTICS);
  },

  async *search(page, prefs, signal) {
    // Navigate directly to the SRP. We previously tried the search-bar
    // typeahead (`combobox` autocomplete + Enter) but per
    // `docs/linkedin-playwright-automation.md` that path is unreliable —
    // Enter either submits a generic search or no-ops if autocomplete
    // hasn't resolved. The URL-driven approach is 100% reliable as long as
    // a *strict* filter is present (we use `f_WT`) to prevent LinkedIn
    // from collapsing loose queries to a single highlighted-match page.
    const origin = new URL(page.url()).origin;
    const url = buildSearchUrl(origin, prefs);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      // Race page.goto against the abort signal so the user's Stop click can
      // interrupt a long page load. Without this, page.goto holds the worker
      // hostage for its full timeout (default 30s) before the handler can
      // notice the signal flipped.
      await Promise.race([
        page.goto(url, { waitUntil: 'load' }),
        new Promise<never>((_, reject) => {
          if (!signal) return;
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
      ]);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      // LinkedIn frequently does a client-side redirect mid-load (e.g. to
      // /jobs/search-results/?…), which Playwright reports as
      // `net::ERR_ABORTED; maybe frame was detached?`. Tolerate it as long
      // as we ended up on a LinkedIn page.
      const message = err instanceof Error ? err.message : String(err);
      const aborted = /ERR_ABORTED|frame was detached/.test(message);
      if (!aborted || !page.url().includes('linkedin.com')) {
        throw err;
      }
    }

    // Wait for the SRP cards to render. LinkedIn is a SPA, so `load` fires
    // before the cards exist; we use a generous timeout (30s) because the
    // first hit on /jobs/search/ runs heavy bootstrap JS.
    yield* iterateLinkedInCards(page, JOB_CARD_SELECTOR, signal, 30_000);
  },

  // reason: signal threading lands with the M15 form-walker rework that
  // also revisits this method's signature; for M11 discovery the search
  // loop is the only long-running path that needs cooperative cancel.
  async openListing(page, listing) {
    return openLinkedInListing(page, listing.url);
  },

  async detectApplyMethod(page) {
    await page.waitForSelector(APPLY_BUTTON_ROOT_SELECTOR, {
      state: 'visible',
      timeout: SELECTOR_TIMEOUT_MS,
    });

    const easyApply = await firstVisible(page, EASY_APPLY_SELECTORS);
    if (easyApply) return { method: 'auto' };

    const externalApply = await firstVisible(page, EXTERNAL_APPLY_SELECTORS);
    if (!externalApply) return { method: 'manual', externalApplyUrl: null };

    const href = await getHref(externalApply);
    if (!href || !isExternalUrl(LINKEDIN_ORIGIN, href)) {
      return { method: 'manual', externalApplyUrl: null };
    }
    return { method: 'manual', externalApplyUrl: href };
  },

  // ADR-022: snapshot/act surface. LinkedIn delegates to the shared helper
  // — the deterministic walker (M15) and LLM fallback both speak this API.
  async snapshot(session) {
    return snapshotSession(session);
  },
  async act(session, ref, action, value) {
    return actOnSession(session, ref, action, value);
  },

  // M15 form-driving surface — see `application.ts`.
  startApplication(page, listing) {
    return startLinkedInApplication(page, listing);
  },
  inspectFields(session) {
    return inspectLinkedInFields(session);
  },
  fillField(session, ref, value) {
    return fillLinkedInField(session, ref, value);
  },
  uploadCv(session, path) {
    return uploadLinkedInCv(session, path);
  },
  uploadCoverLetter(session, path) {
    return uploadLinkedInCoverLetter(session, path);
  },
  advanceStep(session) {
    return advanceLinkedInStep(session);
  },
  submit(session) {
    return submitLinkedInApplication(session);
  },
  takeScreenshot(session) {
    return takeLinkedInScreenshot(session);
  },
  closeApplication(session) {
    return closeLinkedInApplication(session);
  },
};

/**
 * Iterate cards on the *current* search-results page using the supplied
 * selector. Exposed separately from `search()` so callers (notably the
 * server's selector-drift fallback) can re-run iteration with a different
 * selector without re-doing the keyword/location input flow.
 *
 * The iteration paces between listings per ADR-013 (4–8s) and is cancellable
 * via the abort signal.
 */
export async function* iterateLinkedInCards(
  page: Page,
  selector: string,
  signal?: AbortSignal,
  waitTimeoutMs: number = SELECTOR_TIMEOUT_MS,
): AsyncIterable<RawListing> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await Promise.race([
    page.waitForSelector(selector, { state: 'visible', timeout: waitTimeoutMs }),
    new Promise<never>((_, reject) => {
      if (!signal) return;
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    }),
  ]);
  const cards = await page.locator(selector).all();
  let isFirst = true;
  for (const card of cards) {
    if (!isFirst) await sleepBetweenListings(signal);
    isFirst = false;
    const listing = await extractRawListing(card, page.url());
    if (listing) yield listing;
  }
}

/**
 * Override selectors for `openLinkedInListing`. Used by the server's
 * detail-page selector-drift fallback to retry extraction with a freshly
 * resolved (LLM or cached) selector when the static defaults miss.
 */
export interface DetailSelectorOverrides {
  titleSelector?: string;
  descriptionSelector?: string;
  salarySelector?: string;
}

/**
 * Navigate to a listing's detail page and extract description + salary.
 * **Forgiving by design**: never throws on selector miss — returns
 * `{ description: '', salaryText: null }` when the page yields nothing.
 * The caller (search handler) treats detail enrichment as best-effort and
 * falls back to card-level snippet for description.
 *
 * Why no strict `waitForSelector` on the title: every miss cost 10s per
 * listing × N listings, blowing past the worker's 5-min task budget with
 * zero successes. `networkidle` is the right gate for "page is rendered
 * enough to read"; it caps at 5s and we tolerate its timeout.
 */
export async function openLinkedInListing(
  page: Page,
  url: string,
  overrides?: DetailSelectorOverrides,
): Promise<JobDetail> {
  const descriptionSelector = overrides?.descriptionSelector ?? JOB_DESCRIPTION_SELECTOR;
  const salarySelector = overrides?.salarySelector ?? JOB_SALARY_SELECTOR;

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Let the SPA settle. networkidle is a strong signal the detail panel
  // has finished loading. Cap at 5s — analytics beacons can keep network
  // un-idle indefinitely, but the page is usable by then.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);

  const description = (await readInner(page, descriptionSelector)) ?? '';
  const salaryText = await readInner(page, salarySelector);
  return { description, salaryText } satisfies JobDetail;
}

/**
 * Compact, LLM-friendly summary of the page. We hand-roll a walk over
 * "interesting" elements (interactive, labelled, list-shaped) and emit
 * pseudo-HTML one element per line — strips classes/styles/scripts so the
 * LLM sees semantic structure without the noise.
 *
 * Keeping this in the adapter package (not the orchestrator) means the
 * adapter owns its own page-state extraction, and the orchestrator stays
 * pure (no Page dependency).
 */
export async function capturePageDomSummary(
  page: Page,
  maxBytes: number = 12_000,
): Promise<string> {
  try {
    const summary = await page.evaluate(() => {
      const SELECTOR =
        'a, button, input, textarea, [role], li, h1, h2, h3, [data-test], [data-job-id], [data-occludable-job-id]';
      const truncate = (s: string, n: number): string =>
        s.length > n ? `${s.slice(0, n)}…` : s;
      // reason: typed any to avoid pulling DOM lib types into the adapter
      // tsconfig — this code only ever runs inside Playwright's page context.
      const doc = (globalThis as { document?: unknown }).document as {
        querySelectorAll(selector: string): { length: number } & {
          [index: number]: unknown;
        };
      };
      const nodes = Array.from(doc.querySelectorAll(SELECTOR) as unknown as ArrayLike<unknown>);
      const lines: string[] = [];
      for (const node of nodes.slice(0, 250)) {
        const el = node as {
          tagName: string;
          getAttribute(name: string): string | null;
          attributes: ArrayLike<{ name: string; value: string }>;
          innerText?: string;
          textContent?: string | null;
        };
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        const aria = el.getAttribute('aria-label');
        const href = el.getAttribute('href');
        const placeholder = el.getAttribute('placeholder');
        const text = truncate(
          (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim(),
          80,
        );
        const dataAttrs: string[] = [];
        for (let i = 0; i < el.attributes.length; i++) {
          const a = el.attributes[i];
          if (!a) continue;
          if (a.name.startsWith('data-')) {
            dataAttrs.push(`${a.name}="${truncate(a.value, 50)}"`);
          }
        }
        const attrs = [
          role ? `role="${role}"` : '',
          aria ? `aria-label="${truncate(aria, 80)}"` : '',
          href ? `href="${truncate(href, 100)}"` : '',
          placeholder ? `placeholder="${truncate(placeholder, 60)}"` : '',
          dataAttrs.join(' '),
        ]
          .filter(Boolean)
          .join(' ');
        lines.push(`<${tag}${attrs ? ` ${attrs}` : ''}>${text}</${tag}>`);
      }
      return lines.join('\n');
    });
    return summary.length > maxBytes ? `${summary.slice(0, maxBytes)}…` : summary;
  } catch {
    return '';
  }
}
