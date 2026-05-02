# M11 Bucket 1 — Browser-Kind Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the three foundational pieces every M11 browser-kind adapter needs — `SiteAdapter` interface + supporting types, pure apply-method detection helpers, and a `BrowserManager` that caches persistent contexts per site — without wiring any of them into the daemon yet.

**Architecture:** Three small, independent modules in `packages/automation/`. The interface and types are types-only (compile-time checked). The apply-method helpers are pure-ish wrappers over Playwright primitives. The BrowserManager wraps Task 0's `launchSiteContext` with a dedup'd promise cache and an `await-and-close` lifecycle. All three are exported from `@vina/automation`'s barrel for Bucket 2 + 3 consumers.

**Tech Stack:** TypeScript (strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), Playwright 1.x, Vitest. Live-tested against bundled Chromium (the binary is already installed locally in M11 Task 0; CI installs it in the workflow step we just added).

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `packages/automation/src/adapters/types.ts` (new) | `RawListing`, `JobDetail` data shapes | 1 |
| `packages/automation/src/adapters/adapter.ts` (new) | `SiteAdapter` interface | 1 |
| `packages/automation/src/detect/apply-method.ts` (new) | `firstVisible`, `getHref`, `isExternalUrl` | 2 |
| `packages/automation/tests/detect/apply-method.test.ts` (new) | 5 cases against bundled Chromium + pure JS | 2 |
| `packages/automation/src/browser/manager.ts` (new) | `createBrowserManager` factory + types | 3 |
| `packages/automation/tests/browser/manager.test.ts` (new) | 4 cases against bundled Chromium | 3 |
| `packages/automation/src/index.ts` (modify) | Re-export new public API; touched in each task | 1, 2, 3 |

Combined: ~80 source lines, ~120 test lines. Three commits — one per task.

---

## Task 1: SiteAdapter interface and supporting types

**Files:**
- Create: `packages/automation/src/adapters/types.ts`
- Create: `packages/automation/src/adapters/adapter.ts`
- Modify: `packages/automation/src/index.ts`

This task has no runtime tests — TypeScript strict mode is the test. Verification is `pnpm --filter @vina/automation typecheck` plus `pnpm --filter @vina/automation build`.

- [ ] **Step 1: Create the data-shape types**

Write `packages/automation/src/adapters/types.ts`:

```ts
/**
 * The raw header data an adapter's `search` iterator yields per listing —
 * what's visible on the search results page before the detail page is
 * fetched. Combined with `JobDetail` (from `openListing`) to populate a
 * full `jobs` row.
 */
export interface RawListing {
  externalId: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  snippet: string | null;
  /** ISO timestamp parsed from "X days ago" listing text, or null when absent. */
  postedAt: string | null;
}

/**
 * The detail-page data fetched via `SiteAdapter.openListing`. Adapters
 * close (or navigate away from) the detail page before returning so the
 * caller can reuse the same `Page` for the next listing.
 */
export interface JobDetail {
  description: string;
  salaryText: string | null;
}
```

- [ ] **Step 2: Create the SiteAdapter interface**

Write `packages/automation/src/adapters/adapter.ts`:

