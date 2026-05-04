# M11 Bucket 2 — LinkedIn Vertical Slice Design

## Goal

Land a real, end-to-end-tested LinkedIn `SiteAdapter` against a synthetic Fastify fixture site, plus the test scaffolding the future Indeed and Google Jobs fixtures will share. After this bucket: the LinkedIn adapter implements the full M11-subset of `SiteAdapter` with passing tests; nothing in `bootServer` calls it yet. Bucket 3 wires it into the search handler and the login route.

## Decisions (recap)

Four design questions answered during brainstorming, plus three carry-forward notes from Bucket 1's reviewer rounds folded in:

| # | Question | Choice | Rationale |
|---|---|---|---|
| 1 | Test framework for adapter tests | Vitest (continue Bucket 1 pattern) | Pattern continuity; one `pnpm test` command; Playwright Test runner deferred to M15 when its trace/screenshot ergonomics earn their cost |
| 2 | Fixture site lifecycle | Per-suite (`beforeAll` / `afterAll`) | Fixture is immutable across tests; isolation comes from `chromium.launch().newPage()` per test, not server lifecycle; saves ~1s across the planned ~10 tests |
| 3 | `detectApplyMethod` discriminated-union refactor | Nullable URL on manual variant (option C from Q3) | Eliminates auto-with-URL bug class at compile time; keeps degraded "manual but URL extraction failed" outcome valid; refactor is free now (zero implementations) |
| 4 | External-URL detection strategy | Read-only attribute inspection only | Aligns with browser-automation.md §5 line 144 "read-only when possible"; uses Bucket 1's `firstVisible` + `getHref` helpers; popup handling deferred to a later iteration if production data demands it |
| Carry-forward #1 | `firstVisible` no auto-wait | Adapter writes its own `page.waitForSelector(..., { state: 'visible' })` before calling `firstVisible` | Bucket 1 reviewer flagged that `firstVisible` is a snapshot check; readiness is the adapter's responsibility |
| Carry-forward #2 | Discriminated-union refactor | Same as #3 above | Folded in |
| Carry-forward #3 | JSDoc softening on M15 framing | "M15 extends" → "M15 extends and may revisit discovery method shapes if `ApplicationSession` integration requires it" | Minor wording, lands in the same change as the union refactor |

## Scope

**In:**

- LinkedIn `SiteAdapter` implementation at `packages/automation/src/adapters/linkedin.ts` — implements all 8 M11-subset members from Bucket 1's interface
- Selector lists at `packages/automation/src/adapters/linkedin-selectors.ts` — multi-variant arrays for `firstVisible`, mirroring real LinkedIn DOM with cohort fallbacks
- Fastify fixture site at `tests/fixtures/sites/linkedin/` — login/feed/jobs-search/three job-detail pages
- Shared `startFixtureServer` scaffolding helper at `tests/fixtures/start-server.ts` so M12 Indeed and M13 Google fixtures don't duplicate Fastify boot
- Adapter tests at `packages/automation/tests/adapters/linkedin.test.ts` — 10 cases against the fixture
- Discriminated-union refactor of `SiteAdapter.detectApplyMethod` in `adapters/adapter.ts`, with synced spec edits to `docs/browser-automation.md` §3 and `docs/superpowers/specs/2026-05-03-m11-bucket-1-browser-foundation-design.md`
- JSDoc softening on the M15 framing line in `SiteAdapter`

**Out (deferred to later buckets / milestones):**

- Wiring the adapter into the search handler — Bucket 3 Task 9 dispatches by site kind to the registered adapter
- Wiring the login flow — Bucket 3 Task 8 composes `launchSiteContext` (one-shot headful) with the adapter's `onLoginSuccess` predicate
- `vina doctor` browser-binary checks — Bucket 3 Task 10
- Pagination of search results — single-page is enough for M11; multi-page lands when production data shows we're missing listings on common queries
- Click-to-capture for external apply URLs — added if/when read-only inspection misses too many URLs in production
- Real-LinkedIn smoke test — needs an actual account; defer to manual integration testing
- Indeed adapter (M12), Google Jobs source (M13), apply graph (M15)

## File structure

