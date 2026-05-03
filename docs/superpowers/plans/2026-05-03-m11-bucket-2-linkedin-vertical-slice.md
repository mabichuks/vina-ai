# M11 Bucket 2 — LinkedIn Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the LinkedIn `SiteAdapter` (the first concrete implementation of the M11-subset interface from Bucket 1) along with a Fastify fixture site that mirrors LinkedIn's relevant DOM and shared scaffolding for future site fixtures (Indeed M12, Google Jobs M13).

**Architecture:** Five tasks in dependency order — interface refactor first (free, while the adapter doesn't exist), then leaf modules (selectors, shared fixture helper), then the LinkedIn fixture site, then the adapter + tests in one TDD-shaped commit. The adapter is a plain `const` export per the Bucket 1 design (no closure state) and is tested via real bundled Chromium against a per-suite Fastify fixture that binds to an OS-assigned ephemeral port.

**Tech Stack:** TypeScript (strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), Playwright, Vitest, Fastify (NEW devDep on `@vina/automation` for the fixture). Adapter uses Bucket 1 helpers (`firstVisible`, `getHref`, `isExternalUrl`, `pause`).

---

## File Structure

| Path | Status | Responsibility | Task |
|---|---|---|---|
| `packages/automation/src/adapters/adapter.ts` | MODIFY | Discriminated-union refactor on `detectApplyMethod`; JSDoc softening | 1 |
| `docs/browser-automation.md` | MODIFY | §3 union shape | 1 |
| `docs/superpowers/specs/2026-05-03-m11-bucket-1-browser-foundation-design.md` | MODIFY | Same union shape | 1 |
| `packages/automation/src/adapters/linkedin-selectors.ts` | NEW | Multi-variant selector arrays for the adapter | 2 |
| `packages/automation/package.json` | MODIFY | Add `fastify` to devDependencies | 3 |
| `tests/fixtures/start-server.ts` | NEW | Shared Fastify boot helper | 3 |
| `tests/fixtures/sites/linkedin/selectors.ts` | NEW | Selector strings used by fixture HTML | 4 |
| `tests/fixtures/sites/linkedin/pages.ts` | NEW | HTML generators per route | 4 |
| `tests/fixtures/sites/linkedin/server.ts` | NEW | `startLinkedInFixture` entry point | 4 |
| `packages/automation/src/adapters/linkedin.ts` | NEW | LinkedIn `SiteAdapter` implementation | 5 |
| `packages/automation/src/index.ts` | MODIFY | Re-export `linkedInAdapter` | 5 |
| `packages/automation/tests/adapters/linkedin.test.ts` | NEW | 10 cases against the fixture | 5 |

---

## Task 1: Interface refactor + JSDoc softening

Discriminated union on `detectApplyMethod`'s return type, plus a wording softening on the M15 framing JSDoc. Touches the interface in code and the same shape in two specs to keep them in lockstep.

**Files:**
- Modify: `packages/automation/src/adapters/adapter.ts`
- Modify: `docs/browser-automation.md`
- Modify: `docs/superpowers/specs/2026-05-03-m11-bucket-1-browser-foundation-design.md`

No runtime tests change; no implementations exist yet, so the type change is free.

- [ ] **Step 1: Modify the interface in code**

In `packages/automation/src/adapters/adapter.ts`:

Find:
```ts
detectApplyMethod(
    page: Page,
    listing: RawListing,
    signal?: AbortSignal,
  ): Promise<{ method: 'auto' | 'manual'; externalApplyUrl?: string }>;
```

Replace with:
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

Find the JSDoc paragraph on `SiteAdapter`:
```
 * Contract for a browser-kind site adapter (LinkedIn in M11, Indeed in
 * M12). M11-subset: discovery only — `id`, `loginUrl`, the predicates,
 * `search`, `openListing`, and `detectApplyMethod`. The form-walker
 * methods (`startApplication`, `inspectFields`, `fillField`, `uploadCv`,
 * `uploadCoverLetter`, `submit`, `takeScreenshot`) extend this interface
 * in M15 when `ApplicationSession` and `FormField` types can be designed
 * with full context.
```

Replace with:
```
 * Contract for a browser-kind site adapter (LinkedIn in M11, Indeed in
 * M12). M11-subset: discovery only — `id`, `loginUrl`, the predicates,
 * `search`, `openListing`, and `detectApplyMethod`. The form-walker
 * methods (`startApplication`, `inspectFields`, `fillField`, `uploadCv`,
 * `uploadCoverLetter`, `submit`, `takeScreenshot`) extend this interface
 * in M15 and may revisit the discovery method shapes if `ApplicationSession`
 * integration requires it.
```

- [ ] **Step 2: Sync `docs/browser-automation.md`**

In `docs/browser-automation.md` find the `SiteAdapter` interface block (§3). The current `detectApplyMethod` snippet shows:

```ts
  // Inspect a listing and decide if it's auto-applyable on this site.
  // Returns 'auto' for in-site quick/easy apply, 'manual' for external redirects.
  // Also captures the external apply URL when the method is 'manual'.
  detectApplyMethod(
    page: Page,
    listing: RawListing,
  ): Promise<{
    method: 'auto' | 'manual';
    externalApplyUrl?: string;
  }>;
```

Replace with:

```ts
  // Inspect a listing and decide if it's auto-applyable on this site.
  // Returns 'auto' for in-site quick/easy apply, 'manual' for external redirects.
  // The discriminated union eliminates the auto-with-URL bug class: callers
  // narrow on `method` and the auto branch has no `externalApplyUrl` field.
  // The manual branch's URL is nullable so an adapter that detects "manual
  // listing, but no extractable URL" can still classify honestly without
  // throwing.
  detectApplyMethod(
    page: Page,
    listing: RawListing,
  ): Promise<
    | { method: 'auto' }
    | { method: 'manual'; externalApplyUrl: string | null }
  >;
```

- [ ] **Step 3: Sync the bucket-1 spec**

In `docs/superpowers/specs/2026-05-03-m11-bucket-1-browser-foundation-design.md` find the `SiteAdapter` interface block (Component 2 section). Apply the same return-type change:

Find:
```ts
  detectApplyMethod(
    page: Page,
    listing: RawListing,
    signal?: AbortSignal,
  ): Promise<{ method: 'auto' | 'manual'; externalApplyUrl?: string }>;
```

Replace with:
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

If the bucket-1 spec also has the JSDoc paragraph about M15 form-walker methods, apply the same softening from Step 1 (find the "extend this interface in M15 when `ApplicationSession`..." sentence and replace with "extend this interface in M15 and may revisit the discovery method shapes if `ApplicationSession` integration requires it").

- [ ] **Step 4: Verify**

Run:
```bash
pnpm --filter @vina/automation typecheck
pnpm --filter @vina/automation build
pnpm test
pnpm lint
```

Expected:
- `typecheck`, `build`, `lint`: clean
- `pnpm test`: still **173 passed (173)** — no test changes, the type signature change has no runtime impact

If anything fails, the most likely cause is a typo in the union shape or a stale import. Re-read the diff; do NOT commit until all four are clean.

- [ ] **Step 5: Commit**

```bash
git add packages/automation/src/adapters/adapter.ts \
        docs/browser-automation.md \
        docs/superpowers/specs/2026-05-03-m11-bucket-1-browser-foundation-design.md
git commit -m "refactor(automation): SiteAdapter.detectApplyMethod returns discriminated union"
```

Plain `git commit -m`, no Claude byline.

---

## Task 2: LinkedIn selectors module

Multi-variant selector arrays for the adapter to use with `firstVisible`, plus single-string selectors for elements with one canonical form.

**Files:**
- Create: `packages/automation/src/adapters/linkedin-selectors.ts`

No tests for a constants module; tests in Task 5 exercise the selectors via the adapter.

- [ ] **Step 1: Create the selectors module**

Write `packages/automation/src/adapters/linkedin-selectors.ts`:

```ts
/**
 * LinkedIn DOM selectors used by the adapter. Multi-variant arrays cover
 * cohort-driven rendering differences — `firstVisible` tries each in
 * order and returns the first hit. Single-string constants are the
 * canonical form for elements that don't drift across cohorts.
 *
 * The fixture site at `tests/fixtures/sites/linkedin/` mirrors a subset
 * of these selectors so adapter tests exercise the same selector paths
 * the real-LinkedIn DOM does. The two are kept in sync manually — a
 * fixture HTML change without an adapter selector update (or vice
 * versa) breaks the relevant test loudly.
 */

/** Selector for the apply-button container, used as a readiness wait. */
export const APPLY_BUTTON_ROOT_SELECTOR = '[data-test-id="jobs-apply-button-id"]';

/** Easy Apply variants — order matters; specific selectors first. */
export const EASY_APPLY_SELECTORS = [
  'button[data-test-id="jobs-apply-button-id"]:has-text("Easy Apply")',
  'button:has-text("Easy Apply")',
];

/** External-redirect variants — anchor preferred (href readable), button fallback. */
export const EXTERNAL_APPLY_SELECTORS = [
  'a[data-test-id="jobs-apply-button-id"]',
  'button[data-test-id="jobs-apply-button-id"]',
];

/** Job title element on the listing detail page. */
export const JOB_TITLE_SELECTOR = '.jobs-unified-top-card__job-title';

/** Job description body. */
export const JOB_DESCRIPTION_SELECTOR = '.jobs-description';

/** Salary text — optional, may not be present on every listing. */
export const JOB_SALARY_SELECTOR = '.jobs-unified-top-card__job-insight-salary';

/** Listing card on the search results page; carries `data-job-id`. */
export const JOB_CARD_SELECTOR = '[data-job-id]';
```

- [ ] **Step 2: Verify**

Run:
```bash
pnpm --filter @vina/automation typecheck
pnpm --filter @vina/automation build
pnpm test
pnpm lint
```

Expected: all clean; 173 tests still pass; new file `dist/adapters/linkedin-selectors.js` exists after build.

- [ ] **Step 3: Commit**

```bash
git add packages/automation/src/adapters/linkedin-selectors.ts
git commit -m "feat(automation): add LinkedIn selector constants for adapter"
```

Plain `git commit -m`, no Claude byline.

---

## Task 3: Shared fixture-server scaffolding

A small Fastify boot helper at the repo root so future site fixtures (Indeed M12, Google Jobs M13) don't duplicate boilerplate.

**Files:**
- Modify: `packages/automation/package.json` — add `fastify` to devDeps
- Create: `tests/fixtures/start-server.ts`

- [ ] **Step 1: Install Fastify**

Run:
```bash
pnpm --filter @vina/automation add -D fastify
```

Expected: `fastify` appears under `devDependencies` in `packages/automation/package.json`. The version pin doesn't matter much — match what `@vina/server` uses (`^5.x`) so the test runtime matches production.

Verify with:
```bash
grep -E '"fastify"' packages/automation/package.json
```

Expected: one line under devDependencies.

- [ ] **Step 2: Create the helper**

Write `tests/fixtures/start-server.ts`:

```ts
import Fastify, { type FastifyPluginAsync } from 'fastify';

export interface FixtureServerHandle {
  /** Base URL like `http://127.0.0.1:54321`. */
  url: string;
  /** Same as `url`, exposed under `origin` for clarity at adapter call sites. */
  origin: string;
  /** Stop the server. Idempotent. */
  close(): Promise<void>;
}