```ts
import type { Page } from 'playwright';
import type { SearchPreferences } from '@vina/shared';
import type { JobDetail, RawListing } from './types.js';

/**
 * Contract for a browser-kind site adapter (LinkedIn in M11, Indeed in
 * M12). M11-subset: discovery only — `id`, `loginUrl`, the predicates,
 * `search`, `openListing`, and `detectApplyMethod`. The form-walker
 * methods (`startApplication`, `inspectFields`, `fillField`, `uploadCv`,
 * `uploadCoverLetter`, `submit`, `takeScreenshot`) extend this interface
 * in M15 when `ApplicationSession` and `FormField` types can be designed
 * with full context.
 *
 * Adapter implementations are plain `const` exports (no factory needed —
 * adapters hold no closure state); they import helpers from
 * `detect/apply-method.ts` and `browser/humanise.ts` directly.
 */
export interface SiteAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly loginUrl: string;

  /**
   * True when `page` shows the post-login state (e.g. LinkedIn's `/feed`
   * URL, Indeed's account menu). The login route polls this until it
   * returns true (or the user cancels).
   */
  onLoginSuccess(page: Page): Promise<boolean>;

  /**
   * True when `page` shows a session-expired state (redirected to login,
   * presence of an unauthenticated landing element). Adapters check this
   * during search/apply to detect when the saved session needs
   * re-authentication.
   */
  onSessionExpired(page: Page): Promise<boolean>;

  /**
   * Stream-search results matching the user's preferences. Async iterable
   * so the worker can persist listings as they arrive without buffering.
   * Adapters thread `signal` into their humanise pauses for cooperative
   * shutdown — the worker's stop signal interrupts mid-iteration.
   */
  search(
    page: Page,
    prefs: SearchPreferences,
    signal?: AbortSignal,
  ): AsyncIterable<RawListing>;

  /**
   * Navigate to the listing's detail page and extract description +
   * salary. Adapters return the page to a clean state (close tab or
   * navigate back) so the caller can reuse `page` for the next listing.
   */
  openListing(page: Page, listing: RawListing, signal?: AbortSignal): Promise<JobDetail>;

  /**
   * Classify the listing as `auto` (in-site easy/quick apply) or `manual`
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

- [ ] **Step 3: Add exports to `index.ts`**

Modify `packages/automation/src/index.ts`. Current contents (after M11 Task 1):

```ts
export { launchSiteContext, type LaunchSiteContextOptions } from './browser/launch.js';
export {
  LISTING_MAX_MS,
  LISTING_MIN_MS,
  pause,
  sleepBetweenListings,
} from './browser/humanise.js';
```

Append:

```ts
export { type SiteAdapter } from './adapters/adapter.js';
export { type JobDetail, type RawListing } from './adapters/types.js';
```

Final file contents:

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
```

- [ ] **Step 4: Verify**

Run each and confirm clean exit:

```bash
pnpm --filter @vina/automation typecheck
pnpm --filter @vina/automation build
pnpm test
pnpm lint
```

Expected:
- `typecheck`: clean (no output beyond the `tsc -p` line)
- `build`: clean; `packages/automation/dist/adapters/adapter.js` and `packages/automation/dist/adapters/types.js` exist (TS emits declaration-only output for type-only files, so `.d.ts` companions should also exist)
- `pnpm test`: still 163/163 passing — this task adds no runtime tests, so the count is unchanged
- `pnpm lint`: clean

If any fails, do NOT commit. The most likely failure is a typo in an import or export — re-read the diff before fixing.

- [ ] **Step 5: Commit**

```bash
git add packages/automation/src/adapters/types.ts \
        packages/automation/src/adapters/adapter.ts \
        packages/automation/src/index.ts
git commit -m "feat(automation): add SiteAdapter interface and supporting types"
```

**IMPORTANT:** plain `git commit -m`, no `Claude` byline / `Co-Authored-By` / `🤖` / `Generated with` substring.

---

## Task 2: apply-method detection helpers

**Files:**
- Create: `packages/automation/src/detect/apply-method.ts`
- Create: `packages/automation/tests/detect/apply-method.test.ts`
- Modify: `packages/automation/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/automation/tests/detect/apply-method.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { firstVisible, getHref, isExternalUrl } from '../../src/detect/apply-method.js';

let browser: Browser;
let page: Page;

beforeEach(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterEach(async () => {
  await browser.close();
});

describe('firstVisible', () => {
  it('returns the first matching visible locator (selector order wins)', async () => {
    await page.setContent(`
      <button id="b1">Apply</button>
      <button id="b2">Easy Apply</button>
    `);
    const result = await firstVisible(page, [
      'button:has-text("Easy Apply")',
      'button:has-text("Apply")',
    ]);
    expect(result).not.toBeNull();
    expect(await result?.getAttribute('id')).toBe('b2');
  });

  it('returns null when no selector matches', async () => {
    await page.setContent('<div></div>');
    const result = await firstVisible(page, [
      'button:has-text("Apply")',
      'a.apply-link',
    ]);
    expect(result).toBeNull();
  });
});

describe('getHref', () => {
  it('reads the href attribute from an anchor', async () => {
    await page.setContent('<a href="https://workday.com/apply">Apply</a>');
    const link = page.locator('a').first();
    expect(await getHref(link)).toBe('https://workday.com/apply');
  });

  it('returns null when the element has no href', async () => {
    await page.setContent('<a>Apply</a>');
    const link = page.locator('a').first();
    expect(await getHref(link)).toBeNull();
  });
});

describe('isExternalUrl', () => {
  it('classifies same-origin and cross-origin URLs', () => {
    expect(
      isExternalUrl('https://www.linkedin.com', 'https://www.linkedin.com/jobs/123'),
    ).toBe(false);
    expect(isExternalUrl('https://www.linkedin.com', 'https://workday.com/apply')).toBe(true);
    // Different subdomain → cross-origin per the WHATWG URL Standard.
    expect(isExternalUrl('https://www.linkedin.com', 'https://api.linkedin.com/jobs')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/automation/tests/detect/apply-method.test.ts`

