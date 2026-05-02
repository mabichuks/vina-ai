# M11 Bucket 1 — Browser-Kind Foundation Design

## Goal

Land the contracts and helpers that any browser-kind site adapter (LinkedIn in M11, Indeed in M12) needs to do its job: a per-site persistent-context cache (BrowserManager), the SiteAdapter interface, and pure helpers for apply-method detection. Nothing in this bucket talks to a real site, opens a real listing, or wires into `main.ts` — that all comes in Buckets 2 and 3.

## Scope

**In:**

- `BrowserManager` — caches one persistent `BrowserContext` per `siteId` on top of [Task 0's `launchSiteContext`](../../../packages/automation/src/browser/launch.ts). Lifecycle: lazy launch on first request, explicit close, batch close-all for daemon shutdown.
- `SiteAdapter` interface — the M11-subset shape (8 fields/methods) covering discovery: `id`, `displayName`, `loginUrl`, `onLoginSuccess`, `onSessionExpired`, `search`, `openListing`, `detectApplyMethod`. Form-walker methods (M15+) are not included.
- Supporting types — `RawListing`, `JobDetail`. `SearchPreferences` re-uses the existing type from `@vina/shared`.
- Pure helpers in `detect/apply-method.ts` — `firstVisible`, `getHref`, `isExternalUrl`. Adapters compose these with their own selectors.

**Out (deferred to later buckets / milestones):**

- BrowserManager wiring into `bootServer` / `closeAll()` on shutdown — Bucket 3 (Task 9, search handler replacement, will pull this in alongside the handler change).
- `BrowserManager.loginInteractive` and `BrowserManager.isSessionValid` — login flow lives in the route handler (Bucket 3 Task 8), session validity is already on `sites.session_valid_at` in the DB.
- The LinkedIn adapter implementation — Bucket 2 (Task 7), TDD'd against the fixture site.
- A generic config-driven apply-method detector — adapters write their own `detectApplyMethod` body; helpers only provide composable primitives.
- `detect/session.ts` — session-expiry detection is referenced by `onSessionExpired(page)` only; adapter implementations handle it without a shared helper for now.
- Form-walker methods (`startApplication`, `inspectFields`, `fillField`, `uploadCv`, `uploadCoverLetter`, `submit`, `takeScreenshot`) — M15.
- Per-call headless/channel overrides on `BrowserManager.getContext` — the manager takes opts at construction; settings changes take effect at next daemon restart (matches the scheduler's live-refresh deferral from M10).

## File structure

```
packages/automation/src/
├── browser/
│   ├── launch.ts           (existing — Task 0)
│   ├── humanise.ts         (existing — Task 1)
│   └── manager.ts          NEW — BrowserManager (~30 lines)
├── adapters/
│   ├── adapter.ts          NEW — SiteAdapter interface (~25 lines)
│   └── types.ts            NEW — RawListing, JobDetail (~15 lines)
├── detect/
│   └── apply-method.ts     NEW — firstVisible, getHref, isExternalUrl (~25 lines)
└── index.ts                MODIFY — re-export new public API

packages/automation/tests/
├── browser/
│   └── manager.test.ts     NEW — 4 cases against bundled Chromium
└── detect/
    └── apply-method.test.ts NEW — 5 cases (firstVisible matches/none, getHref anchor/non-anchor, isExternalUrl pure)
```

Combined: ~80 source lines, ~120 test lines.

## Component 1: BrowserManager

**Path:** `packages/automation/src/browser/manager.ts`

**Public API:**

```ts
import type { BrowserContext } from 'playwright';

export interface BrowserManagerOptions {
  /** Vina data directory. Persistent profiles live at `<dataDir>/sessions/<siteId>/`. */
  dataDir: string;
  /** Defaults to `true`. Production reads `settings.browser_headful` and inverts. */
  headless?: boolean;
  /**
   * Browser channel — pass `'chrome'` in production for fewer detection
   * signals (per ADR-018). Omit to use Playwright's bundled Chromium.
   */
  channel?: 'chrome' | 'chrome-beta' | 'msedge';
}

export interface BrowserManagerHandle {
  /** Lazy-launch on first call per siteId; cached promise on repeat. */
  getContext(siteId: string): Promise<BrowserContext>;
  /** Close one site's context (e.g. on session-expired recovery). */
  closeContext(siteId: string): Promise<void>;
  /** Close every cached context. Called from daemon shutdown. */
  closeAll(): Promise<void>;
}

export function createBrowserManager(opts: BrowserManagerOptions): BrowserManagerHandle;
```

**Implementation contract:**

- Single internal `Map<string, Promise<BrowserContext>>` cache. Storing the *promise* not the resolved context means concurrent calls dedup — two simultaneous `getContext('linkedin')` await the same `launchSiteContext` invocation, avoiding the "profile already in use" error Playwright throws when two processes touch the same persistent-context dir.
- `getContext(siteId)`: if `cache.has(siteId)`, return the cached promise. Otherwise call `launchSiteContext({ siteId, dataDir: opts.dataDir, headless: opts.headless ?? true, channel: opts.channel })`, store the resulting promise in the cache, return it.
- `closeContext(siteId)`: if cached, remove from the cache, await the stored promise, call `.close()` on the resolved context. No-op if not cached.
- `closeAll()`: snapshot the entries, clear the cache, `Promise.all(entries.map(close))`. Errors during individual closes are not rethrown — they're caught and logged via `createLogger('browser-manager')` so a single wedged context doesn't prevent the others from closing during shutdown.
- Logger module name: `browser-manager`.
- No `bus`, no DB, no other dependencies. Pure on top of `launchSiteContext`.

**Why this shape (vs. the spec's larger surface in `docs/browser-automation.md` §2):** the manager is purely a context cache. Login flow (which the spec puts on the manager) lives in the route handler — it composes `launchSiteContext` (always headful, one-shot) with the adapter's `onLoginSuccess` predicate directly. Session validity is already a column on `sites` and a query on the repo. Putting either concern on the manager would couple it to the adapter registry and the DB; keeping the manager narrow keeps it testable and reusable across login, search, and apply contexts.

## Component 2: SiteAdapter interface

**Paths:**
- `packages/automation/src/adapters/adapter.ts` — the contract
- `packages/automation/src/adapters/types.ts` — supporting data shapes

**Why split:** types in `types.ts` can be imported without pulling in Playwright's `Page` type. A future test util that asserts on a `RawListing` shape doesn't need to depend on the full adapter contract.

**`types.ts` contents:**

```ts
/**
 * What an adapter's `search` iterator yields per listing — the raw header
 * data scraped off the search results page. The adapter calls `openListing`
 * to fetch the full description before classification.
 */
export interface RawListing {
  externalId: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  snippet: string | null;
  /** ISO timestamp parsed from the listing's "X days ago" text, or null. */
  postedAt: string | null;
}

/**
 * The full-detail data fetched from a listing's detail page via
 * `openListing`. Combined with `RawListing` to populate a `jobs` row.
 */
export interface JobDetail {
  description: string;
  salaryText: string | null;
}
```

**`adapter.ts` contents:**

```ts
import type { Page } from 'playwright';
import type { SearchPreferences } from '@vina/shared';
import type { JobDetail, RawListing } from './types.js';

/**
 * Contract for a browser-kind site adapter (LinkedIn in M11, Indeed in
 * M12). M11-subset: discovery only. The form-walker methods
 * (`startApplication`, `inspectFields`, etc.) extend this interface in M15.
 */
export interface SiteAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly loginUrl: string;

  /**
   * True if `page` shows the post-login state (e.g. LinkedIn's `/feed`).
   * Used by the login flow to decide when the interactive login has
   * succeeded.
   */
  onLoginSuccess(page: Page): Promise<boolean>;

  /**
   * True if `page` shows a session-expired state (e.g. redirected to
   * `/login`). Used by adapters during apply or search to detect when
   * the saved session needs re-authentication.
   */
  onSessionExpired(page: Page): Promise<boolean>;

  /**
   * Stream-search results matching the user's preferences. Async iterable
   * so the worker can persist listings as they arrive without buffering.
   * Adapters thread `signal` into their humanise pauses for cooperative
   * shutdown.
   */
  search(
    page: Page,
    prefs: SearchPreferences,
    signal?: AbortSignal,
  ): AsyncIterable<RawListing>;

  /**
   * Navigate to a listing's detail page and extract the full description
   * and salary text. Closes the page (or returns to the previous URL)
   * when done so the caller can reuse the same `Page` for the next call.
   */
  openListing(page: Page, listing: RawListing, signal?: AbortSignal): Promise<JobDetail>;

  /**
   * Classify a listing as `auto` (in-site easy/quick apply) or `manual`
   * (external redirect). Captures the external apply URL when applicable.
   * Read-only when possible — prefer DOM inspection over clicks.
   */
  detectApplyMethod(
    page: Page,
    listing: RawListing,
    signal?: AbortSignal,
  ): Promise<{ method: 'auto' | 'manual'; externalApplyUrl?: string }>;
}
```

**Notes:**

- `id` and `displayName` are `readonly` — adapters are immutable.
- `signal?: AbortSignal` is optional on every `Page`-touching method. Today's adapter implementations may ignore it; Bucket 3 Task 9 (search handler replacement) threads the worker's shutdown signal through to all calls.
- No factory function pattern — each adapter is a plain `const linkedInAdapter: SiteAdapter = { ... }` exported from `adapters/linkedin.ts` (Bucket 2). The codebase's other factory functions (`createWorker`, `createScheduler`) capture closure state — adapters don't, so a literal is cleaner.

## Component 3: apply-method detection helpers

**Path:** `packages/automation/src/detect/apply-method.ts`

```ts
import type { Locator, Page } from 'playwright';

/**
 * Return the first locator from `selectors` that is visible on the page,
 * or null if none match. Selectors are tried in order; first hit wins.
 *
 * Used by adapters to detect apply buttons that may have multiple legacy
 * variants. LinkedIn for example may render `button:has-text("Easy Apply")`
 * or `button[data-testid="jobs-apply-button-id"]:has-text("Easy Apply")`
 * depending on the experiment cohort the user is in.
 */
export async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null>;

/**
 * Read the `href` attribute of the locator's element. Returns null if the
 * element is not an anchor (`<a>`) or has no `href`. Adapters use this to
 * capture an external apply URL without clicking the button (clicks can
 * trigger anti-bot heuristics).
 */
export async function getHref(locator: Locator): Promise<string | null>;

/**
 * True if `url` has a different origin from `siteOrigin`. Pure JS — no
 * Playwright. Used to classify a captured apply URL as in-site (auto) or
 * an external redirect (manual). Throws if `siteOrigin` is malformed.
 */
export function isExternalUrl(siteOrigin: string, url: string): boolean;
```

**Implementation notes:**

- `firstVisible`: tries each selector with `page.locator(s).first()`, awaits `.isVisible()` (with the default short timeout), returns the locator on first match. No retry loop — Playwright's actionability handles transient invisibility.
- `getHref`: `await locator.getAttribute('href')`. Returns `null` cleanly when missing.
- `isExternalUrl`: `new URL(url).origin !== new URL(siteOrigin).origin`. Throws via `URL` constructor on malformed input — caller's responsibility to pass valid URLs (which they will, since both inputs come from Playwright DOM reads).

**Why no generic detector function:** the spec at `docs/browser-automation.md` §5 calls out that LinkedIn may need to *click* a button to capture the external URL via a new tab, while Indeed reads `href` directly. Different behaviour, not just different selectors. A unified config-driven detector would grow options like `clickToCapture: boolean`, `newTabHandling: ...`, `fallbackUrl: ...` — a sign the abstraction is wrong. Adapter-owned `detectApplyMethod` bodies + small helpers gives both sites what they need without contortion.

## Test plan

### BrowserManager (`tests/browser/manager.test.ts`)

Real Chromium tests, like [Task 0's `launch.test.ts`](../../../packages/automation/tests/browser/launch.test.ts). Uses bundled Chromium (no `channel` opt) so CI doesn't need real Chrome.

| # | Case | Approach |
|---|---|---|
| 1 | `getContext` returns a working context, repeat calls return the same one | Call `getContext('test-site')` twice, await both, assert the resolved `BrowserContext` references are `===` (strict-equal). Confirms the cache returns the same instance, not a fresh launch. |
| 2 | `closeContext` removes from cache and closes the context | `getContext` then `closeContext`, then `getContext` again returns a *new* context (different reference) |
| 3 | `closeAll` closes every cached context | Open contexts for two siteIds, `closeAll()`, then `getContext` of each returns new contexts |
| 4 | Concurrent `getContext` calls dedup | `Promise.all([getContext('s'), getContext('s')])` — both resolve to the same context reference; Playwright never sees two `launchPersistentContext` calls for the same profile dir |

Tests use `freshTestDataDir` helper (mkdtemp) for isolation; cleanup in `afterEach`.

### apply-method helpers (`tests/detect/apply-method.test.ts`)

Real Chromium tests for `firstVisible` and `getHref` (need a `Page` with set HTML); pure-JS test for `isExternalUrl`.

| # | Case | Approach |
|---|---|---|
| 1 | `firstVisible` returns the first matching visible locator | `page.setContent('<button id="b1">Apply</button><button id="b2">Easy Apply</button>')`, call `firstVisible(page, ['button:has-text("Easy Apply")', 'button:has-text("Apply")'])` → asserts `await result?.getAttribute('id') === 'b2'` |
| 2 | `firstVisible` returns null when none match | `page.setContent('<div></div>')`, call with selectors that don't match → asserts `result === null` |
| 3 | `getHref` reads anchor href | `setContent('<a href="https://x.com/apply">Apply</a>')` → asserts `'https://x.com/apply'` |
| 4 | `getHref` returns null when no href | `setContent('<a>Apply</a>')` → asserts `null` |
| 5 | `isExternalUrl` truth table | `expect(isExternalUrl('https://linkedin.com', 'https://linkedin.com/jobs')).toBe(false)`; `expect(isExternalUrl('https://linkedin.com', 'https://workday.com/apply')).toBe(true)`. Pure JS, no Playwright. |

### SiteAdapter interface

No runtime tests. TypeScript strict mode with `verbatimModuleSyntax` will catch any implementation that doesn't satisfy the interface at compile time when LinkedIn lands in Bucket 2. A "shape conformance" test (a fake adapter typed as `SiteAdapter`) is implicit — the LinkedIn adapter itself is the conformance test.

## Public API surface

`packages/automation/src/index.ts` after this bucket lands:

```ts
// From M11 Task 0
export { launchSiteContext, type LaunchSiteContextOptions } from './browser/launch.js';

// From M11 Task 1
export {
  LISTING_MAX_MS,
  LISTING_MIN_MS,
  pause,
  sleepBetweenListings,
} from './browser/humanise.js';

// NEW from this bucket
export {
  createBrowserManager,
  type BrowserManagerHandle,
  type BrowserManagerOptions,
} from './browser/manager.js';
export { type SiteAdapter } from './adapters/adapter.js';
export { type JobDetail, type RawListing } from './adapters/types.js';
export { firstVisible, getHref, isExternalUrl } from './detect/apply-method.js';
```

The detection helpers and types are exported because Bucket 2's LinkedIn adapter (which lives in `packages/automation/src/adapters/linkedin.ts`) imports them via the package barrel for path-alias-free internal references, AND because Bucket 3's server-side search handler imports `RawListing`/`SiteAdapter` to type its dispatch dispatch logic.

## What this unblocks

- **Bucket 2 Task 7 (LinkedIn adapter):** has the interface to implement against, the helpers to call, and a manager to fetch contexts from.
- **Bucket 3 Task 8 (login route):** has `SiteAdapter` to type its `adapter` parameter, and uses `launchSiteContext` directly (not via the manager) for the headful one-shot login.
- **Bucket 3 Task 9 (search handler replacement):** has `BrowserManager` to construct in `bootServer`, `closeAll()` to wire into shutdown, and `SiteAdapter`/`RawListing` to type its dispatch signature.
- **M12 (Indeed adapter):** identical shape — just a second `SiteAdapter` implementation in `adapters/indeed.ts`. No interface changes.

## Integration debt

- The manager's `closeAll()` is not yet called from anywhere — Bucket 3 Task 9's `main.ts` modification adds `await browserManager.closeAll()` to the shutdown sequence (between `await worker.stop()` and `await app.close()`).
- No "adapter registry" exists yet (`Record<SiteId, SiteAdapter>` mapping). Bucket 3 Task 9 introduces this inside the search-handler factory's deps — out of scope here because Bucket 1 has only the interface, no implementations to register.