/**
 * Boot a Fastify app with the given route registrar on an OS-assigned
 * ephemeral port (binds `0.0.0.0:0`). Returns a handle with the running
 * URL and a cleanup function.
 *
 * Used by per-site fixtures (`startLinkedInFixture` today, Indeed/Google
 * later) so each site doesn't duplicate Fastify boot. Logging is disabled
 * to keep test output clean.
 */
export async function startFixtureServer(
  registerRoutes: FastifyPluginAsync,
): Promise<FixtureServerHandle> {
  const app = Fastify({ logger: false });
  await app.register(registerRoutes);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    url,
    origin: url,
    async close() {
      await app.close();
    },
  };
}
```

- [ ] **Step 3: Verify**

Run:
```bash
pnpm --filter @vina/automation typecheck
pnpm --filter @vina/automation build
pnpm test
pnpm lint
```

Expected: all clean; 173 tests still pass. The helper file is consumed by tests, not src — `pnpm build` should not emit it (it's outside `src/`). The typecheck includes it via the package's tsconfig.json `include: ['src/**/*', 'tests/**/*']` only if the file path is reachable; since `tests/fixtures/start-server.ts` is at repo root (not under the package), TypeScript picks it up via the test file's import graph in Task 5. For now, no consumers exist — this task's verification only confirms the helper file itself parses (which `pnpm typecheck` may or may not exercise depending on import discovery). The real verification comes when Task 5's adapter test imports it.

If `pnpm typecheck` does not surface the file (because no consumers reference it yet), that's OK — Task 5 will catch any issues.

- [ ] **Step 4: Commit**

```bash
git add packages/automation/package.json pnpm-lock.yaml tests/fixtures/start-server.ts
git commit -m "feat(test-fixtures): add shared startFixtureServer helper"
```

Plain `git commit -m`, no Claude byline.

---

## Task 4: LinkedIn fixture site

Three files at `tests/fixtures/sites/linkedin/`: selectors (mirroring the adapter side), HTML generators per route, and the server entry point that wires routes onto `startFixtureServer`.

**Files:**
- Create: `tests/fixtures/sites/linkedin/selectors.ts`
- Create: `tests/fixtures/sites/linkedin/pages.ts`
- Create: `tests/fixtures/sites/linkedin/server.ts`

- [ ] **Step 1: Create the fixture-side selectors**

Write `tests/fixtures/sites/linkedin/selectors.ts`:

```ts
/**
 * Selectors used in the fixture HTML. These mirror the canonical (first)
 * variant of `packages/automation/src/adapters/linkedin-selectors.ts` —
 * the adapter side may include legacy-cohort fallbacks the fixture
 * doesn't need to render. The two files are kept in sync manually.
 *
 * If adapter tests start failing because the fixture renders the wrong
 * structure, check that the canonical selectors here still match the
 * first entry of each adapter selector array.
 */