Expected: FAIL — `Cannot find module '../../src/detect/apply-method.js'`. All five cases should fail with the same import error before any implementation exists.

- [ ] **Step 3: Implement the helpers**

Create `packages/automation/src/detect/apply-method.ts`:

```ts
import type { Locator, Page } from 'playwright';

/**
 * Return the first locator from `selectors` that is visible on the page,
 * or null if none match. Selectors are tried in order; the first hit wins.
 *
 * Used by adapters to detect apply buttons that may have multiple legacy
 * variants — e.g. LinkedIn renders `button[data-testid="..."]` in some
 * cohorts and a plain `button:has-text("Easy Apply")` in others. Adapters
 * pass an ordered list and let the helper pick whichever is present.
 */
export async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible()) return locator;
  }
  return null;
}

/**
 * Read the `href` attribute of the locator's element. Returns null when
 * the element has no `href` (e.g. a `<button>` rather than an `<a>`).
 * Adapters use this to capture an external apply URL without clicking
 * the button — clicks can trigger anti-bot heuristics.
 */
export async function getHref(locator: Locator): Promise<string | null> {
  return await locator.getAttribute('href');
}

/**
 * True if `url` has a different origin than `siteOrigin`. Pure JS — no
 * Playwright. Used to classify a captured apply URL as in-site (auto)
 * versus external redirect (manual).
 *
 * Throws via the URL constructor if either argument is malformed; both
 * are expected to be valid URLs from DOM reads.
 */
export function isExternalUrl(siteOrigin: string, url: string): boolean {
  return new URL(url).origin !== new URL(siteOrigin).origin;
}
```

- [ ] **Step 4: Add exports to `index.ts`**

Modify `packages/automation/src/index.ts`. Append to the existing exports:

```ts
export { firstVisible, getHref, isExternalUrl } from './detect/apply-method.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/automation/tests/detect/apply-method.test.ts`

Expected: PASS — `Tests 5 passed (5)` across three `describe` blocks.

- [ ] **Step 6: Run full repo verification**

```bash
pnpm --filter @vina/automation typecheck
pnpm --filter @vina/automation build
pnpm test
pnpm lint
```

Expected:
- `typecheck`, `build`, `lint`: clean
- `pnpm test`: `Tests 168 passed (168)` (163 prior + 5 new) across 52 test files (51 + 1 new)

- [ ] **Step 7: Commit**

```bash
git add packages/automation/src/detect/apply-method.ts \
        packages/automation/tests/detect/apply-method.test.ts \
        packages/automation/src/index.ts
git commit -m "feat(automation): add apply-method detection helpers (firstVisible/getHref/isExternalUrl)"
```

Plain `git commit -m`, no Claude byline.

---

## Task 3: BrowserManager

**Files:**
- Create: `packages/automation/src/browser/manager.ts`
- Create: `packages/automation/tests/browser/manager.test.ts`
- Modify: `packages/automation/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/automation/tests/browser/manager.test.ts`:

```ts
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBrowserManager } from '../../src/browser/manager.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-mgr-test-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('BrowserManager', () => {
  it('caches contexts: repeat getContext returns the same instance', async () => {
    const mgr = createBrowserManager({ dataDir });
    try {
      const a = await mgr.getContext('site-a');
      const b = await mgr.getContext('site-a');
      expect(a).toBe(b);
    } finally {
      await mgr.closeAll();
    }
  }, 30_000);

  it('closeContext removes from cache so next getContext launches fresh', async () => {
    const mgr = createBrowserManager({ dataDir });
    try {
      const first = await mgr.getContext('site-a');
      await mgr.closeContext('site-a');
      const second = await mgr.getContext('site-a');
      expect(first).not.toBe(second);
    } finally {
      await mgr.closeAll();
    }
  }, 30_000);

  it('closeAll closes every cached context', async () => {
    const mgr = createBrowserManager({ dataDir });
    const a = await mgr.getContext('site-a');
    const b = await mgr.getContext('site-b');
    expect(a).not.toBe(b);
    await mgr.closeAll();
    // After closeAll, getting again returns a fresh context.
    const a2 = await mgr.getContext('site-a');
    try {
      expect(a2).not.toBe(a);
    } finally {
      await mgr.closeAll();
    }
  }, 30_000);

  it('concurrent getContext calls dedup to a single launch', async () => {
    const mgr = createBrowserManager({ dataDir });
    try {
      const [a, b, c] = await Promise.all([
        mgr.getContext('site-a'),
        mgr.getContext('site-a'),
        mgr.getContext('site-a'),
      ]);
      expect(a).toBe(b);
      expect(b).toBe(c);
    } finally {
      await mgr.closeAll();
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/automation/tests/browser/manager.test.ts`