```
tests/                                                NEW
└── fixtures/
    ├── start-server.ts                               Shared Fastify boot helper (~30 lines)
    └── sites/
        └── linkedin/
            ├── server.ts                             startLinkedInFixture (~40 lines)
            ├── pages.ts                              HTML generators per route (~150 lines)
            └── selectors.ts                          Selector strings shared by adapter + fixture (~25 lines)

packages/automation/src/adapters/
├── adapter.ts                                        MODIFY — discriminated union + JSDoc softening (~10 lines diff)
├── linkedin.ts                                       NEW — adapter (~120 lines)
├── linkedin-selectors.ts                             NEW — multi-variant selector arrays (~25 lines)
└── types.ts                                          unchanged

packages/automation/src/index.ts                      MODIFY — re-export linkedInAdapter (~3 lines)

packages/automation/tests/adapters/
└── linkedin.test.ts                                  NEW — 10 cases (~250 lines)

docs/
├── browser-automation.md                             MODIFY — §3 union shape
└── superpowers/specs/2026-05-03-m11-bucket-1...md    MODIFY — same union shape
```

Combined: ~640 source lines, ~250 test lines, ~30 lines of doc edits.

## The interface refactor

`packages/automation/src/adapters/adapter.ts` — replace the existing `detectApplyMethod` signature:

**Before:**
```ts
detectApplyMethod(
  page: Page,
  listing: RawListing,
  signal?: AbortSignal,
): Promise<{ method: 'auto' | 'manual'; externalApplyUrl?: string }>;
```

**After:**
```ts
detectApplyMethod(
  page: Page,
  listing: RawListing,
  signal?: AbortSignal,
): Promise<
  | { method: 'auto' }
  | { method: 'manual'; externalApplyUrl: string | null }
>;
```

Plus the JSDoc softening on the `SiteAdapter` interface header — the line "form-walker methods extend this interface in M15" becomes "form-walker methods extend this interface in M15 and may revisit the discovery method shapes if `ApplicationSession` integration requires it."

The same union shape lands in:
- `docs/browser-automation.md` §3 (the canonical interface description) — replace the existing single-shape return type
- `docs/superpowers/specs/2026-05-03-m11-bucket-1-browser-foundation-design.md` (Component 2 SiteAdapter section) — sync to keep specs honest

## Component 1: LinkedIn fixture site

**Files:**
- `tests/fixtures/sites/linkedin/server.ts` — entry point exposing `startLinkedInFixture(): Promise<LinkedInFixtureHandle>`
- `tests/fixtures/sites/linkedin/pages.ts` — pure functions returning HTML strings per route
- `tests/fixtures/sites/linkedin/selectors.ts` — exported constants imported by both the fixture (when generating HTML) and the adapter tests (for assertions)

**Public API:**

```ts
// server.ts
export interface LinkedInFixtureHandle {
  /** Base URL like `http://127.0.0.1:54321`. */
  url: string;
  /** Same as `url`, named `origin` for clarity at adapter call sites. */
  origin: string;
  close(): Promise<void>;
}