/** Apply-button container test id (used as the data-test-id attribute value). */
export const APPLY_BUTTON_TEST_ID = 'jobs-apply-button-id';

/** Class on the job title element on the detail page. */
export const JOB_TITLE_CLASS = 'jobs-unified-top-card__job-title';

/** Class on the job description body. */
export const JOB_DESCRIPTION_CLASS = 'jobs-description';

/** Class on the salary insight element. */
export const JOB_SALARY_CLASS = 'jobs-unified-top-card__job-insight-salary';

/** Data attribute name on listing cards in the search results page. */
export const JOB_CARD_DATA_ATTR = 'data-job-id';
```

- [ ] **Step 2: Create the page generators**

Write `tests/fixtures/sites/linkedin/pages.ts`:

```ts
import {
  APPLY_BUTTON_TEST_ID,
  JOB_CARD_DATA_ATTR,
  JOB_DESCRIPTION_CLASS,
  JOB_SALARY_CLASS,
  JOB_TITLE_CLASS,
} from './selectors.js';

/**
 * HTML page generators for the LinkedIn fixture. Each function returns
 * a complete HTML document. Pages are intentionally minimal — they
 * include only the DOM structure the adapter actually targets.
 */

function html(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body>${body}</body></html>`;
}

export function loginPage(): string {
  return html(`
    <h1>Sign in</h1>
    <form action="/login" method="POST">
      <input name="username" placeholder="Email">
      <input name="password" type="password" placeholder="Password">
      <button type="submit">Sign in</button>
    </form>
  `);
}

export function feedPage(): string {
  return html(`
    <h1>Welcome back</h1>
    <p>Your feed</p>
  `);
}

interface FixtureListing {
  id: string;
  title: string;
  company: string;
  location: string;
  snippet: string;
  postedAt: string;
}

const FIXTURE_LISTINGS: readonly FixtureListing[] = [
  {
    id: 'easy',
    title: 'Senior TypeScript Engineer',
    company: 'Acme Corp',
    location: 'Remote',
    snippet: 'Backend role with TypeScript, Postgres, AWS.',
    postedAt: '2026-05-01T00:00:00.000Z',
  },
  {
    id: 'ext',
    title: 'Staff Software Engineer',
    company: 'Globex',
    location: 'San Francisco, CA',
    snippet: 'Platform team — distributed systems, Go preferred.',
    postedAt: '2026-04-30T00:00:00.000Z',
  },
  {
    id: 'ndi',
    title: 'Principal Backend Engineer',
    company: 'Initech',
    location: 'New York, NY',
    snippet: 'Greenfield infrastructure work.',
    postedAt: '2026-04-29T00:00:00.000Z',
  },
] as const;

export function searchResultsPage(): string {
  const cards = FIXTURE_LISTINGS.map(
    (l) => `
      <div ${JOB_CARD_DATA_ATTR}="${l.id}">
        <a href="/jobs/view/${l.id}">
          <h3 class="${JOB_TITLE_CLASS}">${l.title}</h3>
          <span class="company">${l.company}</span>
          <span class="location">${l.location}</span>
          <p class="snippet">${l.snippet}</p>
          <time datetime="${l.postedAt}">${l.postedAt}</time>
        </a>
      </div>
    `,
  ).join('');
  return html(`<main><h1>Search results</h1>${cards}</main>`);
}

function detailPageBase(listing: FixtureListing, applyHtml: string): string {
  return html(`
    <main>
      <h1 class="${JOB_TITLE_CLASS}">${listing.title}</h1>
      <span class="company">${listing.company}</span>
      <span class="location">${listing.location}</span>
      <span class="${JOB_SALARY_CLASS}">$180k – $220k</span>
      <div class="${JOB_DESCRIPTION_CLASS}">${listing.snippet} Full description here.</div>
      ${applyHtml}
    </main>
  `);
}

export function easyApplyDetailPage(): string {
  const listing = FIXTURE_LISTINGS[0]!;
  return detailPageBase(
    listing,
    `<button data-test-id="${APPLY_BUTTON_TEST_ID}">Easy Apply</button>`,
  );
}

export function externalRedirectDetailPage(): string {
  const listing = FIXTURE_LISTINGS[1]!;
  return detailPageBase(
    listing,
    `<a data-test-id="${APPLY_BUTTON_TEST_ID}" href="https://workday.example/jobs/123">Apply</a>`,
  );
}

export function externalNoUrlDetailPage(): string {
  const listing = FIXTURE_LISTINGS[2]!;
  return detailPageBase(
    listing,
    `<button data-test-id="${APPLY_BUTTON_TEST_ID}">Apply</button>`,
  );
}

/** Exported for tests that want to assert on listing data directly. */
export { FIXTURE_LISTINGS };
```

- [ ] **Step 3: Create the server entry point**

Write `tests/fixtures/sites/linkedin/server.ts`:

```ts
import { startFixtureServer, type FixtureServerHandle } from '../../start-server.js';
import {
  easyApplyDetailPage,
  externalNoUrlDetailPage,
  externalRedirectDetailPage,
  feedPage,
  loginPage,
  searchResultsPage,
} from './pages.js';

export type LinkedInFixtureHandle = FixtureServerHandle;

/**
 * Boot a Fastify fixture serving canned HTML that mirrors LinkedIn's
 * relevant DOM structure. Routes:
 *
 * - `GET /login`            — login form
 * - `POST /login`           — 302 → `/feed` (always succeeds)
 * - `GET /feed`             — authed feed page
 * - `GET /jobs/search`      — search results with three listing cards
 * - `GET /jobs/view/easy`   — Easy Apply detail
 * - `GET /jobs/view/ext`    — external-redirect detail (with href)
 * - `GET /jobs/view/ndi`    — external-redirect detail (no href, degraded)
 */
export async function startLinkedInFixture(): Promise<LinkedInFixtureHandle> {
  return startFixtureServer(async (app) => {
    app.get('/login', async (_req, reply) => {
      void reply.type('text/html').send(loginPage());
    });
    app.post('/login', async (_req, reply) => {
      void reply.redirect('/feed', 302);
    });
    app.get('/feed', async (_req, reply) => {
      void reply.type('text/html').send(feedPage());
    });
    app.get('/jobs/search', async (_req, reply) => {
      void reply.type('text/html').send(searchResultsPage());
    });
    app.get('/jobs/view/easy', async (_req, reply) => {
      void reply.type('text/html').send(easyApplyDetailPage());
    });
    app.get('/jobs/view/ext', async (_req, reply) => {
      void reply.type('text/html').send(externalRedirectDetailPage());
    });
    app.get('/jobs/view/ndi', async (_req, reply) => {
      void reply.type('text/html').send(externalNoUrlDetailPage());
    });
  });
}
```

- [ ] **Step 4: Verify**

Run:
```bash
pnpm --filter @vina/automation typecheck
pnpm --filter @vina/automation build
pnpm test
pnpm lint
```

Expected: all clean; 173 tests still pass. No new tests yet (Task 5 adds them); the fixture compiles via the package's tsconfig because the test file in Task 5 will import it transitively.

If typecheck fails on the fixture files because they're outside the package's tsconfig include paths, the package's `tests/**/*` glob doesn't reach the repo-root `tests/fixtures/`. This is expected — the files only get type-checked when reached via the import graph from a test file (Task 5). Don't add them to the include path; they'll be picked up correctly when Task 5 lands.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/sites/linkedin/selectors.ts \
        tests/fixtures/sites/linkedin/pages.ts \
        tests/fixtures/sites/linkedin/server.ts
git commit -m "feat(test-fixtures): add LinkedIn fixture site (login, feed, search, three detail variants)"
```

Plain `git commit -m`, no Claude byline.

---

## Task 5: LinkedIn adapter implementation + tests

The biggest task in this bucket. Writes the full adapter and all 10 tests in one TDD cycle: tests first (all 10), confirm they fail with module-missing, write the adapter, confirm they pass, commit.

**Files:**
- Create: `packages/automation/tests/adapters/linkedin.test.ts`
- Create: `packages/automation/src/adapters/linkedin.ts`
- Modify: `packages/automation/src/index.ts` — re-export `linkedInAdapter`

- [ ] **Step 1: Write the failing tests**

Write `packages/automation/tests/adapters/linkedin.test.ts`:

```ts
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { SearchPreferences } from '@vina/shared';
import { linkedInAdapter } from '../../src/adapters/linkedin.js';
import {
  startLinkedInFixture,
  type LinkedInFixtureHandle,
} from '../../../../tests/fixtures/sites/linkedin/server.js';

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

const PREFS: SearchPreferences = {
  id: 'default',
  description: 'TS backend',
  keywords: ['typescript'],
  locations: ['Remote'],
  work_models: ['remote'],
  seniority: ['senior'],
  min_salary: null,
  max_salary: null,
  salary_currency: null,
  excluded_companies: [],
  score_threshold: 70,
  updated_at: '2026-05-03T00:00:00.000Z',
};

describe('linkedInAdapter — login predicates', () => {
  it('onLoginSuccess returns true on /feed', async () => {
    await page.goto(`${fixture.url}/feed`);
    expect(await linkedInAdapter.onLoginSuccess(page)).toBe(true);
  }, 30_000);

  it('onLoginSuccess returns false on /login', async () => {
    await page.goto(`${fixture.url}/login`);
    expect(await linkedInAdapter.onLoginSuccess(page)).toBe(false);
  }, 30_000);

  it('onSessionExpired returns true on /login', async () => {
    await page.goto(`${fixture.url}/login`);
    expect(await linkedInAdapter.onSessionExpired(page)).toBe(true);
  }, 30_000);

  it('onSessionExpired returns false on /feed', async () => {
    await page.goto(`${fixture.url}/feed`);
    expect(await linkedInAdapter.onSessionExpired(page)).toBe(false);
  }, 30_000);
});

describe('linkedInAdapter.search', () => {
  it('yields a RawListing for each card on the search results page', async () => {
    // Pre-navigate so the adapter can build the search URL from the current origin.
    await page.goto(`${fixture.url}/feed`);
    const collected: Array<{ externalId: string; title: string }> = [];
    for await (const listing of linkedInAdapter.search(page, PREFS)) {
      collected.push({ externalId: listing.externalId, title: listing.title });
    }
    expect(collected.map((l) => l.externalId).sort()).toEqual(['easy', 'ext', 'ndi']);
    expect(collected.find((l) => l.externalId === 'easy')?.title).toBe(
      'Senior TypeScript Engineer',
    );
  }, 30_000);

  it('aborts mid-iteration when the signal aborts', async () => {
    await page.goto(`${fixture.url}/feed`);
    const controller = new AbortController();
    const collected: string[] = [];
    let rejected: unknown = null;
    try {
      for await (const listing of linkedInAdapter.search(page, PREFS, controller.signal)) {
        collected.push(listing.externalId);
        controller.abort('test-abort');
      }
    } catch (err) {
      rejected = err;
    }
    expect(rejected).toBe('test-abort');
    expect(collected.length).toBe(1);
  }, 30_000);
});

describe('linkedInAdapter.openListing', () => {
  it('extracts description and salary from a detail page', async () => {
    const detail = await linkedInAdapter.openListing(page, {
      externalId: 'easy',
      title: 'Senior TypeScript Engineer',
      company: 'Acme Corp',
      location: 'Remote',
      url: `${fixture.url}/jobs/view/easy`,
      snippet: null,
      postedAt: null,
    });
    expect(detail.description).toContain('Full description');
    expect(detail.salaryText).toBe('$180k – $220k');
  }, 30_000);
});

describe('linkedInAdapter.detectApplyMethod', () => {
  it("returns { method: 'auto' } for the Easy Apply detail", async () => {
    await page.goto(`${fixture.url}/jobs/view/easy`);
    const result = await linkedInAdapter.detectApplyMethod(page, {
      externalId: 'easy',
      title: 'Senior TypeScript Engineer',
      company: 'Acme Corp',
      location: 'Remote',
      url: `${fixture.url}/jobs/view/easy`,
      snippet: null,
      postedAt: null,
    });
    expect(result).toEqual({ method: 'auto' });
  }, 30_000);

  it("returns { method: 'manual', externalApplyUrl: '<url>' } for the external-redirect detail", async () => {
    await page.goto(`${fixture.url}/jobs/view/ext`);
    const result = await linkedInAdapter.detectApplyMethod(page, {
      externalId: 'ext',
      title: 'Staff Software Engineer',
      company: 'Globex',
      location: 'San Francisco, CA',
      url: `${fixture.url}/jobs/view/ext`,
      snippet: null,
      postedAt: null,
    });
    expect(result).toEqual({
      method: 'manual',
      externalApplyUrl: 'https://workday.example/jobs/123',
    });
  }, 30_000);

  it("returns { method: 'manual', externalApplyUrl: null } for the no-href detail (degraded)", async () => {
    await page.goto(`${fixture.url}/jobs/view/ndi`);
    const result = await linkedInAdapter.detectApplyMethod(page, {
      externalId: 'ndi',
      title: 'Principal Backend Engineer',
      company: 'Initech',
      location: 'New York, NY',
      url: `${fixture.url}/jobs/view/ndi`,
      snippet: null,
      postedAt: null,
    });
    expect(result).toEqual({ method: 'manual', externalApplyUrl: null });
  }, 30_000);
});
```

**Note on the `PREFS` fixture**: this matches the `SearchPreferences` type from `@vina/shared/schemas/preferences.ts`. Verify field names and types if vitest complains — the bucket-1 brainstorm chose to reuse this type rather than redefine.

**Note on cross-package import**: the test imports the fixture via `'../../../../tests/fixtures/sites/linkedin/server.js'` — four levels up from `packages/automation/tests/adapters/`. Vitest's TypeScript resolver follows the import graph regardless of the per-package tsconfig include path, so this works without any tsconfig changes.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/automation/tests/adapters/linkedin.test.ts`

Expected: FAIL — `Cannot find module '../../src/adapters/linkedin.js'`. All 10 cases should fail with the same import error before any implementation exists.

- [ ] **Step 3: Implement the adapter**

Write `packages/automation/src/adapters/linkedin.ts`:

```ts
import type { Locator, Page } from 'playwright';
import type { SearchPreferences } from '@vina/shared';
import { firstVisible, getHref, isExternalUrl } from '../detect/apply-method.js';
import { pause } from '../browser/humanise.js';
import type { SiteAdapter } from './adapter.js';
import type { JobDetail, RawListing } from './types.js';
import {
  APPLY_BUTTON_ROOT_SELECTOR,
  EASY_APPLY_SELECTORS,
  EXTERNAL_APPLY_SELECTORS,
  JOB_CARD_SELECTOR,
  JOB_DESCRIPTION_SELECTOR,
  JOB_SALARY_SELECTOR,
  JOB_TITLE_SELECTOR,
} from './linkedin-selectors.js';

const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

/**
 * Build a search URL relative to the page's current origin. In production
 * the page is on `https://www.linkedin.com`; under test the page is on
 * the fixture's `http://127.0.0.1:<port>`. Same path; different host.
 */
function buildSearchUrl(currentUrl: string, prefs: SearchPreferences): string {
  const base = new URL(currentUrl);
  const url = new URL('/jobs/search', base.origin);
  if (prefs.keywords.length > 0) {
    url.searchParams.set('keywords', prefs.keywords.join(' '));
  }
  if (prefs.locations.length > 0) {
    url.searchParams.set('location', prefs.locations[0]!);
  }
  return url.toString();
}

async function readOptional(page: Page, selector: string): Promise<string | null> {
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) return null;
  return await locator.innerText();
}