Expected: FAIL — `Cannot find module '../../src/browser/manager.js'`. All four cases fail on import.

- [ ] **Step 3: Implement the manager**

Create `packages/automation/src/browser/manager.ts`:

```ts
import type { BrowserContext } from 'playwright';
import { createLogger } from '@vina/shared';
import { launchSiteContext, type LaunchSiteContextOptions } from './launch.js';

const log = createLogger('browser-manager');

export interface BrowserManagerOptions {
  /** Vina data directory. Persistent profiles live at `<dataDir>/sessions/<siteId>/`. */
  dataDir: string;
  /** Defaults to `true`. Production reads `settings.browser_headful` and inverts. */
  headless?: boolean;
  /**
   * Browser channel — pass `'chrome'` in production for fewer detection
   * signals (per ADR-018). Omit to use Playwright's bundled Chromium
   * (tests, environments without Chrome installed).
   */
  channel?: LaunchSiteContextOptions['channel'];
}

export interface BrowserManagerHandle {
  /** Lazy-launch on first call per siteId; cached promise on repeat. */
  getContext(siteId: string): Promise<BrowserContext>;
  /**
   * Close one site's context (e.g. on session-expired recovery). No-op
   * if no context is cached for that siteId.
   */
  closeContext(siteId: string): Promise<void>;
  /**
   * Close every cached context. Errors during individual closes are
   * caught and logged so a single wedged context doesn't prevent the
   * others from closing during shutdown.
   */
  closeAll(): Promise<void>;
}

/**
 * Per-site persistent BrowserContext cache. Sits on top of
 * `launchSiteContext` from this same `browser/` directory and adds
 * lifecycle (cache, close-one, close-all) plus concurrent-launch
 * deduplication (storing the promise rather than the resolved context
 * means two simultaneous getContext calls await the same launch instead
 * of racing two `launchPersistentContext` calls into the same profile
 * dir, which Playwright would reject).
 */
export function createBrowserManager(opts: BrowserManagerOptions): BrowserManagerHandle {
  const cache = new Map<string, Promise<BrowserContext>>();

  function getContext(siteId: string): Promise<BrowserContext> {
    const cached = cache.get(siteId);
    if (cached) return cached;

    const launching = launchSiteContext({
      siteId,
      dataDir: opts.dataDir,
      headless: opts.headless ?? true,
      ...(opts.channel && { channel: opts.channel }),
    });
    cache.set(siteId, launching);
    return launching;
  }

  async function closeContext(siteId: string): Promise<void> {
    const cached = cache.get(siteId);
    if (!cached) return;
    cache.delete(siteId);
    try {
      const ctx = await cached;
      await ctx.close();
    } catch (err) {
      log.warn({ err, siteId }, 'closeContext failed');
    }
  }

  async function closeAll(): Promise<void> {
    const entries = [...cache.entries()];
    cache.clear();
    await Promise.all(
      entries.map(async ([siteId, ctxPromise]) => {
        try {
          const ctx = await ctxPromise;
          await ctx.close();
        } catch (err) {
          log.warn({ err, siteId }, 'closeAll: context close failed');
        }
      }),
    );
  }

  return { getContext, closeContext, closeAll };
}
```

- [ ] **Step 4: Add exports to `index.ts`**

Modify `packages/automation/src/index.ts`. Append:

```ts
export {
  createBrowserManager,
  type BrowserManagerHandle,
  type BrowserManagerOptions,
} from './browser/manager.js';
```

The full final file:

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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/automation/tests/browser/manager.test.ts`

Expected: PASS — `Tests 4 passed (4)`. Each test launches and closes real Chromium contexts; total runtime is ~5-10 seconds depending on machine.

- [ ] **Step 6: Run full repo verification**

```bash
pnpm --filter @vina/automation typecheck
pnpm --filter @vina/automation build
pnpm test
pnpm lint
```

Expected:
- `typecheck`, `build`, `lint`: clean
- `pnpm test`: `Tests 172 passed (172)` (168 prior + 4 new) across 53 test files (52 + 1 new)

- [ ] **Step 7: Commit**

```bash
git add packages/automation/src/browser/manager.ts \
        packages/automation/tests/browser/manager.test.ts \
        packages/automation/src/index.ts