export async function startLinkedInFixture(): Promise<LinkedInFixtureHandle>;
```

The fixture binds to `127.0.0.1:0` so the OS picks an ephemeral free port (loopback only — never reachable off-host during a test run). Two parallel test files don't collide because each gets a distinct port.

**Routes:**

| Route | Response | Adapter test it exercises |
|---|---|---|
| `GET /login` | Login page HTML — `<form action="/login" method="POST">…</form>` | `onLoginSuccess` (false case), `onSessionExpired` (true case) |
| `POST /login` | 302 → `/feed` (always succeeds — fixture doesn't validate credentials) | not directly used; adapter only navigates |
| `GET /feed` | Authed feed HTML — `<h1>Welcome back</h1>` | `onLoginSuccess` (true case), `onSessionExpired` (false case) |
| `GET /jobs/search?keywords=…&location=…` | Search results HTML — 3 listing cards each with `data-job-id`, title, company, location, snippet, and a link to `/jobs/view/<id>` | `search` async iterator |
| `GET /jobs/view/easy` | Detail HTML with `<button data-test-id="jobs-apply-button-id">Easy Apply</button>` plus description and salary | `openListing`, `detectApplyMethod` auto case |
| `GET /jobs/view/ext` | Detail HTML with `<a data-test-id="jobs-apply-button-id" href="https://workday.example/jobs/123">Apply</a>` | `detectApplyMethod` manual-with-URL case |
| `GET /jobs/view/ndi` | Detail HTML with `<button data-test-id="jobs-apply-button-id">Apply</button>` (no href) | `detectApplyMethod` manual-without-URL (degraded) case |

**Why three job-detail variants:** they exercise all three branches of the discriminated-union `detectApplyMethod` return type. That's the test-coverage payoff for the union refactor.

**Selector mirroring:** the fixture generates DOM that uses the same `data-test-id` attributes, class names, and structure that the LinkedIn adapter's selectors target. The exact selectors live in `linkedin-selectors.ts` (adapter side) AND `tests/fixtures/sites/linkedin/selectors.ts` (fixture side) — these are kept in sync manually because the adapter and fixture have different audiences (adapter targets real-LinkedIn-best-effort; fixture targets adapter-test-coverage). A typo in either breaks tests, surfacing the divergence loudly.

## Component 2: LinkedIn adapter

**File:** `packages/automation/src/adapters/linkedin.ts`

**Public API:**

```ts
import type { SiteAdapter } from './adapter.js';

export const linkedInAdapter: SiteAdapter;
```

Plain `const` export per the Bucket 1 design ("adapters as plain object literals" — they hold no closure state).

**Implementation outline:**

```ts
const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