async function extractRawListing(card: Locator, baseUrl: string): Promise<RawListing | null> {
  const externalId = await card.getAttribute('data-job-id');
  if (!externalId) return null;
  const titleText = await card.locator(JOB_TITLE_SELECTOR).first().innerText();
  if (!titleText) return null;
  const company = await card.locator('.company').first().innerText();
  const location = await card.locator('.location').first().innerText();
  const snippet = await card.locator('.snippet').first().innerText();
  const postedAt = await card.locator('time').first().getAttribute('datetime');
  const href = await card.locator('a').first().getAttribute('href');
  const url = href ? new URL(href, baseUrl).toString() : '';
  return {
    externalId,
    title: titleText,
    company,
    location: location || null,
    url,
    snippet: snippet || null,
    postedAt: postedAt || null,
  };
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
    return new URL(page.url()).pathname.startsWith('/login');
  },

  async *search(page, prefs, signal) {
    const url = buildSearchUrl(page.url(), prefs);
    await page.goto(url);
    await page.waitForSelector(JOB_CARD_SELECTOR, { state: 'visible' });

    const cards = await page.locator(JOB_CARD_SELECTOR).all();
    for (const card of cards) {
      const listing = await extractRawListing(card, page.url());
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
    return { description, salaryText } satisfies JobDetail;
  },

  async detectApplyMethod(page) {
    // Adapter writes its own readiness wait — `firstVisible` is a snapshot
    // check, not auto-waiting. Per the bucket-1 review carry-forward.
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

**Note on path-based predicates**: `onLoginSuccess` checks `pathname.startsWith('/feed')`, not `page.url().startsWith('https://www.linkedin.com/feed')`. This makes the adapter work against the fixture (`http://127.0.0.1:<port>/feed`) AND real LinkedIn (`https://www.linkedin.com/feed`). The path is the semantic; the host is incidental.

**Note on `detectApplyMethod` with the no-href button**: when the apply button is a `<button>` (not `<a>`), `getAttribute('href')` returns `null`, the helper short-circuits to `{ method: 'manual', externalApplyUrl: null }`, and the test for the `/ndi` case passes. This is the degraded-but-honest case the discriminated union with nullable URL was designed for.

- [ ] **Step 4: Add the export**

Modify `packages/automation/src/index.ts`. Append after the existing exports:

```ts
export { linkedInAdapter } from './adapters/linkedin.js';
```

Final file:

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
export { linkedInAdapter } from './adapters/linkedin.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/automation/tests/adapters/linkedin.test.ts`

Expected: PASS — `Tests 10 passed (10)` across four `describe` blocks. Each test launches and closes a real Chromium browser; total runtime is ~10-30 seconds depending on machine.

- [ ] **Step 6: Run full repo verification**

```bash
pnpm --filter @vina/automation typecheck
pnpm --filter @vina/automation build
pnpm test
pnpm lint
```

Expected:
- `typecheck`, `build`, `lint`: clean
- `pnpm test`: `Tests 183 passed (183)` (173 prior + 10 new) across 54 test files (53 + 1 new)

- [ ] **Step 7: Commit**

```bash
git add packages/automation/src/adapters/linkedin.ts \
        packages/automation/src/index.ts \
        packages/automation/tests/adapters/linkedin.test.ts
git commit -m "feat(automation): add LinkedIn SiteAdapter with discovery methods (login predicates, search, openListing, detectApplyMethod)"
```

Plain `git commit -m`, no Claude byline.

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-05-03-m11-bucket-2-linkedin-vertical-slice-design.md`):

| Spec requirement | Covered by |
|---|---|
| Discriminated-union refactor of `detectApplyMethod` | Task 1 Step 1 |
| JSDoc softening on M15 framing | Task 1 Step 1 |
| Sync `docs/browser-automation.md` §3 | Task 1 Step 2 |
| Sync bucket-1 design spec | Task 1 Step 3 |
| Adapter-side selector lists (multi-variant arrays) | Task 2 |
| `fastify` devDep on `@vina/automation` | Task 3 Step 1 |
| Shared `startFixtureServer` helper | Task 3 Step 2 |
| Fixture-side selectors mirroring adapter side | Task 4 Step 1 |
| HTML page generators (login, feed, search, 3 detail variants) | Task 4 Step 2 |
| Fastify routes wiring pages onto `startFixtureServer` | Task 4 Step 3 |
| LinkedIn `const linkedInAdapter: SiteAdapter` | Task 5 Step 3 |
| Path-based `onLoginSuccess` and `onSessionExpired` predicates | Task 5 Step 3 |
| `search` async iterator with humanise pause and signal threading | Task 5 Step 3 |
| `openListing` extracts description + salary | Task 5 Step 3 |
| `detectApplyMethod` returns the discriminated union (auto / manual+URL / manual+null) | Task 5 Step 3 |
| Per-suite fixture lifecycle in tests (`beforeAll`/`afterAll`) | Task 5 Step 1 |
| Per-test browser lifecycle (`beforeEach`/`afterEach`) | Task 5 Step 1 |
| 10 test cases covering all 8 adapter members + the abort path | Task 5 Step 1 |
| Adapter writes its own `waitForSelector` before calling `firstVisible` (Bucket 1 carry-forward #1) | Task 5 Step 3 (`waitForSelector(APPLY_BUTTON_ROOT_SELECTOR)` before `firstVisible`) |
| `linkedInAdapter` re-exported from `@vina/automation` barrel | Task 5 Step 4 |

No spec requirement is uncovered.

**2. Placeholder scan:** No `TBD` / `TODO` / `implement later` markers in the plan. Every step shows the exact code or command. Two informative notes ("Note on cross-package import", "Note on path-based predicates") explain non-obvious choices but don't ask the implementer to fill anything in.

**3. Type consistency:**

- `linkedInAdapter` (camelCase) used consistently in adapter.ts, index.ts re-export, and all test imports.
- `LinkedInFixtureHandle` is a type alias of `FixtureServerHandle` — the test imports it from `tests/fixtures/sites/linkedin/server.ts` and uses it for the `let fixture: ...` declaration. Consistent.
- `SearchPreferences` imported from `@vina/shared` consistently in adapter.ts and test.ts; the `PREFS` test fixture matches the schema (`work_models`, `seniority`, etc. — snake_case for the persistence fields, the schema's actual shape).
- The discriminated union shape (`{ method: 'auto' } | { method: 'manual'; externalApplyUrl: string | null }`) is identical in: Task 1 Step 1 (interface), Task 1 Step 2 (browser-automation.md), Task 1 Step 3 (bucket-1 spec), Task 5 Step 3 (adapter return values), Task 5 Step 1 (test assertions).
- Selector constants spelt identically in `linkedin-selectors.ts` (Task 2) and `linkedin.ts` (Task 5 imports them).
- Fixture-side selectors (`APPLY_BUTTON_TEST_ID`, `JOB_TITLE_CLASS`, etc.) used consistently between `selectors.ts` (Task 4 Step 1), `pages.ts` (Task 4 Step 2 imports them), and the rendered HTML structure that Task 5's adapter targets via the adapter-side selectors.
- Test count claims compose: 173 (prior) → 173 (Task 1, type-only change) → 173 (Task 2, no tests) → 173 (Task 3, helper not yet consumed) → 173 (Task 4, fixture not yet consumed) → 183 (Task 5, +10 adapter tests).

**4. Cross-cutting concerns:**

- The `SearchPreferences` test fixture in Task 5 Step 1 includes every required field of the shared schema. If the actual schema in `packages/shared/src/schemas/preferences.ts` has additional required fields (e.g., a `salary_currency` rule, a `score_threshold` constraint), the implementer should adjust `PREFS` to satisfy them. The fields listed match my read of the schema during Bucket 1; if there's drift, Task 5 Step 2's run-and-fail will surface it as a TS error.
- The `salaryText: '$180k – $220k'` assertion uses an em-dash. The fixture HTML in Task 4 Step 2 must use the same character (em-dash, not hyphen). Both occurrences in this plan use the same character — confirm in your editor that the dash matches.

No issues found.