git commit -m "feat(automation): add BrowserManager with per-site context cache and dedup'd launches"
```

Plain `git commit -m`, no Claude byline.

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-05-03-m11-bucket-1-browser-foundation-design.md`):

| Spec section | Covered by |
|---|---|
| `RawListing` and `JobDetail` types | Task 1 Step 1 (verbatim) |
| `SiteAdapter` interface (M11-subset, 8 fields/methods, optional `signal?` everywhere) | Task 1 Step 2 |
| `BrowserManager` API: `createBrowserManager`, `getContext`, `closeContext`, `closeAll` | Task 3 Step 3 |
| `BrowserManager` opts: `dataDir`, optional `headless` (default true), optional `channel` | Task 3 Step 3 (verbatim) |
| Promise-cache dedup for concurrent `getContext` | Task 3 Step 3 (`cache: Map<string, Promise<BrowserContext>>`); Task 3 Step 1 test #4 |
| `closeAll` catches per-context errors so one wedged context doesn't block others | Task 3 Step 3 (try/catch inside Promise.all map); not directly asserted but the structure is in the implementation |
| Logger module name `browser-manager` | Task 3 Step 3 (`createLogger('browser-manager')`) |
| `firstVisible`, `getHref`, `isExternalUrl` helpers | Task 2 Step 3 |
| `firstVisible` "first hit wins" ordering semantic | Task 2 Step 3 (for-of loop, returns on first match); Task 2 Step 1 test #1 |
| `getHref` returns null for elements without href | Task 2 Step 3 (`getAttribute` returns null naturally); Task 2 Step 1 test #4 |
| `isExternalUrl` pure-JS, throws on malformed input | Task 2 Step 3 |
| Public API barrel exports | Task 1 Step 3, Task 2 Step 4, Task 3 Step 4 |
| `SearchPreferences` reused from `@vina/shared` rather than redefined | Task 1 Step 2 (`import type { SearchPreferences } from '@vina/shared';`) |
| Test plan: BrowserManager 4 cases | Task 3 Step 1 (verbatim) |
| Test plan: apply-method 5 cases | Task 2 Step 1 (verbatim) |
| Test plan: SiteAdapter has no runtime tests, types are the test | Task 1 (no test file) |
| File structure matches spec layout | All three tasks |
| LOC estimate (~80 source, ~120 tests) | Source: types ~15 + adapter ~50 + apply-method ~25 + manager ~60 = ~150 lines incl. JSDoc; tests: detect ~50 + manager ~70 = ~120 lines. Source ran a bit higher than estimate due to JSDoc — fine. |

No spec requirement is uncovered.

**2. Placeholder scan:** No `TBD` / `TODO` / `implement later` / vague-error-handling markers anywhere. Every step has the actual code or command an implementer needs.

**3. Type consistency:**

- `BrowserContext` imported from `playwright` consistently in source and tests.
- `LaunchSiteContextOptions['channel']` used as the type for `BrowserManagerOptions.channel` in Task 3 — this propagates the channel constraint from Task 0's helper without redeclaring it.
- `RawListing` and `JobDetail` exported only as types (`type Foo`) since they're pure interfaces.
- The `signal?: AbortSignal` parameter is consistently optional across `search`, `openListing`, and `detectApplyMethod`.
- `index.ts` imports use `.js` extensions (NodeNext / `verbatimModuleSyntax`) consistently.
- Test count claims compose correctly: 163 (M11 Task 1) → 163 (Bucket 1 Task 1, no runtime tests) → 168 (Bucket 1 Task 2 +5) → 172 (Bucket 1 Task 3 +4).
- The `isVisible()` method on `Locator` is called with no arguments in `firstVisible` — Playwright's API: that returns a boolean immediately based on the current DOM state, no waiting. Correct usage.

**4. One spec note worth carrying forward:** the spec's "Integration debt" section flags that `closeAll()` is not yet wired into `bootServer`'s shutdown — that's deliberate, Bucket 3 Task 9 picks it up alongside the search-handler replacement. No test today covers `main.ts` shutdown calling `browserManager.closeAll()` because nothing in `main.ts` constructs the manager yet. That gap is captured by the spec, not a plan failure.