export const linkedInAdapter: SiteAdapter = {
  id: 'linkedin',
  displayName: 'LinkedIn',
  loginUrl: `${LINKEDIN_ORIGIN}/login`,

  async onLoginSuccess(page) {
    return new URL(page.url()).pathname.startsWith('/feed');
  },

  async onSessionExpired(page) {
    return new URL(page.url()).pathname.startsWith('/login');
  },

  async *search(page, prefs, signal) {
    const url = buildSearchUrl(page.url(), prefs);
    await page.goto(url);
    await page.waitForSelector('[data-job-id]', { state: 'visible' });

    const cards = await page.locator('[data-job-id]').all();
    for (const card of cards) {
      const listing = await extractRawListing(card);
      if (listing) yield listing;
      await pause(200, 600, signal);
    }
    // M11: single page only. Pagination lands later if needed.
  },

  async openListing(page, listing) {
    await page.goto(listing.url);
    await page.waitForSelector(JOB_TITLE_SELECTOR, { state: 'visible' });
    const description = await page.locator(JOB_DESCRIPTION_SELECTOR).innerText();
    const salaryText = await readOptional(page, JOB_SALARY_SELECTOR);
    return { description, salaryText };
  },

  async detectApplyMethod(page) {
    // Adapter writes its own readiness wait per Bucket 1 carry-forward #1
    // — `firstVisible` is a snapshot check, not auto-waiting.
    await page.waitForSelector(APPLY_BUTTON_ROOT_SELECTOR, { state: 'visible' });

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
};
```

**Predicate path-based vs full-URL match:** `onLoginSuccess` and `onSessionExpired` use `new URL(page.url()).pathname.startsWith(...)` instead of `page.url().startsWith('https://www.linkedin.com/...')`. This makes the adapter work transparently against:
- Real LinkedIn (`https://www.linkedin.com/feed`)
- The fixture (`http://127.0.0.1:54321/feed`)

Same `/feed` and `/login` paths, different hosts. The path check captures the actual semantic ("am I logged in?") without binding to a specific origin.

**Helper functions** kept private inside `linkedin.ts`:

```ts
function buildSearchUrl(currentUrl: string, prefs: SearchPreferences): string;
async function extractRawListing(card: Locator): Promise<RawListing | null>;
async function readOptional(page: Page, selector: string): Promise<string | null>;
```

`buildSearchUrl` constructs `<origin>/jobs/search?keywords=...&location=...`. `extractRawListing` reads `data-job-id`, title, company text, location text, snippet, posted-at — handling missing fields gracefully (returns null if any required field is absent). `readOptional` returns `locator.innerText()` or null if the locator's count is 0.

## Component 3: Selector lists

**File:** `packages/automation/src/adapters/linkedin-selectors.ts`

```ts
export const APPLY_BUTTON_ROOT_SELECTOR = '[data-test-id="jobs-apply-button-id"]';

export const EASY_APPLY_SELECTORS = [
  'button[data-test-id="jobs-apply-button-id"]:has-text("Easy Apply")',
  'button:has-text("Easy Apply")',  // legacy/alternate cohort
];

export const EXTERNAL_APPLY_SELECTORS = [
  'a[data-test-id="jobs-apply-button-id"]',
  'button[data-test-id="jobs-apply-button-id"]',  // detected as external when text != "Easy Apply"
];

export const JOB_TITLE_SELECTOR = '.jobs-unified-top-card__job-title';
export const JOB_DESCRIPTION_SELECTOR = '.jobs-description';
export const JOB_SALARY_SELECTOR = '.jobs-unified-top-card__job-insight:has-text("$")';
```

Multi-variant arrays for selectors that may render differently across LinkedIn user cohorts. Adapter uses `firstVisible` to try each in order. Single-string selectors for elements that have one canonical form.

The fixture's HTML uses these same selectors (imported directly so a typo breaks the build, not just one test).

## Component 4: Shared fixture-server scaffolding

**File:** `tests/fixtures/start-server.ts`

```ts
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';

export interface FixtureServerHandle {
  url: string;
  origin: string;
  close(): Promise<void>;
}

/**
 * Boot a Fastify app with the given route registrar on an OS-assigned
 * ephemeral port. Returns a handle with the running URL and a cleanup
 * function. Used by `startLinkedInFixture` (and future Indeed / Google
 * fixtures) so each site doesn't duplicate Fastify boot.
 */
export async function startFixtureServer(
  registerRoutes: FastifyPluginAsync,
): Promise<FixtureServerHandle>;
```

~30 lines. Creates a Fastify instance with logging disabled (test noise), registers the caller's routes, listens on `127.0.0.1:0` (loopback + OS-assigned ephemeral port), computes the URL from `server.address()`. Cleanup closes the Fastify instance.

Future M12 Indeed fixture: `tests/fixtures/sites/indeed/server.ts` is then a one-liner wrapping a different route registrar.

## Test plan

**File:** `packages/automation/tests/adapters/linkedin.test.ts`

```ts
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { linkedInAdapter } from '../../src/adapters/linkedin.js';
import { startLinkedInFixture, type LinkedInFixtureHandle } from '../../../../tests/fixtures/sites/linkedin/server.js';

let fixture: LinkedInFixtureHandle;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  fixture = await startLinkedInFixture();
});
afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterEach(async () => {
  await browser.close();
});
```

**Cases (10 total):**

| # | Group | Case | Setup |
|---|---|---|---|
| 1 | login predicates | `onLoginSuccess` returns true on `/feed` | `page.goto(${fixture.url}/feed)` |
| 2 | login predicates | `onLoginSuccess` returns false on `/login` | `page.goto(${fixture.url}/login)` |
| 3 | login predicates | `onSessionExpired` returns true on `/login` | `page.goto(${fixture.url}/login)` |
| 4 | login predicates | `onSessionExpired` returns false on `/feed` | `page.goto(${fixture.url}/feed)` |
| 5 | search | yields `RawListing`s for each card | `page.goto(${fixture.url}/jobs/search?keywords=ts)`; collect from `for await` |
| 6 | search | aborts mid-iteration when signal fires | `AbortController`; abort during the iterator's first `pause`; assert it rejects |
| 7 | openListing | extracts description and salary | `page.goto(${fixture.url}/jobs/view/easy)`; assert returned `JobDetail` shape |
| 8 | detectApplyMethod | returns `{ method: 'auto' }` for Easy Apply | navigate to `/jobs/view/easy`; assert exact discriminated-union shape |
| 9 | detectApplyMethod | returns `{ method: 'manual', externalApplyUrl: 'https://workday.example/...' }` for external-href detail | navigate to `/jobs/view/ext` |
| 10 | detectApplyMethod | returns `{ method: 'manual', externalApplyUrl: null }` for external-no-href detail | navigate to `/jobs/view/ndi` |

**Test 6 (signal abort) shape:**

```ts
const controller = new AbortController();
const iter = linkedInAdapter.search(page, prefs, controller.signal);
const collected: RawListing[] = [];
let rejected: unknown = null;
const consumer = (async () => {
  try {
    for await (const listing of iter) {
      collected.push(listing);
      controller.abort('test-abort'); // fires on first listing
    }
  } catch (err) {
    rejected = err;
  }
})();
await consumer;
expect(rejected).toBe('test-abort');
expect(collected.length).toBeGreaterThanOrEqual(1);
expect(collected.length).toBeLessThan(3); // didn't reach the third listing
```

This exercises the cooperative-shutdown discipline established by `humanise.pause(min, max, signal)` from M11 Task 1.

## Public API exports

`packages/automation/src/index.ts` after this bucket:

```ts
export { launchSiteContext, type LaunchSiteContextOptions } from './browser/launch.js';
export {
  LISTING_MAX_MS,
  LISTING_MIN_MS,
  pause,
  sleepBetweenListings,
} from './browser/humanise.js';
export { type SiteAdapter } from './adapters/adapter.js';
export { type JobDetail, type RawListing } from './adapters/types.js';
export { firstVisible, getHref, isExternalUrl } from './detect/apply-method.js';
export {
  createBrowserManager,
  type BrowserManagerHandle,
  type BrowserManagerOptions,
} from './browser/manager.js';
export { linkedInAdapter } from './adapters/linkedin.js';   // NEW
```

## Integration boundaries (NOT in this bucket)

- **No wiring into `bootServer`.** The adapter exists as an importable singleton; nothing in `main.ts` references it yet. Bucket 3 Task 9 introduces the adapter registry inside the search-handler factory's deps and calls `linkedInAdapter.search(...)` per scheduled tick.
- **No login flow wiring.** Bucket 3 Task 8 composes `launchSiteContext` (one-shot headful) + `linkedInAdapter.onLoginSuccess(page)` directly in the route handler; the adapter exposes the predicate but doesn't drive the flow.
- **No real-LinkedIn smoke test.** A future manual integration test runs the adapter against actual LinkedIn with a real account; that's an M11 follow-up, not part of this bucket. The fixture is the unit-test source of truth.
- **No pagination.** `search` yields the cards on the first results page only. Production may need pagination if `prefs.score_threshold` is high and the user has many listings; that's a small extension to the for-of loop when the need arises.

## What this unblocks

- **Bucket 3 Task 8** (login route) — has `linkedInAdapter.onLoginSuccess` to thread through the WS-driven interactive login flow.
- **Bucket 3 Task 9** (search handler) — has `linkedInAdapter` to dispatch to when a `search` task with `site_id='linkedin'` is claimed. The handler constructs `BrowserManager` (Bucket 1), calls `manager.getContext('linkedin')`, calls `linkedInAdapter.search(page, prefs, signal)`, persists each yielded `RawListing` plus its `openListing`/`detectApplyMethod` results.
- **M12 Indeed adapter** — same shape; just a second `SiteAdapter` implementation against a sibling fixture under `tests/fixtures/sites/indeed/`. The shared `startFixtureServer` helper makes the boot ~5 lines.
- **M15 form-walker** — extends `SiteAdapter` with the deferred 7 methods; LinkedIn implementation file gains those methods alongside the existing 8.

## Integration debt

- The discriminated-union refactor touches three docs in lockstep (interface, browser-automation.md, bucket-1 spec). After this bucket, those three remain in sync — but a future change to `detectApplyMethod`'s return shape will also need to touch all three. Worth a one-line note in [`docs/browser-automation.md`](../../browser-automation.md) §3 saying "this type is also reflected in `packages/automation/src/adapters/adapter.ts` — update both in lockstep."
- The shared `startFixtureServer` helper has no test of its own; it's exercised transitively by `linkedin.test.ts`. When M12 lands and a second fixture exists, consider extracting a 1-2 case test for the helper.
