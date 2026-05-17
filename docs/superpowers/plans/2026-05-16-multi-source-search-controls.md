# Multi-Source Search Controls + Settings UX Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the slice in `docs/superpowers/specs/2026-05-16-multi-source-search-controls-design.md`. Make the UI honest about whether each source is configured (B1), make Search Now respect any active source (B4), let the user pause a source without losing credentials, stop an in-flight discovery, and fix the two Settings UX regressions exposed by the Google Jobs slice (B2 auto-close form, B3 empty-key fence). Everything else stays untouched — Phase B (manual-apply pipeline), Phase C (auto-apply), Indeed, CLI cancel, and per-source score thresholds are out of scope.

**Architecture:** This is a surgical follow-up. Server-side: extend `/api/sites` with `has_credentials`, add an in-memory `taskId → AbortController` map in `packages/server/src/queue/active-tasks.ts`, wire it into the worker's `runOne` (register on start, unregister in `finally`), thread the `AbortSignal` into `runApiSearch` and `runBrowserSearch`, and expose `POST /api/searches/cancel`. Web-side: introduce a single `useSiteStatus(id)` projection that derives `state ∈ 'not_configured' | 'paused' | 'active' | 'key_invalid' | 'quota_exhausted' | 'session_expired'` from `has_credentials`, `enabled`, and open alerts; rewrite the existing `useGoogleJobsStatus` and `useLinkedInStatus` as thin wrappers; add a per-row `<Switch>` to the Settings sites tile bound to `useToggleSite`; auto-close the inline edit-key form on `state === 'not_configured'`; teach `useValidateSerpapiKey` to refuse empty/undefined keys without firing a request; rewrite `SearchNowButton` to handle 0/1/2 active sources, dropping a dropdown when both sources are live; add a Stop button to `SearchActivityPanel` that hits `POST /api/searches/cancel { task_id }` while `phase === 'discovering'`, with `currentTaskId` tracked on `useSearchProgressStore`. Shared: one new event name `search:cancelled` plus its payload schema.

**Tech Stack:** TypeScript, Node ≥20, pnpm workspaces, Fastify + `@fastify/websocket`, better-sqlite3, React 18 + Vite + Tailwind + TanStack Query + Zustand, shadcn/ui, Vitest. **Two net-new third-party packages** are introduced via `npx shadcn@latest add`: `@radix-ui/react-dropdown-menu` (for the multi-source Search Now picker) and `@radix-ui/react-switch` (for the per-row pause toggle). Both come in through shadcn's component generator and are re-themed against the Vina design tokens (`bg-surface-raised`, `border-border-subtle`, `text-ink-*`, `accent`) per ADR-017; do not commit the raw shadcn output. No new server dependencies.

**Status notes from the codebase audit:**

- **`task_queue.status` already allows `'cancelled'`.** Read `packages/server/migrations/001_init.sql` lines 221–238: the CHECK constraint enumerates `'pending', 'running', 'completed', 'failed', 'cancelled'`. **No migration is needed** for this slice. Phase 2 in the design's high-level ordering is effectively skipped — keep the phase number free in the plan for clarity and document the no-op explicitly. The slice ships against migration 003 (already applied for SerpAPI alerts) without bumping schema version.
- **`packages/web/src/components/ui/dropdown-menu.tsx` does NOT exist** at audit time. Only `button.tsx` lives in `components/ui/`. Phase 9 Task A installs it via `pnpm dlx shadcn@latest add dropdown-menu` then re-themes the generated file to Vina tokens (ADR-017). The same task pulls `switch.tsx` for Phase 7 Task B if it isn't already present.
- **`packages/web/src/components/ui/switch.tsx` does NOT exist** at audit time. The Settings tile currently uses plain `<button>` + `<input>` for Edit / Disconnect / Cancel. The per-row toggle Task adds shadcn's Switch and re-themes it.
- **`useToggleSite` already exists** in `packages/web/src/api/resources.ts` (lines 293–304) and posts `PATCH /api/sites/:id { enabled }`. Its `onSuccess` invalidates `['sites']`. It works for both browser- and api-kind sites because the server route is generic (`packages/server/src/http/routes/sites.ts` lines 60–73, with the extra guard `id === 'google' && enabled && !hasSerpApiKey(db) → 409`). **No backend changes are needed for the toggle wire-up itself.**
- **`useSearchProgressStore` does NOT yet track `currentTaskId`.** Read `packages/web/src/store/search-progress-store.ts`: the shape is `{ phase, listingsFound, scoredCount, totalToScore, errorKind, phaseChangedAt }`. Phase 9 Task B extends the store with `currentTaskId?: string` populated by `beginDiscovering({ taskId })` and consumed by the Stop button.
- **The search handler's `serpapiSearch` test seam already accepts a `signal: AbortSignal` parameter** (`packages/server/src/queue/handlers/search.ts` line 62: `opts: { apiKey: string; signal?: AbortSignal }`). The real `searchGoogleJobs` honours the signal (verified in `serpapi-service.test.ts` test "aborts mid-pagination when signal is triggered"). What's missing is the **plumbing** from the worker through `runApiSearch` / `runBrowserSearch` to the iterator. The plumbing must:
  - thread an optional `signal` into `runApiSearch` and pass it through `searchImpl(input, { apiKey, signal })`;
  - thread an optional `signal` into `runBrowserSearch` and check `signal.aborted` at safe yield points (between listings, before `openListing`, after each pagination step);
  - in the worker, before calling the handler, register the task in `active-tasks` and call the handler with `{ signal }` injected via a per-task override **without** changing the public `TaskHandler<P>` signature — pass `signal` by attaching it to a per-invocation deps wrapper or by extending the handler's payload object with a non-persisted `signal` field. See Phase 5 for the chosen approach (recommended: wrap the handler in a closure that captures the signal, since `TaskHandler` is parameterised by `P` and changing it would ripple to score/tailor/apply).
- **`useValidateSerpapiKey` lives in** `packages/web/src/api/resources.ts` lines 500–513. The current implementation passes `key` straight into `api('/api/sites/google/test', { method: 'POST', body: { key } })`. Phase 7 Task A guards the empty case with a synchronous `Promise.resolve({ ok: false, reason: 'empty_key' })`. The `SerpapiValidateResult.reason` union (line 495) gains `'empty_key'`.
- **`useGoogleJobsStatus` derivation lives at** `packages/web/src/api/resources.ts` lines 522–555. It reads `useSites()` and `useAlerts()` but uses `row.session_valid_at || row.enabled` as the proxy for "connected" — that's exactly the B1 bug. Phase 6 lifts the projection into a generic `useSiteStatus(id)` and rewrites both site-specific hooks on top.
- **`SearchNowButton` hard-codes `'linkedin'`** at line 59 of `packages/web/src/components/search/SearchNowButton.tsx`. Phase 9 Task A is a full rewrite of this component.
- **`POST /api/searches/run-now` already accepts any `site_id`** (`packages/server/src/http/routes/searches.ts` lines 17–34) — the fan-out logic for the dropdown lives entirely in the web client; the server is already multi-source ready.
- **`search.test.ts`** (the existing LinkedIn-branch tests for `createSearchHandler`) lives at `packages/server/tests/queue/handlers/search.test.ts`. Existing test seams (`feedUrlOverride`, fake browser manager) stay; the signal-threading change must not break it. Verify a green `pnpm --filter @vina/server test -- search` after each task in Phase 5.
- **The Google Jobs integration test** lives at `packages/server/tests/integration/google-jobs-e2e.test.ts`. Its `makeFixtureSearch` wrapper already preserves `opts.signal` when wrapping `searchGoogleJobs`. Phase 10 extends this file (or adds a sibling) with a cancellation scenario: pump the fixture, fire `cancelActiveTask` mid-iteration, assert listings up to the abort are persisted and the task row's `status` becomes `'cancelled'`.

**Coding conventions reminder (from CLAUDE.md):**

- Strict TypeScript; `kebab-case.ts` for modules, `PascalCase.tsx` for components.
- No default exports except React pages and Vite entrypoints.
- Comment _why_, not _what_; prefer no comments.
- Conventional Commits scoped by package: `feat(server): …`, `feat(web): …`, `fix(web): …`, `test(server): …`, `refactor(web): …`.
- One commit per task; **never** include "Claude" or "Co-Authored-By Claude" in commit messages (per user memory).
- Use the shared `logger` from `@vina/shared`; never `console.log`.
- Throw typed errors that extend `VinaError`; never throw bare strings.
- shadcn-generated files must be re-themed against Vina tokens (ADR-017) before commit. Strip leading lucide-react imports if not used; keep the diff small.

---

## Phase 1 — Server: `/api/sites` adds `has_credentials`

### Task 1: Extend `GET /api/sites` with `has_credentials`

**Files:**
- Modify: `packages/server/src/http/routes/sites.ts`
- Test: `packages/server/tests/http/sites.test.ts` (extend; create if absent — Phase 5 of the Google Jobs slice created `sites.google.test.ts` which can host this block)

**Approach.** The `SiteResponse` interface gains `has_credentials: boolean`. Computation:

- `kind === 'browser'` → `s.session_path !== null` (same predicate the route already uses for `has_session`, so a browser-kind row's `has_credentials === has_session`).
- `kind === 'api'` → `hasSerpApiKey(db)`. The result is the same for every api-kind row today since there is exactly one api-kind site (`google`); the lookup runs once per row. If profiling later shows it matters, hoist outside the `.map`. Not now.
- Any other kind: `false`. Defensive — there are none today.

Mirror the field in the web `SiteResponse` interface so TanStack Query consumers can read `has_credentials` without `any`.

- [ ] **Step 1: Read the current route**

Read `packages/server/src/http/routes/sites.ts` lines 26–58 to confirm the existing `SiteResponse` shape, the `listSites` mapping idiom, and the `hasSerpApiKey` import (already present at line 15). Note that `findSiteById` and `updateSiteEnabled` and `updateSiteSession` are already imported.

- [ ] **Step 2: Write the failing test**

Append a new describe block to `packages/server/tests/http/sites.test.ts` (or create `packages/server/tests/http/sites.has-credentials.test.ts` and use the same `buildTestApp` harness already used by `sites.google.test.ts`):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppHandle } from './helpers.js';
import * as serpapiService from '../../src/services/serpapi-service.js';

let app: TestAppHandle;
beforeEach(async () => {
  app = await buildTestApp();
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('GET /api/sites — has_credentials', () => {
  it('reports has_credentials=false for the linkedin row when no session is on disk', async () => {
    const res = await app.request('GET', '/api/sites');
    const sites = res.json() as Array<{ id: string; has_credentials: boolean; kind: string }>;
    const linkedin = sites.find((s) => s.id === 'linkedin')!;
    expect(linkedin.kind).toBe('browser');
    expect(linkedin.has_credentials).toBe(false);
  });

  it('reports has_credentials=false for the google row when no SerpAPI key is stored', async () => {
    const res = await app.request('GET', '/api/sites');
    const sites = res.json() as Array<{ id: string; has_credentials: boolean }>;
    const google = sites.find((s) => s.id === 'google')!;
    expect(google.has_credentials).toBe(false);
  });

  it('flips google.has_credentials to true after the SerpAPI key is stored', async () => {
    vi.spyOn(serpapiService, 'validateSerpApiKey').mockResolvedValue({
      ok: true,
      latency_ms: 1,
    });
    await app.request('POST', '/api/sites/google/test', { key: 'live-key' });
    const res = await app.request('GET', '/api/sites');
    const sites = res.json() as Array<{ id: string; has_credentials: boolean }>;
    const google = sites.find((s) => s.id === 'google')!;
    expect(google.has_credentials).toBe(true);
  });

  it('flips linkedin.has_credentials to true after the login stub seeds session_path', async () => {
    await app.request('POST', '/api/sites/linkedin/login', {});
    const res = await app.request('GET', '/api/sites');
    const sites = res.json() as Array<{ id: string; has_credentials: boolean }>;
    const linkedin = sites.find((s) => s.id === 'linkedin')!;
    expect(linkedin.has_credentials).toBe(true);
  });
});
```

Verify the exact name of `TestAppHandle.request` against `packages/server/tests/http/helpers.ts` when implementing — it may be `inject` or `app.request`; adapt the assertions accordingly. The fourth case relies on the existing stub `POST /api/sites/:id/login` which writes a synthetic `session_path` (see sites.ts lines 78–94).

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- sites`
Expected: FAIL — the response object has no `has_credentials` key.

- [ ] **Step 4: Update the route**

In `packages/server/src/http/routes/sites.ts`, extend the `SiteResponse` interface and the GET handler:

```ts
interface SiteResponse {
  id: string;
  display_name: string;
  kind: 'browser' | 'api';
  enabled: boolean;
  has_session: boolean;
  /**
   * True when the site has whatever it needs to be usable: a Playwright
   * session on disk for browser-kind rows, a stored SerpAPI key for the
   * single api-kind row. Distinct from `enabled` — a paused source can still
   * have credentials.
   */
  has_credentials: boolean;
  session_valid_at: string | null;
  last_search_at: string | null;
}

app.get(
  '/api/sites',
  async (): Promise<SiteResponse[]> => {
    const serpApiKeyPresent = hasSerpApiKey(db);
    return listSites(db).map((s) => ({
      id: s.id,
      display_name: s.display_name,
      kind: s.kind,
      enabled: s.enabled,
      has_session: s.session_path !== null,
      has_credentials:
        s.kind === 'browser' ? s.session_path !== null :
        s.kind === 'api'     ? serpApiKeyPresent :
        false,
      session_valid_at: s.session_valid_at,
      last_search_at: s.last_search_at,
    }));
  },
);
```

The `serpApiKeyPresent` variable is hoisted out of the `.map` because the design's note about cheap-per-row is fine for the audit, but a single read makes the intent obvious and saves one prepared-statement reuse cycle per row.

- [ ] **Step 5: Run the test + build, expect pass**

Run: `pnpm --filter @vina/server test -- sites && pnpm --filter @vina/server build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/http/routes/sites.ts \
        packages/server/tests/http/sites.test.ts
git commit -m "feat(server): expose has_credentials on GET /api/sites"
```

(Adjust the `tests/http/sites.test.ts` path if you used a new file in Step 2.)

---

## Phase 2 — Schema: `task_queue.status 'cancelled'` (no-op)

### Task 2: Verify `'cancelled'` is already in the `task_queue.status` CHECK and skip the migration

**Files:** none.

**Why this task exists.** The design spec (§2.6) calls out the possibility of a migration `004_task_queue_cancelled.sql`. The audit confirms it isn't needed — `packages/server/migrations/001_init.sql` already enumerates `'cancelled'` in the `task_queue.status` CHECK constraint (lines 234–236). This task is here purely so the implementer **verifies** before assuming.

- [ ] **Step 1: Read the migration**

Open `packages/server/migrations/001_init.sql` lines 221–238. Confirm the CHECK on `task_queue.status` includes `'cancelled'`. Confirm no later migration (`002_linkedin_e2e_schema.sql`, `003_serpapi_alert_kinds.sql`) rebuilds `task_queue` in a way that drops the value.

- [ ] **Step 2: Confirm the existing `task-queue` repository can write `'cancelled'`**

Read `packages/server/src/db/repositories/task-queue.ts`. Confirm there is no enum-restricting TypeScript guard that would reject `'cancelled'` in the `complete` / `fail` / direct-update path. If `fail()` already accepts arbitrary status writes (it does — it takes a `reason` and toggles status to `pending` or `failed`), Phase 5 will need to **add** a small `cancel(db, taskId, reason?)` helper that flips the row to `'cancelled'`. Plan this; do not implement here.

- [ ] **Step 3: No commit**

This task is documentation. Mark it complete in the plan tracker and move on. If the verification surfaces something unexpected (e.g. a later migration rebuilt the table and dropped `'cancelled'`), STOP and add a forward-only `004_task_queue_cancelled.sql` migration before proceeding — but follow the migration-rebuild pattern from `003_serpapi_alert_kinds.sql` since SQLite can't ALTER a CHECK in place.

---

## Phase 3 — Shared types + WS events

### Task 3: Add `search:cancelled` to `@vina/shared` events

**Files:**
- Modify: `packages/shared/src/events.ts`
- Test: `packages/shared/tests/events.test.ts`

**Approach.** Three changes, in order:

1. Add `SEARCH_CANCELLED: 'search:cancelled'` to the `EVENTS` const.
2. Define `SearchCancelledPayload`:

```ts
const SearchCancelledPayload = z.object({
  task_id: z.string(),
  site_id: z.string(),
  listings_added: z.number().int().nonnegative(),
  scored: z.number().int().nonnegative(),
});
```

3. Wire it into `EVENT_PAYLOADS` using the `EVENTS.SEARCH_CANCELLED` key. The `satisfies Record<EventName, z.ZodTypeAny>` constraint forces this — TypeScript will block a missing entry.

The shape mirrors `SearchCompletedPayload` because, semantically, a cancelled search **did** discover some listings before being aborted — the UI wants to report "Done · cancelled · 3 scored" (per spec §5.3). `listings_added` and `scored` are non-negative counters; `task_id` and `site_id` follow the same naming as the other search events.

- [ ] **Step 1: Read the existing events catalog**

Read `packages/shared/src/events.ts` end-to-end. Confirm the `EVENTS` constant, the `EVENT_PAYLOADS` map's `satisfies` clause, and the `EventPayloadFor<T>` helper. The new entry slots in next to `SEARCH_FAILED`.

- [ ] **Step 2: Write the failing test**

Append to `packages/shared/tests/events.test.ts`:

```ts
describe('EVENTS — multi-source slice additions', () => {
  it('includes SEARCH_CANCELLED', () => {
    expect((EVENTS as Record<string, string>)['SEARCH_CANCELLED']).toBe('search:cancelled');
  });

  it('search:cancelled payload validates listings_added and scored', () => {
    const schema = EVENT_PAYLOADS['search:cancelled'];
    expect(() =>
      schema.parse({
        task_id: 't1',
        site_id: 'google',
        listings_added: 3,
        scored: 2,
      }),
    ).not.toThrow();
  });

  it('search:cancelled payload rejects negative counts', () => {
    const schema = EVENT_PAYLOADS['search:cancelled'];
    expect(() =>
      schema.parse({ task_id: 't1', site_id: 'google', listings_added: -1, scored: 0 }),
    ).toThrow();
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/shared test -- events`
Expected: FAIL — `SEARCH_CANCELLED` is undefined; `EVENT_PAYLOADS['search:cancelled']` is undefined.

- [ ] **Step 4: Extend the catalog**

In `packages/shared/src/events.ts`, append to `EVENTS` (after `SEARCH_FAILED`, before `LINKEDIN_SESSION_EXPIRED`):

```ts
SEARCH_CANCELLED: 'search:cancelled',
```

Define the payload schema below `SearchFailedPayload`:

```ts
const SearchCancelledPayload = z.object({
  task_id: z.string(),
  site_id: z.string(),
  listings_added: z.number().int().nonnegative(),
  scored: z.number().int().nonnegative(),
});
```

Add to `EVENT_PAYLOADS`:

```ts
[EVENTS.SEARCH_CANCELLED]: SearchCancelledPayload,
```

- [ ] **Step 5: Run the test + build, expect pass**

Run: `pnpm --filter @vina/shared test -- events && pnpm --filter @vina/shared build`
Expected: PASS. Confirm the downstream server / web `pnpm build` still passes after rebuild — the `satisfies` clause means a missing entry would break compilation of every dependent.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/events.ts packages/shared/tests/events.test.ts
git commit -m "feat(shared): add search:cancelled event"
```

---

## Phase 4 — Server: active-tasks map + cancel route

### Task 4A: `active-tasks` registry module

**Files:**
- Create: `packages/server/src/queue/active-tasks.ts`
- Test: `packages/server/tests/queue/active-tasks.test.ts` (create)

**Approach.** A small process-local module with no external state. Stores `taskId → { signal, abort, site_id }`. Exports four functions:

```ts
export function registerActiveTask(taskId: string, site_id: string): AbortSignal;
export function unregisterActiveTask(taskId: string): void;
export function cancelActiveTask(taskId: string): boolean;
export function cancelTasksForSite(site_id: string): number;
```

The module is intentionally not a class — testing it as a singleton matches how it'll be used (the worker imports the functions directly). For tests, expose `_resetActiveTasksForTests()` to clear the map between cases.

- [ ] **Step 1: Confirm there's no existing `active-tasks` module**

Run: `find packages/server/src -name 'active-tasks*'` — expected empty. Confirm nothing imports a similar name. The new module lives in `packages/server/src/queue/` next to `worker.ts`.

- [ ] **Step 2: Write the failing test**

Create `packages/server/tests/queue/active-tasks.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  cancelActiveTask,
  cancelTasksForSite,
  registerActiveTask,
  unregisterActiveTask,
  _resetActiveTasksForTests,
} from '../../src/queue/active-tasks.js';

afterEach(() => _resetActiveTasksForTests());

describe('active-tasks registry', () => {
  it('register returns a fresh signal, abort flips signal.aborted', () => {
    const signal = registerActiveTask('t1', 'google');
    expect(signal.aborted).toBe(false);
    expect(cancelActiveTask('t1')).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it('cancelActiveTask returns false when the task is unknown', () => {
    expect(cancelActiveTask('nonexistent')).toBe(false);
  });

  it('unregisterActiveTask removes the task without aborting', () => {
    const signal = registerActiveTask('t2', 'google');
    unregisterActiveTask('t2');
    expect(cancelActiveTask('t2')).toBe(false);
    expect(signal.aborted).toBe(false);
  });

  it('cancelTasksForSite aborts every task on that site and returns the count', () => {
    const s1 = registerActiveTask('a', 'google');
    const s2 = registerActiveTask('b', 'google');
    const s3 = registerActiveTask('c', 'linkedin');
    expect(cancelTasksForSite('google')).toBe(2);
    expect(s1.aborted).toBe(true);
    expect(s2.aborted).toBe(true);
    expect(s3.aborted).toBe(false);
  });

  it('registering the same taskId twice replaces the prior entry without leaking', () => {
    const s1 = registerActiveTask('dupe', 'google');
    const s2 = registerActiveTask('dupe', 'google');
    expect(s1).not.toBe(s2);
    expect(cancelActiveTask('dupe')).toBe(true);
    expect(s2.aborted).toBe(true);
    // The first signal is orphaned by design — register-after-register is a
    // misuse, but the module shouldn't leak the prior signal as still-cancellable.
    expect(cancelActiveTask('dupe')).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- active-tasks`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Create the module**

Create `packages/server/src/queue/active-tasks.ts`:

```ts
import { createLogger } from '@vina/shared';

const log = createLogger('queue.active-tasks');

interface ActiveEntry {
  signal: AbortSignal;
  abort: () => void;
  site_id: string;
}

const activeTasks = new Map<string, ActiveEntry>();

export function registerActiveTask(taskId: string, site_id: string): AbortSignal {
  if (activeTasks.has(taskId)) {
    log.warn({ task_id: taskId }, 'registerActiveTask: replacing existing entry');
    activeTasks.delete(taskId);
  }
  const ac = new AbortController();
  activeTasks.set(taskId, { signal: ac.signal, abort: () => ac.abort(), site_id });
  return ac.signal;
}

export function unregisterActiveTask(taskId: string): void {
  activeTasks.delete(taskId);
}

export function cancelActiveTask(taskId: string): boolean {
  const entry = activeTasks.get(taskId);
  if (!entry) return false;
  entry.abort();
  activeTasks.delete(taskId);
  return true;
}

export function cancelTasksForSite(site_id: string): number {
  let n = 0;
  for (const [id, entry] of activeTasks) {
    if (entry.site_id === site_id) {
      entry.abort();
      activeTasks.delete(id);
      n += 1;
    }
  }
  return n;
}

/** Test seam. Not exported through the package index. */
export function _resetActiveTasksForTests(): void {
  activeTasks.clear();
}
```

Note the `cancelActiveTask` and `cancelTasksForSite` paths delete the entry after aborting. That mirrors what the worker's `finally` block will do, but doing it here too means a redundant cancel from the HTTP route never lingers in the map. The unit test asserts this explicitly via the "registering twice / cancelling twice" scenario.

- [ ] **Step 5: Run the test + build, expect pass**

Run: `pnpm --filter @vina/server test -- active-tasks && pnpm --filter @vina/server build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/queue/active-tasks.ts \
        packages/server/tests/queue/active-tasks.test.ts
git commit -m "feat(server): add active-tasks registry for in-flight task cancellation"
```

---

### Task 4B: `POST /api/searches/cancel` route

**Files:**
- Modify: `packages/server/src/http/routes/searches.ts`
- Test: `packages/server/tests/http/searches.cancel.test.ts` (create) — or extend the existing `searches.test.ts` if it exists.

**Approach.** Accept `{ task_id?: string; site_id?: string }`. At least one of the two must be present; if both are present, prefer `task_id` (more specific). Return `200 { cancelled: number }`. **Never** 404 — the design explicitly says absence is not an error so the UI can fire-and-forget on a race.

The route is read-only against the DB — it only touches the in-memory `active-tasks` map. The status flip to `'cancelled'` happens inside the search handler's `finally` block when the iterator returns due to `signal.aborted`. That seam lives in Phase 5.

- [ ] **Step 1: Read the existing searches route**

Read `packages/server/src/http/routes/searches.ts` end-to-end. Note the `BodySchema` pattern, the `parse` helper import, and the `poke` injection (we don't need `poke` for cancel — cancelling doesn't need to wake the worker).

- [ ] **Step 2: Write the failing test**

Create `packages/server/tests/http/searches.cancel.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppHandle } from './helpers.js';
import {
  registerActiveTask,
  _resetActiveTasksForTests,
} from '../../src/queue/active-tasks.js';

let app: TestAppHandle;
beforeEach(async () => {
  app = await buildTestApp();
  _resetActiveTasksForTests();
});
afterEach(async () => {
  _resetActiveTasksForTests();
  await app.close();
});

describe('POST /api/searches/cancel', () => {
  it('cancels by task_id and aborts the registered signal', async () => {
    const signal = registerActiveTask('t-known', 'google');
    const res = await app.request('POST', '/api/searches/cancel', { task_id: 't-known' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cancelled: 1 });
    expect(signal.aborted).toBe(true);
  });

  it('cancels by site_id and aborts every signal on that site', async () => {
    const s1 = registerActiveTask('a', 'google');
    const s2 = registerActiveTask('b', 'google');
    const s3 = registerActiveTask('c', 'linkedin');
    const res = await app.request('POST', '/api/searches/cancel', { site_id: 'google' });
    expect(res.json()).toEqual({ cancelled: 2 });
    expect(s1.aborted).toBe(true);
    expect(s2.aborted).toBe(true);
    expect(s3.aborted).toBe(false);
  });

  it('returns cancelled:0 when the task_id is unknown (200, not 404)', async () => {
    const res = await app.request('POST', '/api/searches/cancel', { task_id: 'ghost' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cancelled: 0 });
  });

  it('prefers task_id when both are provided', async () => {
    const signal = registerActiveTask('only-this-one', 'google');
    const other = registerActiveTask('other', 'google');
    const res = await app.request('POST', '/api/searches/cancel', {
      task_id: 'only-this-one',
      site_id: 'google',
    });
    expect(res.json()).toEqual({ cancelled: 1 });
    expect(signal.aborted).toBe(true);
    expect(other.aborted).toBe(false);
  });

  it('rejects requests with neither task_id nor site_id', async () => {
    const res = await app.request('POST', '/api/searches/cancel', {});
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- searches.cancel`
Expected: FAIL — route does not exist; all requests 404.

- [ ] **Step 4: Add the route**

In `packages/server/src/http/routes/searches.ts`, append a new handler. Note that this needs an explicit "at least one" refinement on the zod schema (`z.object({...}).refine(...)`) rather than `.optional()` on both because Fastify will accept `{}` without the refinement:

```ts
import {
  cancelActiveTask,
  cancelTasksForSite,
} from '../../queue/active-tasks.js';

const CancelBodySchema = z
  .object({
    task_id: z.string().min(1).optional(),
    site_id: z.string().min(1).optional(),
  })
  .refine((b) => b.task_id || b.site_id, {
    message: 'task_id or site_id must be provided',
  });

app.post('/api/searches/cancel', async (req) => {
  const body = parse(CancelBodySchema, req.body, 'request body');
  if (body.task_id) {
    const cancelled = cancelActiveTask(body.task_id) ? 1 : 0;
    return { cancelled };
  }
  // body.site_id is guaranteed by the refine().
  const cancelled = cancelTasksForSite(body.site_id!);
  return { cancelled };
});
```

The `parse` helper raises a `ValidationError` which the Fastify error handler maps to a 400 — that's where the "neither provided" 400 case lands.

- [ ] **Step 5: Run the test + build, expect pass**

Run: `pnpm --filter @vina/server test -- searches.cancel && pnpm --filter @vina/server build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/http/routes/searches.ts \
        packages/server/tests/http/searches.cancel.test.ts
git commit -m "feat(server): add POST /api/searches/cancel route"
```

---

## Phase 5 — Server: thread `AbortSignal` through the search handler

### Task 5: Worker registers AbortController + handler honours the signal + task row flips to `'cancelled'`

**Files:**
- Modify: `packages/server/src/queue/worker.ts`
- Modify: `packages/server/src/queue/handlers/search.ts`
- Modify: `packages/server/src/db/repositories/task-queue.ts` (add a `cancel(db, taskId, reason?)` helper)
- Test: `packages/server/tests/queue/handlers/search.cancel.test.ts` (create)
- Test: `packages/server/tests/queue/worker.cancel.test.ts` (create)
- Verify: existing `search.test.ts` and `search.google.test.ts` stay green without modification.

**Design constraints.**

1. The `TaskHandler<P>` signature must not change — it ripples into `score`, `tailor`, `apply`. Instead, the worker creates an `AbortController` per task, registers it in `active-tasks`, and **passes the signal into the handler by appending it onto the parsed payload object** (`payload._signal = signal`). The `search` handler reads `(payload as { _signal?: AbortSignal })._signal` when constructing the iterator opts. The leading underscore signals "transient field, not persisted." Alternative considered: wrap each handler in a closure that injects via a closure-over-scope `WeakMap`. Rejected — clunkier and harder to test in isolation. The payload-tagging approach keeps everything visible at the call site.
2. The handler must honour `signal.aborted` at safe yield points. For the api branch, that's "before each `for await` iteration" (already supported by `searchGoogleJobs`'s test). For the browser branch, that's "after each listing yielded from the adapter iterator" and "after each pagination step." The handler stops iterating, persists what it has, and **throws an `AbortedError`** so the worker's catch path sees a recognisable error type.
3. On `AbortedError`, the worker calls `cancel(db, task.id)` — a new repository helper that flips the row to `status='cancelled'` (the CHECK already allows it; see Phase 2) and writes `reason='cancelled_by_user'` into `failed_reason`. The worker also emits `search:cancelled` via `deps.bus` from the handler before re-throwing, so the UI sees counts.

**Approach in order.**

A. Add `AbortedError` to `packages/server/src/queue/handlers/errors.ts`.
B. Add `cancel(db, taskId, reason?)` to `packages/server/src/db/repositories/task-queue.ts`.
C. Update the worker:
   - in `runOne`, after parsing the payload, if `task.kind === 'search'`, derive `site_id` from `payload.site_id` and call `registerActiveTask(task.id, site_id)`. Attach the returned signal to the payload object via `(payload as Record<string, unknown>)._signal = signal`. In `finally`, call `unregisterActiveTask(task.id)`.
   - on a catch, if `err instanceof AbortedError`, call `cancel(db, task.id, 'cancelled_by_user')` instead of `fail(...)`, and **do not** call `onTerminalFailure` (cancellation is not a failure).
D. Update `runApiSearch`:
   - read the optional `_signal` off the payload.
   - pass it through to `searchImpl(input, { apiKey, signal })`.
   - wrap the `for await` loop in a try/finally that records `listingsAdded` / `scoredEnqueued` on a captured outer variable.
   - if `signal?.aborted` after the loop (or on a thrown `DOMException` with name `'AbortError'`), emit `search:cancelled { task_id, site_id, listings_added, scored }`, persist `last_search_at`, and throw `AbortedError`.
E. Update `runBrowserSearch`:
   - thread the optional `_signal` through the same way.
   - check `signal?.aborted` between the listing iteration and the per-listing insert; check again at the end of each pagination step (verify the adapter's iterator interface — `iterateLinkedInCards` doesn't take a signal natively at audit time; if so, leave the deep abort to "after each yielded listing" and document the limitation in a code comment).
   - if aborted, emit `search:cancelled` and throw `AbortedError`.

- [ ] **Step 1: Read the existing handler and worker**

Read:
- `packages/server/src/queue/worker.ts` lines 113–157 (`runOne` body).
- `packages/server/src/queue/handlers/search.ts` lines 216–229 (`createSearchHandler` dispatcher) and 588–680 (`runApiSearch`).
- `packages/server/src/queue/handlers/errors.ts` (where `LinkedInSessionExpiredError` lives).
- `packages/server/src/db/repositories/task-queue.ts` (note the existing `complete` / `fail` / `setNextAttemptAt` helpers; the new `cancel` mirrors `complete`'s shape).

Confirm `iterateLinkedInCards` exports and whether the LinkedIn adapter's `search` method accepts a signal. If it doesn't, plan the abort check to happen between listings rather than inside the adapter's iterator.

- [ ] **Step 2: Write the failing tests**

Create `packages/server/tests/queue/handlers/search.cancel.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { createSearchHandler } from '../../../src/queue/handlers/search.js';
import { AbortedError } from '../../../src/queue/handlers/errors.js';
import { createEventBus, type EventBus } from '../../../src/events/bus.js';
import { setSerpApiKey } from '../../../src/services/settings-service.js';
import { upsertSearchPreferences } from '../../../src/db/repositories/search-preferences.js';
import { listJobs } from '../../../src/db/repositories/jobs.js';
import type { GoogleJobsListing } from '../../../src/services/serpapi-service.js';
import { freshTestDb } from '../../db/helpers.js';

let db: DatabaseType;
beforeEach(() => {
  db = freshTestDb();
  upsertSearchPreferences(db, {
    description: 'Senior backend',
    keywords: ['typescript'],
    locations: ['Remote'],
    work_models: ['remote'],
    seniority: ['senior'],
    excluded_companies: [],
  });
});
afterEach(() => db.close());

const FAKE_BM = {
  getContext: async () => ({ newPage: async () => ({}) }),
  closeAll: async () => {},
} as never;

const listing = (id: string): GoogleJobsListing => ({
  external_id: id,
  title: `Engineer ${id}`,
  company: 'Acme',
  location: 'Remote',
  description: '…',
  via: 'via Greenhouse',
  apply_url: `https://gh.io/${id}`,
  salary_text: '$180K',
});

describe('search handler — cancellation (api branch)', () => {
  it('honours signal.aborted mid-iteration: persists listings up to abort, throws AbortedError, emits search:cancelled', async () => {
    setSerpApiKey(db, 'k');
    const bus: EventBus = createEventBus();
    const events: Array<{ name: string; payload: unknown }> = [];
    bus.on('search:cancelled', (payload) => events.push({ name: 'search:cancelled', payload }));
    bus.on('search:completed', (payload) => events.push({ name: 'search:completed', payload }));

    const ac = new AbortController();
    let yielded = 0;

    async function* iter(_input: unknown, opts: { signal?: AbortSignal }): AsyncIterable<GoogleJobsListing> {
      for (const id of ['a', 'b', 'c', 'd']) {
        if (opts.signal?.aborted) return;
        yielded += 1;
        yield listing(id);
        if (id === 'b') ac.abort(); // cancel after the second listing
      }
    }

    const handler = createSearchHandler({
      db,
      bus,
      browserManager: FAKE_BM,
      adapters: {},
      serpapiSearch: iter as never,
    });

    await expect(
      handler({ site_id: 'google', task_id: 't1', _signal: ac.signal } as never),
    ).rejects.toBeInstanceOf(AbortedError);

    expect(yielded).toBe(2);
    const jobs = listJobs(db, { site_id: 'google' });
    expect(jobs.map((j) => j.external_id).sort()).toEqual(['a', 'b']);

    expect(events.some((e) => e.name === 'search:cancelled')).toBe(true);
    expect(events.some((e) => e.name === 'search:completed')).toBe(false);
  });

  it('cancellation before any listing yields: persists nothing, still emits search:cancelled with zero counts', async () => {
    setSerpApiKey(db, 'k');
    const bus = createEventBus();
    const events: Array<{ name: string; payload: unknown }> = [];
    bus.on('search:cancelled', (p) => events.push({ name: 'search:cancelled', payload: p }));

    const ac = new AbortController();
    ac.abort(); // pre-aborted

    async function* iter(_i: unknown, opts: { signal?: AbortSignal }): AsyncIterable<GoogleJobsListing> {
      if (opts.signal?.aborted) return;
      yield listing('never');
    }

    const handler = createSearchHandler({
      db,
      bus,
      browserManager: FAKE_BM,
      adapters: {},
      serpapiSearch: iter as never,
    });

    await expect(
      handler({ site_id: 'google', task_id: 't1', _signal: ac.signal } as never),
    ).rejects.toBeInstanceOf(AbortedError);

    expect(listJobs(db, { site_id: 'google' }).length).toBe(0);
    const cancelled = events.find((e) => e.name === 'search:cancelled')!;
    expect(cancelled.payload).toMatchObject({ task_id: 't1', site_id: 'google', listings_added: 0, scored: 0 });
  });
});
```

Create `packages/server/tests/queue/worker.cancel.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { createWorker } from '../../src/queue/worker.js';
import { createEventBus } from '../../src/events/bus.js';
import { enqueue, findById } from '../../src/db/repositories/task-queue.js';
import {
  cancelActiveTask,
  _resetActiveTasksForTests,
} from '../../src/queue/active-tasks.js';
import { freshTestDb } from '../db/helpers.js';

let db: DatabaseType;
beforeEach(() => {
  db = freshTestDb();
  _resetActiveTasksForTests();
});
afterEach(() => {
  _resetActiveTasksForTests();
  db.close();
});

describe('worker cancellation wiring', () => {
  it('registers the search task on start, unregisters on completion', async () => {
    let observedSignalDuringRun: AbortSignal | undefined;
    const worker = createWorker({
      db,
      bus: createEventBus(),
      pollIntervalMs: 50,
      handlers: {
        search: async (payload) => {
          observedSignalDuringRun = (payload as { _signal?: AbortSignal })._signal;
        },
      },
    });
    const task = enqueue(db, { kind: 'search', payload: { site_id: 'google' } });
    worker.start();
    worker.poke();

    // Wait for the row to flip to completed.
    await new Promise((r) => setTimeout(r, 200));
    await worker.stop(2_000);

    expect(observedSignalDuringRun).toBeDefined();
    expect(observedSignalDuringRun!.aborted).toBe(false);

    // After completion the registry should be clean — cancelling the
    // now-finished task returns false.
    expect(cancelActiveTask(task.id)).toBe(false);
  });

  it('on AbortedError, flips task row status to cancelled (not failed)', async () => {
    const worker = createWorker({
      db,
      bus: createEventBus(),
      pollIntervalMs: 50,
      handlers: {
        search: async (payload) => {
          const signal = (payload as { _signal?: AbortSignal })._signal;
          // Wait until the test cancels.
          await new Promise<void>((resolve, reject) => {
            if (signal?.aborted) return reject(new (await import('../../src/queue/handlers/errors.js')).AbortedError());
            signal?.addEventListener('abort', () =>
              import('../../src/queue/handlers/errors.js').then(({ AbortedError }) => reject(new AbortedError())),
            );
          });
        },
      },
    });
    const task = enqueue(db, { kind: 'search', payload: { site_id: 'google' } });
    worker.start();
    worker.poke();
    await new Promise((r) => setTimeout(r, 50));

    expect(cancelActiveTask(task.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    await worker.stop(2_000);

    const row = findById(db, task.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.failed_reason).toBe('cancelled_by_user');
  });
});
```

Verify `findById` is exported from `task-queue.ts`. If not, add it as a small helper in the same task as `cancel`.

- [ ] **Step 3: Run the tests, expect failure**

Run: `pnpm --filter @vina/server test -- search.cancel worker.cancel`
Expected: FAIL — `AbortedError` doesn't exist; `cancel` repository helper doesn't exist; worker doesn't register active tasks; handler doesn't honour `_signal`.

- [ ] **Step 4: Implement**

**(a) Add `AbortedError` to `packages/server/src/queue/handlers/errors.ts`:**

```ts
export class AbortedError extends Error {
  readonly code = 'aborted' as const;
  constructor(message = 'task was cancelled') {
    super(message);
    this.name = 'AbortedError';
  }
}
```

**(b) Add `cancel` to `packages/server/src/db/repositories/task-queue.ts`:**

```ts
export function cancel(db: DatabaseType, taskId: string, reason = 'cancelled_by_user'): void {
  db.prepare(
    `UPDATE task_queue
     SET status = 'cancelled', failed_reason = ?
     WHERE id = ? AND status IN ('pending', 'running')`,
  ).run(reason, taskId);
}
```

The `AND status IN ('pending', 'running')` clause makes the call idempotent against tasks already completed / failed — a late cancel from the HTTP route never rewrites history.

Also export `findById(db, taskId)` if not already present, for the worker test:

```ts
export function findById(db: DatabaseType, taskId: string): Task | null {
  const row = db.prepare(`SELECT * FROM task_queue WHERE id = ?`).get(taskId) as RawTaskRow | undefined;
  return row ? rowToTask(row) : null;
}
```

**(c) Wire the worker.** In `packages/server/src/queue/worker.ts`, update `runOne`:

```ts
import {
  registerActiveTask,
  unregisterActiveTask,
} from './active-tasks.js';
import { cancel as cancelTaskRow } from '../db/repositories/task-queue.js';
import { AbortedError } from './handlers/errors.js';

async function runOne(task: Task): Promise<void> {
  // … existing handler/payload-parse code …

  let signal: AbortSignal | undefined;
  if (task.kind === 'search') {
    const siteId = (payload as { site_id?: string }).site_id ?? 'unknown';
    signal = registerActiveTask(task.id, siteId);
    (payload as Record<string, unknown>)._signal = signal;
  }

  try {
    const timeoutMs = options.timeoutsMs?.[task.kind] ?? DEFAULT_TIMEOUTS_MS[task.kind];
    await runWithTimeout(handler(payload), timeoutMs, task.kind);
    complete(options.db, task.id);
  } catch (err) {
    if (err instanceof AbortedError) {
      cancelTaskRow(options.db, task.id, 'cancelled_by_user');
      // Intentionally do NOT call onTerminalFailure — cancellation is the
      // user's choice and shouldn't trip alert paths.
      log.info({ task_id: task.id, kind: task.kind }, 'task cancelled');
    } else {
      // existing retry / fail logic, unchanged
    }
  } finally {
    if (task.kind === 'search') unregisterActiveTask(task.id);
  }

  emitCounts();
}
```

**(d) Update `runApiSearch` in `packages/server/src/queue/handlers/search.ts`** to read `_signal` and emit `search:cancelled` on abort:

```ts
async function runApiSearch(
  deps: SearchHandlerDeps,
  site: SiteRow,
  payload: SearchPayload & { _signal?: AbortSignal },
): Promise<void> {
  const signal = payload._signal;
  // … existing prefs / search:started emit / apiKey checks …

  let listingsAdded = 0;
  let scoredEnqueued = 0;
  const inFlightScoreIds = getInFlightScoreJobIds(deps.db);
  const updatedJobIds: string[] = [];
  let aborted = false;

  try {
    for await (const listing of searchImpl(input, { apiKey, signal })) {
      if (signal?.aborted) { aborted = true; break; }
      try {
        const job = insertJob(deps.db, { /* unchanged */ });
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

    if (updatedJobIds.length > 0) deps.bus.emit('jobs:updated', { ids: updatedJobIds });
    updateSiteSession(deps.db, site.id, { last_search_at: new Date().toISOString() });

    if (aborted || signal?.aborted) {
      deps.bus.emit('search:cancelled', {
        task_id: payload.task_id ?? 'unknown',
        site_id: site.id,
        listings_added: listingsAdded,
        scored: scoredEnqueued,
      });
      throw new AbortedError();
    }

    if (payload.schedule_id) resetScheduleFailures(deps.db, payload.schedule_id);
    deps.bus.emit('search:completed', { /* unchanged */ });
  } catch (err) {
    if (err instanceof AbortedError) throw err; // already emitted search:cancelled
    // existing alert mapping path, unchanged
  }
}
```

The `AbortedError` thrown from within the success path (after `aborted=true`) re-enters the outer catch, hits the `instanceof` guard, and rethrows unchanged. The worker catches it and flips the row to `'cancelled'`.

**(e) Update `runBrowserSearch`** with the same pattern. Insert `if (signal?.aborted) { aborted = true; break; }` checks:
   - between the listings buffer build and the per-listing insert loop (line ~358 in the audit dump);
   - inside the per-listing insert loop (after each `insertJob` success);
   - between the discovery success path and the post-loop bookkeeping.

   On `aborted`, emit `search:cancelled` (with the running counts) and throw `AbortedError` before the existing `search:completed` emit.

   If the LinkedIn adapter's `iterateLinkedInCards` doesn't accept a signal, we accept that mid-iteration aborts in the browser path will only fire **between** listings rather than mid-network-call. That's good enough for the user-visible "Stop search" — the worst case is a 2–5s lag while one more listing finishes.

**(f) Update the dispatcher** in `createSearchHandler` to cast the payload to include `_signal`:

```ts
return async (payload) => {
  const p = payload as SearchPayload & { _signal?: AbortSignal };
  const site = findSiteById(deps.db, p.site_id);
  if (!site) throw new ValidationError(`Unknown site_id: ${p.site_id}`);

  if (site.kind === 'api') return runApiSearch(deps, site, p);

  const adapter = deps.adapters[site.id];
  if (!adapter) throw new ValidationError(`No adapter registered for site: ${site.id}`);
  return runBrowserSearch(deps, site, adapter, p);
};
```

- [ ] **Step 5: Run the tests, expect pass**

Run all of these:
- `pnpm --filter @vina/server test -- search.cancel worker.cancel`
- `pnpm --filter @vina/server test -- search` (must not regress; both the existing LinkedIn `search.test.ts` and the api `search.google.test.ts` stay green).
- `pnpm --filter @vina/server test -- worker` (existing worker tests).
- `pnpm --filter @vina/server build`

Expected: PASS across the board. If `worker.test.ts` regresses, the most likely culprit is the unregister-in-finally — verify it doesn't run for non-search kinds.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/queue/handlers/errors.ts \
        packages/server/src/queue/handlers/search.ts \
        packages/server/src/queue/worker.ts \
        packages/server/src/db/repositories/task-queue.ts \
        packages/server/tests/queue/handlers/search.cancel.test.ts \
        packages/server/tests/queue/worker.cancel.test.ts
git commit -m "feat(server): thread AbortSignal through search handler and worker"
```

---

## Phase 6 — Web: `useSiteStatus` generic hook + cancel mutation

### Task 6A: Introduce `useSiteStatus(id)` and refactor existing per-site hooks

**Files:**
- Modify: `packages/web/src/api/resources.ts`
- Test: `packages/web/tests/api/resources.site-status.test.tsx` (create)
- Verify: `packages/web/tests/api/resources.google.test.tsx` (Google Jobs slice's existing test) stays green without modification.

**Approach.** The generic projection lives at the top of the Google Jobs section in `resources.ts`. Both `useGoogleJobsStatus` and `useLinkedInStatus` become thin wrappers that narrow the `SiteState` union. The web `SiteResponse` interface gains `has_credentials: boolean` to match the server.

```ts
export type SiteState =
  | 'not_configured'    // !has_credentials
  | 'paused'            // has_credentials && !enabled
  | 'active'            // has_credentials && enabled && no degraded alerts
  | 'key_invalid'       // api-kind only, derived from open alert
  | 'quota_exhausted'   // api-kind only, derived from open alert
  | 'session_expired';  // browser-kind only, derived from open alert

export interface SiteStatus {
  state: SiteState;
  enabled: boolean;
  has_credentials: boolean;
  last_search_at: string | null;
}

export function useSiteStatus(id: string, opts: { pollMs?: number } = {}): {
  data: SiteStatus | null;
  isLoading: boolean;
};
```

Precedence (highest first): `key_invalid` > `quota_exhausted` > `session_expired` > `active` > `paused` > `not_configured`. The `session_expired` derivation reads the LinkedIn connect-service status (the existing `/api/sites/linkedin/status` endpoint returns `{ connected, attempting, last_success_at, error }`) — if `error !== null && id === 'linkedin'`, the state is `session_expired`. For api-kind, the alert kinds `serpapi_key_invalid` and `serpapi_quota_exhausted` map directly.

`useGoogleJobsStatus` becomes:

```ts
export function useGoogleJobsStatus(opts: { pollMs?: number } = {}): {
  data: GoogleJobsStatus | null;
  isLoading: boolean;
} {
  const inner = useSiteStatus('google', opts);
  if (!inner.data) return { data: null, isLoading: inner.isLoading };
  // The api-kind state union is the same minus 'session_expired'.
  return {
    data: {
      state: inner.data.state as GoogleJobsState,
      enabled: inner.data.enabled,
      last_search_at: inner.data.last_search_at,
    },
    isLoading: inner.isLoading,
  };
}
```

Keep the existing `GoogleJobsState` and `GoogleJobsStatus` types exported — call sites import them. Update `GoogleJobsState` to drop `'connected'` in favour of `'active' | 'paused' | 'not_configured' | 'key_invalid' | 'quota_exhausted'` — the renaming is the heart of B1 (active means active, not "has any credential"). **Verify** callers in `SitesTile.tsx` and any wizard step before the rename; update those call sites in this same task to avoid breaking the build. The SitesTile state-derivation pattern (lines 46–68) explicitly switches on `'connected' | 'key_invalid' | 'quota_exhausted' | (default)` — those branches become `'active'` / `'paused'` / etc. (see Phase 8 for the full SitesTile rewrite — this task only renames the type and updates the call site enough to compile).

`useLinkedInStatus` keeps its existing public shape (`{ connected, attempting, last_success_at, error }`) **because** the connect flow needs richer info (`attempting` for the "Connecting…" button state, `last_success_at` for the timestamp). Add a sibling `useLinkedInSiteStatus` that returns the generic `SiteStatus` shape, used by the new SearchNowButton and by SitesTile's per-row state derivation. The existing `useLinkedInStatus` continues to back the connect-attempt UI.

- [ ] **Step 1: Read the existing hooks and call sites**

Read:
- `packages/web/src/api/resources.ts` lines 275–342 (sites + LinkedIn hooks), 489–586 (Google Jobs hooks).
- `packages/web/src/routes/settings/SitesTile.tsx` lines 46–68 (state switch).
- `packages/web/src/components/search/SearchNowButton.tsx` (current LinkedIn-only logic).

Confirm `useAlerts` returns `{ data: Alert[]; isLoading: boolean }`. Confirm `Alert` has `kind`, `site_id`, `status` (it does, from the existing usage).

- [ ] **Step 2: Write the failing test**

Create `packages/web/tests/api/resources.site-status.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSiteStatus } from '../../src/api/resources.js';

afterEach(() => vi.restoreAllMocks());

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function mockSites(rows: Array<Record<string, unknown>>): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith('/api/sites')) {
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (u.includes('/api/alerts')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    return new Response('{}', { status: 200 });
  });
}

describe('useSiteStatus', () => {
  it('returns not_configured when has_credentials=false regardless of enabled', async () => {
    mockSites([
      { id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: true,
        has_session: false, has_credentials: false, session_valid_at: null, last_search_at: null },
    ]);
    const { result } = renderHook(() => useSiteStatus('google'), { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(result.current.data?.state).toBe('not_configured'));
    expect(result.current.data?.has_credentials).toBe(false);
  });

  it('returns paused when has_credentials=true && enabled=false', async () => {
    mockSites([
      { id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: false,
        has_session: false, has_credentials: true, session_valid_at: null, last_search_at: null },
    ]);
    const { result } = renderHook(() => useSiteStatus('google'), { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(result.current.data?.state).toBe('paused'));
  });

  it('returns active when has_credentials=true && enabled=true with no degraded alerts', async () => {
    mockSites([
      { id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: true,
        has_session: false, has_credentials: true, session_valid_at: null, last_search_at: '2026-05-16T10:00:00Z' },
    ]);
    const { result } = renderHook(() => useSiteStatus('google'), { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(result.current.data?.state).toBe('active'));
  });

  it('key_invalid alert beats active', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/sites')) {
        return new Response(JSON.stringify([
          { id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: true,
            has_session: false, has_credentials: true, session_valid_at: null, last_search_at: null },
        ]), { status: 200 });
      }
      if (u.includes('/api/alerts')) {
        return new Response(JSON.stringify({ items: [{
          id: 'a1', kind: 'serpapi_key_invalid', site_id: 'google', status: 'open',
        }] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const { result } = renderHook(() => useSiteStatus('google'), { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(result.current.data?.state).toBe('key_invalid'));
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/web test -- resources.site-status`
Expected: FAIL — `useSiteStatus` is not exported; `has_credentials` is not on the response interface.

- [ ] **Step 4: Implement**

In `packages/web/src/api/resources.ts`:

(a) Extend `SiteResponse` (line 275) with `has_credentials: boolean`.

(b) After the LinkedIn-connect hook block (around line 388), add `SiteState`, `SiteStatus`, and `useSiteStatus`:

```ts
/* ------------------------------------------------------------------ */
/* Site status (generic projection)                                    */
/* ------------------------------------------------------------------ */

export type SiteState =
  | 'not_configured'
  | 'paused'
  | 'active'
  | 'key_invalid'
  | 'quota_exhausted'
  | 'session_expired';

export interface SiteStatus {
  state: SiteState;
  enabled: boolean;
  has_credentials: boolean;
  last_search_at: string | null;
}

export function useSiteStatus(
  id: string,
  opts: { pollMs?: number } = {},
): { data: SiteStatus | null; isLoading: boolean } {
  const sites = useSites();
  const alerts = useAlerts();
  // pollMs is reserved for callers that want to drive their own refetch
  // cadence. Both underlying queries have their own intervals elsewhere; this
  // hook is a pure projection so the parameter is currently a no-op.
  void opts.pollMs;

  if (sites.isLoading || alerts.isLoading) return { data: null, isLoading: true };
  const row = sites.data.find((s) => s.id === id) ?? null;
  if (!row) return { data: null, isLoading: false };

  const has_credentials = row.has_credentials;
  const open = alerts.data.filter((a) => a.site_id === id && a.status === 'open');
  const hasInvalid = open.some((a) => a.kind === 'serpapi_key_invalid');
  const hasQuota = open.some((a) => a.kind === 'serpapi_quota_exhausted');
  const hasSessionExpired = open.some((a) => a.kind === 'linkedin_session_expired');

  const state: SiteState =
    hasInvalid ? 'key_invalid' :
    hasQuota ? 'quota_exhausted' :
    hasSessionExpired ? 'session_expired' :
    !has_credentials ? 'not_configured' :
    !row.enabled ? 'paused' :
    'active';

  return {
    data: {
      state,
      enabled: row.enabled,
      has_credentials,
      last_search_at: row.last_search_at,
    },
    isLoading: false,
  };
}
```

(c) Rewrite `useGoogleJobsStatus` as a wrapper. Update `GoogleJobsState` to drop `'connected'`:

```ts
export type GoogleJobsState =
  | 'not_configured' | 'paused' | 'active' | 'key_invalid' | 'quota_exhausted';

export interface GoogleJobsStatus {
  state: GoogleJobsState;
  enabled: boolean;
  has_credentials: boolean;
  last_search_at: string | null;
}

export function useGoogleJobsStatus(opts: { pollMs?: number } = {}): {
  data: GoogleJobsStatus | null;
  isLoading: boolean;
} {
  const inner = useSiteStatus('google', opts);
  if (!inner.data) return { data: null, isLoading: inner.isLoading };
  return {
    data: {
      // session_expired is unreachable for the google row; safe to cast.
      state: inner.data.state as GoogleJobsState,
      enabled: inner.data.enabled,
      has_credentials: inner.data.has_credentials,
      last_search_at: inner.data.last_search_at,
    },
    isLoading: inner.isLoading,
  };
}
```

(d) Keep `useLinkedInStatus` (LinkedIn-connect-service shape) **as-is** at lines 332–342 — it's used by the SitesTile LinkedIn row's "Connecting…" button. Add a sibling that returns the generic shape, used by SearchNowButton:

```ts
export function useLinkedInSiteStatus(opts: { pollMs?: number } = {}): {
  data: SiteStatus | null;
  isLoading: boolean;
} {
  return useSiteStatus('linkedin', opts);
}
```

(e) Update the existing Google Jobs hook test (`resources.google.test.tsx`) if it asserts on `'connected'` — replace with `'active'`. The test was added in the Google Jobs slice and may need a one-line patch; do it in this task to keep the rename atomic.

- [ ] **Step 5: Run the test + build, expect pass**

Run:
- `pnpm --filter @vina/web test -- resources.site-status resources.google`
- `pnpm --filter @vina/web build`

Expected: PASS for both. SitesTile may have a transient TypeScript error on the `'connected'` case label — that's expected; it gets fully rewritten in Phase 8. As a minimum, change `case 'connected':` → `case 'active':` in SitesTile so the build passes; the rest of the rewrite lands in Phase 8.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/api/resources.ts \
        packages/web/src/routes/settings/SitesTile.tsx \
        packages/web/tests/api/resources.site-status.test.tsx \
        packages/web/tests/api/resources.google.test.tsx
git commit -m "feat(web): add useSiteStatus and refactor per-site status hooks"
```

---

### Task 6B: `useCancelSearch` mutation

**Files:**
- Modify: `packages/web/src/api/resources.ts`
- Test: `packages/web/tests/api/resources.cancel-search.test.tsx` (create)

**Approach.** A simple mutation that POSTs to `/api/searches/cancel` with either `{ task_id }` or `{ site_id }`. Returns `{ cancelled: number }`. No optimistic updates needed — the WS `search:cancelled` event drives the store.

```ts
export interface CancelSearchInput {
  task_id?: string;
  site_id?: string;
}

export function useCancelSearch(): {
  mutate: (input: CancelSearchInput) => Promise<{ cancelled: number }>;
  isPending: boolean;
};
```

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/api/resources.cancel-search.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCancelSearch } from '../../src/api/resources.js';

afterEach(() => vi.restoreAllMocks());

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useCancelSearch', () => {
  it('POSTs { task_id } to /api/searches/cancel and resolves with the count', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ cancelled: 1 }), { status: 200 }),
    );
    const { result } = renderHook(() => useCancelSearch(), { wrapper: wrapper(new QueryClient()) });
    const res = await result.current.mutate({ task_id: 't1' });
    expect(res).toEqual({ cancelled: 1 });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/searches/cancel'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('POSTs { site_id } when task_id is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ cancelled: 2 }), { status: 200 }),
    );
    const { result } = renderHook(() => useCancelSearch(), { wrapper: wrapper(new QueryClient()) });
    const res = await result.current.mutate({ site_id: 'google' });
    expect(res).toEqual({ cancelled: 2 });
    // Verify the body includes site_id.
    const calls = fetchSpy.mock.calls;
    const init = calls[0]![1] as RequestInit;
    expect(typeof init.body === 'string' && init.body.includes('"site_id":"google"')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @vina/web test -- resources.cancel-search`
Expected: FAIL — `useCancelSearch` undefined.

- [ ] **Step 3: Implement**

Append to `packages/web/src/api/resources.ts`, after `useRunSearchNow`:

```ts
export interface CancelSearchInput {
  task_id?: string;
  site_id?: string;
}

export function useCancelSearch(): {
  mutate: (input: CancelSearchInput) => Promise<{ cancelled: number }>;
  isPending: boolean;
} {
  const mut = useMutation<{ cancelled: number }, Error, CancelSearchInput>({
    mutationFn: (input) =>
      api<{ cancelled: number }>('/api/searches/cancel', { method: 'POST', body: input }),
  });
  return { mutate: (input) => mut.mutateAsync(input), isPending: mut.isPending };
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @vina/web test -- resources.cancel-search`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/resources.ts \
        packages/web/tests/api/resources.cancel-search.test.tsx
git commit -m "feat(web): add useCancelSearch mutation"
```

---

## Phase 7 — Web: Validate-hook empty-key fence + per-source toggle

### Task 7A: B3 — `useValidateSerpapiKey` rejects empty keys synchronously

**Files:**
- Modify: `packages/web/src/api/resources.ts`
- Test: `packages/web/tests/api/resources.validate-empty.test.tsx` (create)

**Approach.** Spec §3.3 verbatim:

```ts
mutationFn: (key) => {
  if (typeof key !== 'string' || key.trim().length === 0) {
    return Promise.resolve({
      ok: false as const,
      reason: 'empty_key' as const,
      detail: 'Key is required',
    });
  }
  return api<SerpapiValidateResult>('/api/sites/google/test', { method: 'POST', body: { key } });
}
```

Add `'empty_key'` to the `SerpapiValidateResult.reason` union (currently `'auth_failed' | 'rate_limited' | 'network' | 'other' | 'no_key_configured'`).

The Settings tile already renders `res.detail ?? res.reason ?? 'Validation failed'` (`SitesTile.tsx` line 41), so the user sees "Key is required" without any tile changes.

- [ ] **Step 1: Read the current hook**

Read `packages/web/src/api/resources.ts` lines 489–513.

- [ ] **Step 2: Write the failing test**

Create `packages/web/tests/api/resources.validate-empty.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useValidateSerpapiKey } from '../../src/api/resources.js';

afterEach(() => vi.restoreAllMocks());

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useValidateSerpapiKey — empty-key fence', () => {
  it('resolves locally with empty_key for an empty string; no fetch happens', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    const { result } = renderHook(() => useValidateSerpapiKey(), { wrapper: wrapper(new QueryClient()) });
    const res = await result.current.mutate('');
    expect(res).toMatchObject({ ok: false, reason: 'empty_key', detail: 'Key is required' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves locally for whitespace-only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const { result } = renderHook(() => useValidateSerpapiKey(), { wrapper: wrapper(new QueryClient()) });
    const res = await result.current.mutate('   ');
    expect(res).toMatchObject({ ok: false, reason: 'empty_key' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still POSTs for a non-empty key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, latency_ms: 5 }), { status: 200 }),
    );
    const { result } = renderHook(() => useValidateSerpapiKey(), { wrapper: wrapper(new QueryClient()) });
    await result.current.mutate('live-key');
    expect(fetchSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/web test -- resources.validate-empty`
Expected: FAIL — current hook fires `fetch` for `''`.

- [ ] **Step 4: Update the hook**

In `packages/web/src/api/resources.ts`:

```ts
export interface SerpapiValidateResult {
  ok: boolean;
  reason?:
    | 'auth_failed'
    | 'rate_limited'
    | 'network'
    | 'other'
    | 'no_key_configured'
    | 'empty_key';
  detail?: string;
  latency_ms?: number;
}

export function useValidateSerpapiKey(): {
  mutate: (key: string) => Promise<SerpapiValidateResult>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<SerpapiValidateResult, Error, string>({
    mutationFn: async (key) => {
      if (typeof key !== 'string' || key.trim().length === 0) {
        return { ok: false as const, reason: 'empty_key' as const, detail: 'Key is required' };
      }
      return api<SerpapiValidateResult>('/api/sites/google/test', {
        method: 'POST',
        body: { key },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sites'] });
    },
  });
  return { mutate: (key) => mut.mutateAsync(key), isPending: mut.isPending };
}
```

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm --filter @vina/web test -- resources.validate-empty`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/api/resources.ts \
        packages/web/tests/api/resources.validate-empty.test.tsx
git commit -m "fix(web): reject empty SerpAPI key in useValidateSerpapiKey without firing a request"
```

---

### Task 7B: Per-row pause Switch in the Settings sites tile

**Files:**
- Create: `packages/web/src/components/ui/switch.tsx` (generated via shadcn, then re-themed)
- Modify: `packages/web/src/routes/settings/SitesTile.tsx`
- Modify: `packages/web/package.json` (new dep: `@radix-ui/react-switch`)
- Test: `packages/web/tests/routes/settings/SitesTile.toggle.test.tsx` (create)

**Approach.** Generate the shadcn `switch` component, re-theme its colour classes against Vina tokens, then add a `<Switch>` to the right of each row's state label. Disabled when `has_credentials=false` with a tooltip. ON when `enabled=true`. Calls `useToggleSite.mutate(id, !enabled)`.

The same task adds the Switch for both the LinkedIn row and the Google Jobs row (the LinkedIn row's render lives inline in `SitesTile` — extract it into a `LinkedInRow` component to keep the shape parallel to `GoogleJobsRow`).

- [ ] **Step 1: Generate the shadcn Switch**

Run:
```bash
pnpm --filter @vina/web dlx shadcn@latest add switch
```

This drops `packages/web/src/components/ui/switch.tsx` and adds `@radix-ui/react-switch` to `package.json`. Verify the file's import paths use the project's alias (`@/lib/utils` is shadcn's default; the project uses `../../lib/utils.js` or similar — adapt). The expected file body is small:

```tsx
import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';
import { cn } from '../../lib/utils.js';

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:bg-accent data-[state=unchecked]:bg-surface-sunken',
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-surface-raised shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitives.Root>
));
Switch.displayName = 'Switch';
```

Strip any class names referencing shadcn's default tokens (`bg-primary`, `text-primary-foreground`, etc.). Replace with Vina tokens: `bg-accent`, `bg-surface-sunken`, `bg-surface-raised`, `ring-accent`. If `cn` lives at a different path, fix the import. Verify with a quick `pnpm --filter @vina/web build` after writing.

- [ ] **Step 2: Write the failing test**

Create `packages/web/tests/routes/settings/SitesTile.toggle.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SitesTile } from '../../../src/routes/settings/SitesTile.js';

afterEach(() => vi.restoreAllMocks());

function setup(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/sites') && (!init || init.method === undefined || init.method === 'GET')) {
      return new Response(JSON.stringify([
        { id: 'linkedin', display_name: 'LinkedIn', kind: 'browser', enabled: true,
          has_session: true, has_credentials: true, session_valid_at: '2026-05-15T10:00:00Z', last_search_at: null },
        { id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: false,
          has_session: false, has_credentials: true, session_valid_at: null, last_search_at: null },
      ]), { status: 200 });
    }
    if (u.includes('/api/alerts')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (u.includes('/api/sites/linkedin/status')) {
      return new Response(JSON.stringify({ connected: true, attempting: false, last_success_at: '…', error: null }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

describe('SitesTile — per-source toggle', () => {
  it('renders the LinkedIn switch ON when enabled=true && has_credentials=true', async () => {
    setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SitesTile />
      </QueryClientProvider>,
    );
    const linkedinSwitch = await screen.findByRole('switch', { name: /linkedin/i });
    expect(linkedinSwitch.getAttribute('data-state')).toBe('checked');
  });

  it('renders the Google Jobs switch OFF when enabled=false but has_credentials=true (paused)', async () => {
    setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SitesTile />
      </QueryClientProvider>,
    );
    const googleSwitch = await screen.findByRole('switch', { name: /google jobs/i });
    expect(googleSwitch.getAttribute('data-state')).toBe('unchecked');
  });

  it('PATCHes /api/sites/:id when the switch is clicked', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      // Reuse the same setup but track PATCH calls.
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.endsWith('/api/sites/linkedin') && method === 'PATCH') {
        return new Response(JSON.stringify({ id: 'linkedin', enabled: false }), { status: 200 });
      }
      if (u.endsWith('/api/sites')) {
        return new Response(JSON.stringify([
          { id: 'linkedin', display_name: 'LinkedIn', kind: 'browser', enabled: true,
            has_session: true, has_credentials: true, session_valid_at: '…', last_search_at: null },
        ]), { status: 200 });
      }
      if (u.includes('/api/alerts')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (u.includes('/api/sites/linkedin/status')) {
        return new Response(JSON.stringify({ connected: true, attempting: false, last_success_at: null, error: null }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <SitesTile />
      </QueryClientProvider>,
    );
    const sw = await screen.findByRole('switch', { name: /linkedin/i });
    fireEvent.click(sw);
    await waitFor(() => {
      const patches = fetchSpy.mock.calls.filter(([url, init]) =>
        String(url).endsWith('/api/sites/linkedin') && (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patches.length).toBe(1);
      const body = JSON.parse((patches[0]![1] as RequestInit).body as string);
      expect(body.enabled).toBe(false);
    });
  });

  it('disables the switch when has_credentials=false', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/sites')) {
        return new Response(JSON.stringify([
          { id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: false,
            has_session: false, has_credentials: false, session_valid_at: null, last_search_at: null },
        ]), { status: 200 });
      }
      if (u.includes('/api/alerts')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (u.includes('/api/sites/linkedin/status')) {
        return new Response(JSON.stringify({ connected: false, attempting: false, last_success_at: null, error: null }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SitesTile />
      </QueryClientProvider>,
    );
    const sw = await screen.findByRole('switch', { name: /google jobs/i });
    expect(sw).toBeDisabled();
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/web test -- SitesTile.toggle`
Expected: FAIL — no `<Switch role="switch" aria-label="LinkedIn">` element in the tree.

- [ ] **Step 4: Update SitesTile**

In `packages/web/src/routes/settings/SitesTile.tsx`:

(a) Import the new generic hook and toggle mutation:

```ts
import { Switch } from '../../components/ui/switch.js';
import {
  useSiteStatus,
  useToggleSite,
  useLinkedInStatus,
  useStartLinkedInConnect,
  useDisconnectLinkedIn,
  useValidateSerpapiKey,
  useDisconnectGoogleJobs,
} from '../../api/resources.js';
```

(b) Add a `<SiteToggle>` helper:

```tsx
function SiteToggle({ id, label }: { id: string; label: string }): JSX.Element {
  const status = useSiteStatus(id);
  const toggle = useToggleSite();
  const enabled = status.data?.enabled ?? false;
  const canToggle = status.data?.has_credentials ?? false;
  return (
    <Switch
      aria-label={label}
      checked={enabled}
      disabled={!canToggle || toggle.isPending}
      onCheckedChange={(next) => void toggle.mutate(id, next)}
      title={canToggle ? undefined : 'Connect first.'}
    />
  );
}
```

(c) Extract the inline LinkedIn block into a `LinkedInRow` component:

```tsx
function LinkedInRow(): JSX.Element {
  const status = useSiteStatus('linkedin');
  const linkedinConnect = useLinkedInStatus({ pollMs: 3_000 });
  const start = useStartLinkedInConnect();
  const disconnect = useDisconnectLinkedIn();

  const state = status.data?.state ?? 'not_configured';
  const label = (() => {
    switch (state) {
      case 'active':
        return <span className="text-success">● Active</span>;
      case 'paused':
        return <span className="text-ink-muted">⊘ Paused (credentials saved)</span>;
      case 'session_expired':
        return <span className="text-warning">⚠ Session expired</span>;
      default:
        return <span className="text-ink-muted">○ Not connected</span>;
    }
  })();

  return (
    <li className="flex items-center justify-between py-3">
      <div>
        <p className="font-medium text-ink-primary">LinkedIn</p>
        <p className="text-xs text-ink-secondary">{label}</p>
      </div>
      <div className="flex items-center gap-3">
        <SiteToggle id="linkedin" label="LinkedIn" />
        {state === 'active' || state === 'paused' || state === 'session_expired' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
          >
            Disconnect
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => start.mutate()}
            disabled={start.isPending || linkedinConnect.data?.attempting}
          >
            {linkedinConnect.data?.attempting ? 'Connecting…' : 'Connect'}
          </Button>
        )}
      </div>
    </li>
  );
}
```

(d) Update `GoogleJobsRow` to use the generic state. The B2 auto-close lands in Phase 8 — here, only the state mapping changes:

```tsx
const state = status.data?.state ?? 'not_configured';

const label = (() => {
  switch (state) {
    case 'active':
      return (
        <span className="text-success">
          ● Active
          {status.data?.last_search_at && (
            <span className="ml-2 text-ink-muted">
              · last search {new Date(status.data.last_search_at).toLocaleString()}
            </span>
          )}
        </span>
      );
    case 'paused':
      return <span className="text-ink-muted">⊘ Paused (credentials saved)</span>;
    case 'key_invalid':
      return <span className="text-warning">⚠ Key invalid</span>;
    case 'quota_exhausted':
      return <span className="text-warning">⚠ Quota exhausted</span>;
    default:
      return <span className="text-ink-muted">○ Not configured</span>;
  }
})();
```

Add the toggle next to the action buttons:

```tsx
<div className="flex items-center gap-3">
  <SiteToggle id="google" label="Google Jobs" />
  {/* existing edit/disconnect/update buttons */}
</div>
```

The action buttons stay conditional on `state`; the toggle is independent.

(e) Replace the SitesTile inline LinkedIn block with `<LinkedInRow />`.

- [ ] **Step 5: Run the tests + build, expect pass**

Run: `pnpm --filter @vina/web test -- SitesTile && pnpm --filter @vina/web build`
Expected: PASS. The new dependency (`@radix-ui/react-switch`) was installed by shadcn in Step 1 — verify it landed in `package.json` and pnpm-lock.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/ui/switch.tsx \
        packages/web/src/routes/settings/SitesTile.tsx \
        packages/web/package.json packages/web/pnpm-lock.yaml \
        packages/web/tests/routes/settings/SitesTile.toggle.test.tsx
git commit -m "feat(web): add per-source pause toggle to Settings sites tile"
```

If `pnpm-lock.yaml` lives at the repo root (most likely), adjust the path.

---

## Phase 8 — Web: SitesTile state derivation + auto-close form (B1 + B2)

### Task 8: B2 — Auto-close the inline edit-key form on state transition to `not_configured`

**Files:**
- Modify: `packages/web/src/routes/settings/SitesTile.tsx`
- Test: `packages/web/tests/routes/settings/SitesTile.autoclose.test.tsx` (create)

**Approach.** B1 (state derivation from `has_credentials`) already lands as a side effect of Phase 6 — the new `useSiteStatus` projection drives the rendered label, and Phase 7 Task B rewrote the SitesTile state switch. This task closes the gap: when the user clicks Disconnect while the edit-key form is open, the form must auto-close.

```tsx
useEffect(() => {
  if (state === 'not_configured') {
    setEditing(false);
    setKey('');
    setError(null);
  }
}, [state]);
```

The effect re-runs whenever the projected state flips, so the next time TanStack Query refetches `/api/sites` (after Disconnect's `invalidateQueries`), the form closes automatically.

Also verify B1 visually: when `has_credentials=false`, the row shows the "Add SerpAPI key" CTA and the toggle is disabled. This is implicitly tested by `SitesTile.toggle.test.tsx` ("disables the switch when has_credentials=false"), but add an explicit B1 test alongside.

- [ ] **Step 1: Read the current GoogleJobsRow state and the disconnect flow**

Read `SitesTile.tsx` GoogleJobsRow lines 26–148. Note that `disconnect.mutate()` (from `useDisconnectGoogleJobs`) calls `DELETE /api/sites/google`, which on the server side clears the SerpAPI key and disables the row. The hook's `onSuccess` invalidates `['sites']`. After the refetch, `has_credentials` becomes `false` and the projected state becomes `not_configured`.

- [ ] **Step 2: Write the failing test**

Create `packages/web/tests/routes/settings/SitesTile.autoclose.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SitesTile } from '../../../src/routes/settings/SitesTile.js';

afterEach(() => vi.restoreAllMocks());

describe('SitesTile — B2 auto-close edit form', () => {
  it('closes the inline edit-key form when state transitions to not_configured', async () => {
    let credentialsPresent = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.endsWith('/api/sites') && method === 'GET') {
        return new Response(JSON.stringify([
          {
            id: 'google',
            display_name: 'Google Jobs',
            kind: 'api',
            enabled: credentialsPresent,
            has_session: false,
            has_credentials: credentialsPresent,
            session_valid_at: null,
            last_search_at: null,
          },
        ]), { status: 200 });
      }
      if (u.endsWith('/api/sites/google') && method === 'DELETE') {
        credentialsPresent = false;
        return new Response(null, { status: 204 });
      }
      if (u.includes('/api/alerts')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (u.includes('/api/sites/linkedin/status')) {
        return new Response(JSON.stringify({ connected: false, attempting: false, last_success_at: null, error: null }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <SitesTile />
      </QueryClientProvider>,
    );

    // Open the edit form (state starts as 'active').
    const editButton = await screen.findByRole('button', { name: /edit key/i });
    fireEvent.click(editButton);
    expect(await screen.findByLabelText(/serpapi key/i)).toBeInTheDocument();

    // Disconnect → server flips has_credentials → next refetch → state becomes not_configured.
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));

    // The input element should be removed from the DOM once state flips.
    await waitFor(() => expect(screen.queryByLabelText(/serpapi key/i)).not.toBeInTheDocument(), {
      timeout: 3_000,
    });
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/web test -- SitesTile.autoclose`
Expected: FAIL — the form stays open after Disconnect.

- [ ] **Step 4: Add the effect**

In `packages/web/src/routes/settings/SitesTile.tsx`, inside `GoogleJobsRow` (after the `useState` declarations, before the render):

```ts
import { useEffect, useState } from 'react';

// …

useEffect(() => {
  if (state === 'not_configured') {
    setEditing(false);
    setKey('');
    setError(null);
  }
}, [state]);
```

`state` is already in scope (the existing `const state = status.data?.state ?? 'not_configured';` line). Mirror the same effect inside `LinkedInRow` so a LinkedIn disconnect also closes any future edit form on that row (defensive — there's no edit form there today, but if Phase B grows one this stays correct).

- [ ] **Step 5: Run the test + build, expect pass**

Run: `pnpm --filter @vina/web test -- SitesTile && pnpm --filter @vina/web build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/routes/settings/SitesTile.tsx \
        packages/web/tests/routes/settings/SitesTile.autoclose.test.tsx
git commit -m "fix(web): auto-close SerpAPI edit form when site transitions to not_configured"
```

---

## Phase 9 — Web: Multi-source SearchNowButton + Stop button

### Task 9A: B4 — Rewrite `SearchNowButton` for 0/1/2 active sources with dropdown

**Files:**
- Create: `packages/web/src/components/ui/dropdown-menu.tsx` (generated via shadcn, then re-themed)
- Modify: `packages/web/src/components/search/SearchNowButton.tsx`
- Modify: `packages/web/package.json` (new dep: `@radix-ui/react-dropdown-menu`)
- Test: `packages/web/tests/components/search/SearchNowButton.test.tsx` (create or extend)

**Approach.** Compute `activeSites` from `useSiteStatus('linkedin')` and `useSiteStatus('google')`. Map to:

- `activeSites.length === 0` → `disabled=true`, tooltip "No source configured & active".
- `activeSites.length === 1` → single button. `onClick` fans out one `run-now` for that site.
- `activeSites.length === 2` → button + chevron. Clicking opens a `<DropdownMenu>` with three items:
  - "Search both" (default, focused) → fires `run-now` for both site IDs in parallel.
  - "Search LinkedIn only" → one `run-now` for `linkedin`.
  - "Search Google Jobs only" → one `run-now` for `google`.

Inline the parallel fan-out via `Promise.all([...sites.map(useRunSearchNow().mutate)])`. The hook is stateless from the consumer's perspective; concurrent invocations are safe.

The morphing label (`Sussing… (3 found)`) stays — once the first task fires `search:started`, the WS layer flips `phase` to `discovering` and the existing gerund logic kicks in. For two-source fan-out the WS layer will receive two `search:started` events; the store's `beginDiscovering` is idempotent (it resets counters) so the second event re-initialises rather than racing. Verify by reading the store after writing the test; if a race is detected, extend `beginDiscovering` to no-op when `phase === 'discovering'`. (Phase 9 Task B's `currentTaskId` extension also benefits from this no-op — explicitly handled there.)

- [ ] **Step 1: Generate the shadcn DropdownMenu**

Run:
```bash
pnpm --filter @vina/web dlx shadcn@latest add dropdown-menu
```

This drops `packages/web/src/components/ui/dropdown-menu.tsx` and adds `@radix-ui/react-dropdown-menu` to `package.json`. Re-theme as in Phase 7 Task B — replace `bg-popover`, `text-popover-foreground`, etc. with Vina tokens (`bg-surface-raised`, `text-ink-primary`, `border-border-subtle`). Keep the file small; trim unused exports (`DropdownMenuRadioGroup`, `DropdownMenuCheckboxItem`, etc.) if the slice doesn't use them — we only need `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`. Build after writing.

- [ ] **Step 2: Write the failing test**

Create `packages/web/tests/components/search/SearchNowButton.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SearchNowButton } from '../../../src/components/search/SearchNowButton.js';

afterEach(() => vi.restoreAllMocks());

function setup(siteRows: Array<Record<string, unknown>>): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.endsWith('/api/sites') && method === 'GET') {
      return new Response(JSON.stringify(siteRows), { status: 200 });
    }
    if (u.includes('/api/alerts')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (u.includes('/api/sites/linkedin/status')) {
      return new Response(JSON.stringify({ connected: true, attempting: false, last_success_at: null, error: null }), { status: 200 });
    }
    if (u.endsWith('/api/searches/run-now') && method === 'POST') {
      const body = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ task_id: `t-${body.site_id}`, deduped: false }), { status: 202 });
    }
    return new Response('{}', { status: 200 });
  });
}

const row = (id: string, enabled: boolean, has_credentials: boolean): Record<string, unknown> => ({
  id, display_name: id, kind: id === 'linkedin' ? 'browser' : 'api',
  enabled, has_session: id === 'linkedin' ? has_credentials : false,
  has_credentials, session_valid_at: null, last_search_at: null,
});

describe('SearchNowButton — multi-source', () => {
  it('disabled with tooltip when zero sources are active', async () => {
    setup([row('linkedin', false, false), row('google', false, false)]);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchNowButton />
      </QueryClientProvider>,
    );
    const btn = await screen.findByRole('button', { name: /search now/i });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toMatch(/no source/i);
  });

  it('single-source: click fires one run-now for that site', async () => {
    const fetchSpy = setup([row('linkedin', true, true), row('google', false, false)]);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchNowButton />
      </QueryClientProvider>,
    );
    const btn = await screen.findByRole('button', { name: /search now/i });
    fireEvent.click(btn);
    await waitFor(() => {
      const posts = fetchSpy.mock.calls.filter(([url, init]) =>
        String(url).endsWith('/api/searches/run-now') && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts.length).toBe(1);
      expect(JSON.parse((posts[0]![1] as RequestInit).body as string).site_id).toBe('linkedin');
    });
  });

  it('two-source: clicking opens a dropdown with three options', async () => {
    setup([row('linkedin', true, true), row('google', true, true)]);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchNowButton />
      </QueryClientProvider>,
    );
    // The trigger renders a chevron next to the label.
    const trigger = await screen.findByRole('button', { name: /search now/i });
    fireEvent.click(trigger);
    expect(await screen.findByRole('menuitem', { name: /search both/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /linkedin only/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /google jobs only/i })).toBeInTheDocument();
  });

  it('two-source: "Search both" fires run-now twice with the two site_ids', async () => {
    const fetchSpy = setup([row('linkedin', true, true), row('google', true, true)]);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchNowButton />
      </QueryClientProvider>,
    );
    const trigger = await screen.findByRole('button', { name: /search now/i });
    fireEvent.click(trigger);
    const both = await screen.findByRole('menuitem', { name: /search both/i });
    fireEvent.click(both);
    await waitFor(() => {
      const posts = fetchSpy.mock.calls.filter(([url, init]) =>
        String(url).endsWith('/api/searches/run-now') && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts.length).toBe(2);
      const bodies = posts.map(([, init]) => JSON.parse((init as RequestInit).body as string).site_id).sort();
      expect(bodies).toEqual(['google', 'linkedin']);
    });
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/web test -- SearchNowButton`
Expected: FAIL — the existing button has no dropdown, hard-codes linkedin, and is disabled when LinkedIn isn't connected (so the "zero sources" case might pass coincidentally; the others won't).

- [ ] **Step 4: Rewrite the button**

Full rewrite of `packages/web/src/components/search/SearchNowButton.tsx`:

```tsx
import { useState } from 'react';
import {
  useCancelSearch as _unused,
  useRunSearchNow,
  useSiteStatus,
} from '../../api/resources.js';
import { useSearchProgressStore } from '../../store/search-progress-store.js';
import { useUiStore } from '../../store/ui-store.js';
import { Button } from '../ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';
import { useSearchGerund } from './use-search-gerund.js';

const SITE_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn',
  google: 'Google Jobs',
};

export function SearchNowButton(): JSX.Element {
  const linkedin = useSiteStatus('linkedin', { pollMs: 5_000 });
  const google = useSiteStatus('google', { pollMs: 5_000 });
  const runNow = useRunSearchNow();
  const pushToast = useUiStore((s) => s.pushToast);
  const { phase, listingsFound, scoredCount, totalToScore } = useSearchProgressStore();
  const gerund = useSearchGerund(phase);
  const [menuOpen, setMenuOpen] = useState(false);

  const activeSites: string[] = [
    linkedin.data?.state === 'active' ? 'linkedin' : null,
    google.data?.state === 'active' ? 'google' : null,
  ].filter((x): x is string => x !== null);

  const inFlight =
    runNow.isPending || phase === 'discovering' || phase === 'scoring';
  const disabled = activeSites.length === 0 || inFlight;

  const label = (() => {
    if (runNow.isPending) return 'Starting search…';
    switch (phase) {
      case 'discovering':
        return listingsFound > 0
          ? `${gerund ?? 'Discovering'}… (${listingsFound} found)`
          : `${gerund ?? 'Discovering'}…`;
      case 'scoring':
        return totalToScore > 0
          ? `${gerund ?? 'Scoring'} ${scoredCount}/${totalToScore}…`
          : `${gerund ?? 'Scoring'}…`;
      case 'done':
        return totalToScore > 0 ? `Done · ${scoredCount} scored` : 'Done · no new jobs';
      case 'error':
        return 'Search failed — retry';
      default:
        return 'Search now';
    }
  })();

  const fireRunNow = async (sites: string[]): Promise<void> => {
    try {
      await Promise.all(sites.map((id) => runNow.mutate(id)));
    } catch (err) {
      pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Search failed to start.',
      });
    }
  };

  // Zero-source disabled state.
  if (activeSites.length === 0) {
    return (
      <Button disabled title="No source configured & active">
        {label}
      </Button>
    );
  }

  // Single-source single button.
  if (activeSites.length === 1) {
    const only = activeSites[0]!;
    return (
      <Button disabled={disabled} onClick={() => void fireRunNow([only])}>
        {label}
      </Button>
    );
  }

  // Two-source dropdown.
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button disabled={disabled}>
          {label} {/* trailing chevron lives inside the Button via aria-haspopup */}
          <span aria-hidden className="ml-2">▾</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void fireRunNow(activeSites)}>
          Search both
        </DropdownMenuItem>
        {activeSites.map((id) => (
          <DropdownMenuItem key={id} onSelect={() => void fireRunNow([id])}>
            Search {SITE_LABELS[id] ?? id} only
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

The `_unused` rename of `useCancelSearch` is a hack — `useCancelSearch` is consumed by Phase 9 Task B inside `SearchActivityPanel`, not here. Drop the import line entirely from this component to keep it clean.

- [ ] **Step 5: Run the test + build, expect pass**

Run: `pnpm --filter @vina/web test -- SearchNowButton && pnpm --filter @vina/web build`
Expected: PASS. The existing label morphing assertions in any prior SearchNowButton test continue to work because the label logic is unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/ui/dropdown-menu.tsx \
        packages/web/src/components/search/SearchNowButton.tsx \
        packages/web/package.json packages/web/pnpm-lock.yaml \
        packages/web/tests/components/search/SearchNowButton.test.tsx
git commit -m "feat(web): multi-source SearchNowButton with two-source dropdown"
```

---

### Task 9B: Stop button in `SearchActivityPanel` + `currentTaskId` on the search-progress store

**Files:**
- Modify: `packages/web/src/store/search-progress-store.ts`
- Modify: `packages/web/src/api/ws.ts` (capture `task_id` from `search:started` into the store)
- Modify: `packages/web/src/components/search/SearchActivityPanel.tsx`
- Test: `packages/web/tests/components/search/SearchActivityPanel.stop.test.tsx` (create)
- Test: `packages/web/tests/store/search-progress-store.test.ts` (extend or create)

**Approach.**

1. Extend `useSearchProgressStore`:
   - state: add `currentTaskId: string | null` initialised to `null`.
   - actions: `beginDiscovering(opts?: { taskId?: string })` — accept an optional task id and store it.
   - `reset` clears `currentTaskId` to `null`.
   - terminal-phase auto-reset already clears the whole `INITIAL` state, including the new field.

2. In `packages/web/src/api/ws.ts`, the `'search:started'` case reads `payload.task_id` and passes it through:

```ts
case 'search:started': {
  const taskId = (payload as { task_id?: string } | undefined)?.task_id;
  store.beginDiscovering({ taskId });
  break;
}
```

3. In `SearchActivityPanel`:
   - Read `currentTaskId` and `useCancelSearch` from `resources`.
   - When `phase === 'discovering' && currentTaskId`, render a Stop button (ghost variant) on the right of the elapsed timer.
   - On click, call `cancel.mutate({ task_id: currentTaskId })`. The button hides immediately (optimistic via `cancel.isPending`), the WS `search:cancelled` event eventually arrives and flips `phase` to `done` (or to a new "cancelled" terminal phase — see step 4 below).
   - The Stop button is hidden when `phase !== 'discovering'`. During `scoring` there's nothing to cancel.

4. Handle the `search:cancelled` event in `ws.ts`. The simplest approach: treat it as a `done` transition with custom counts. Extend the dispatcher:

```ts
case 'search:cancelled': {
  // Treat cancellation as a soft "done" so the existing auto-reset
  // (4s) returns the UI to idle. Counts already reflect what made it
  // through before the abort.
  store.markDone();
  break;
}
```

Optionally, add a `markCancelled()` action that displays "Done · cancelled · N scored" — the headline copy lives in `SearchActivityPanel`. For this slice, `markDone()` is enough; the spec's §5.3 ("Done · cancelled · 3 scored") can be a polish follow-up. Add a single sentence in the panel: if the most recent transition came from `search:cancelled` (track it via a `wasCancelled` boolean on the store), prefix "Cancelled · " to the headline.

To keep this task scoped: add `markCancelled()` that sets `phase: 'done'` and `wasCancelled: true`. Reset clears `wasCancelled`. The headline reads `wasCancelled ? 'Cancelled · …' : 'Done · …'`.

- [ ] **Step 1: Read the store and the panel**

Re-read `packages/web/src/store/search-progress-store.ts` and `packages/web/src/components/search/SearchActivityPanel.tsx` (already cached above). Confirm the auto-reset subscriber clears the whole state via `INITIAL` — adding a new field is safe because the spread copies `INITIAL` over.

Read `packages/web/src/api/ws.ts` to find where `search:started` is dispatched.

- [ ] **Step 2: Write the failing tests**

Create `packages/web/tests/store/search-progress-store.test.ts` (or extend if it already exists):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useSearchProgressStore } from '../../src/store/search-progress-store.js';

beforeEach(() => useSearchProgressStore.getState().reset());

describe('search-progress-store — currentTaskId', () => {
  it('beginDiscovering({ taskId }) sets currentTaskId', () => {
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't1' });
    expect(useSearchProgressStore.getState().currentTaskId).toBe('t1');
  });

  it('beginDiscovering() without taskId leaves currentTaskId null', () => {
    useSearchProgressStore.getState().beginDiscovering();
    expect(useSearchProgressStore.getState().currentTaskId).toBe(null);
  });

  it('reset clears currentTaskId', () => {
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't1' });
    useSearchProgressStore.getState().reset();
    expect(useSearchProgressStore.getState().currentTaskId).toBe(null);
  });

  it('markCancelled sets phase=done and wasCancelled=true', () => {
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't1' });
    useSearchProgressStore.getState().markCancelled();
    expect(useSearchProgressStore.getState().phase).toBe('done');
    expect(useSearchProgressStore.getState().wasCancelled).toBe(true);
  });
});
```

Create `packages/web/tests/components/search/SearchActivityPanel.stop.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SearchActivityPanel } from '../../../src/components/search/SearchActivityPanel.js';
import { useSearchProgressStore } from '../../../src/store/search-progress-store.js';

afterEach(() => {
  useSearchProgressStore.getState().reset();
  vi.restoreAllMocks();
});

describe('SearchActivityPanel — Stop button', () => {
  it('renders Stop only during the discovering phase', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't1' });
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchActivityPanel />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('button', { name: /stop/i })).toBeInTheDocument();

    useSearchProgressStore.getState().beginScoring(5);
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <SearchActivityPanel />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
  });

  it('POSTs /api/searches/cancel { task_id } on click', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/api/searches/cancel') && init?.method === 'POST') {
        return new Response(JSON.stringify({ cancelled: 1 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't42' });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchActivityPanel />
      </QueryClientProvider>,
    );
    const stop = await screen.findByRole('button', { name: /stop/i });
    fireEvent.click(stop);
    await waitFor(() => {
      const cancels = fetchSpy.mock.calls.filter(
        ([url, init]) => String(url).endsWith('/api/searches/cancel') && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(cancels.length).toBe(1);
      const body = JSON.parse((cancels[0]![1] as RequestInit).body as string);
      expect(body.task_id).toBe('t42');
    });
  });

  it('prefixes "Cancelled · " in the headline after a search:cancelled transition', () => {
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't1' });
    useSearchProgressStore.getState().markCancelled();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchActivityPanel />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/cancelled/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the tests, expect failure**

Run: `pnpm --filter @vina/web test -- search-progress-store SearchActivityPanel.stop`
Expected: FAIL — `currentTaskId` doesn't exist; the panel has no Stop button.

- [ ] **Step 4: Implement**

**(a) Extend the store.** In `packages/web/src/store/search-progress-store.ts`:

```ts
interface SearchProgressState {
  phase: SearchPhase;
  listingsFound: number;
  scoredCount: number;
  totalToScore: number;
  errorKind: string | null;
  phaseChangedAt: number;
  currentTaskId: string | null;
  wasCancelled: boolean;
}

interface SearchProgressActions {
  beginDiscovering: (opts?: { taskId?: string }) => void;
  countDiscoveredListings: (n: number) => void;
  beginScoring: (totalToScore: number) => void;
  countScored: (n: number) => void;
  markDone: () => void;
  markCancelled: () => void;
  markError: (errorKind: string) => void;
  reset: () => void;
}

const INITIAL: SearchProgressState = {
  phase: 'idle',
  listingsFound: 0,
  scoredCount: 0,
  totalToScore: 0,
  errorKind: null,
  phaseChangedAt: 0,
  currentTaskId: null,
  wasCancelled: false,
};

// In create():
beginDiscovering: (opts) =>
  set({
    phase: 'discovering',
    listingsFound: 0,
    scoredCount: 0,
    totalToScore: 0,
    errorKind: null,
    currentTaskId: opts?.taskId ?? null,
    wasCancelled: false,
    phaseChangedAt: Date.now(),
  }),
markCancelled: () =>
  set((s) => ({
    phase: 'done',
    wasCancelled: true,
    phaseChangedAt: s.phase === 'done' && s.wasCancelled ? s.phaseChangedAt : Date.now(),
  })),
```

**(b) Update the WS dispatcher** in `packages/web/src/api/ws.ts`:

```ts
case 'search:started': {
  const taskId = (payload as { task_id?: string } | undefined)?.task_id;
  store.beginDiscovering({ taskId });
  break;
}
case 'search:cancelled': {
  store.markCancelled();
  break;
}
```

Also add `'search:cancelled': [['jobs']]` to the `INVALIDATIONS` map so the UI refetches the partially-discovered listings.

**(c) Add the Stop button to the panel.** In `SearchActivityPanel.tsx`:

```tsx
import { useCancelSearch } from '../../api/resources.js';
import { Button } from '../ui/button.js';

export function SearchActivityPanel(): JSX.Element | null {
  const { phase, listingsFound, scoredCount, totalToScore, errorKind, phaseChangedAt,
          currentTaskId, wasCancelled } = useSearchProgressStore();
  const cancel = useCancelSearch();
  // … existing nowMs / elapsed logic …

  const headline = (() => {
    switch (phase) {
      case 'discovering':
        return listingsFound > 0
          ? `${gerund ?? 'Discovering'} · ${listingsFound} found`
          : `${gerund ?? 'Discovering'}…`;
      case 'scoring':
        return totalToScore > 0
          ? `${gerund ?? 'Scoring'} · ${scoredCount}/${totalToScore}`
          : `${gerund ?? 'Scoring'}…`;
      case 'done':
        if (wasCancelled) {
          return totalToScore > 0
            ? `Cancelled · ${scoredCount} scored`
            : `Cancelled · ${listingsFound} listings`;
        }
        return totalToScore > 0
          ? `Done · ${scoredCount} new jobs scored`
          : 'Done · no new jobs this run';
      case 'error':
        return errorKind === 'session_expired'
          ? 'Search failed · LinkedIn session expired'
          : 'Search failed';
      default:
        return '';
    }
  })();

  return (
    <div className={`rounded-md border px-4 py-3 ${tone}`}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{headline}</span>
        <div className="flex items-center gap-3">
          {phase === 'discovering' && currentTaskId && (
            <Button
              variant="ghost"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => void cancel.mutate({ task_id: currentTaskId })}
            >
              Stop
            </Button>
          )}
          <span className="text-xs text-ink-muted">{elapsed} elapsed</span>
        </div>
      </div>
      {/* progress bar unchanged */}
    </div>
  );
}
```

- [ ] **Step 5: Run the tests + build, expect pass**

Run: `pnpm --filter @vina/web test -- search-progress-store SearchActivityPanel && pnpm --filter @vina/web build`
Expected: PASS. The existing `SearchNowButton` tests must remain green — the store extension is additive, no existing call site breaks.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/store/search-progress-store.ts \
        packages/web/src/api/ws.ts \
        packages/web/src/components/search/SearchActivityPanel.tsx \
        packages/web/tests/store/search-progress-store.test.ts \
        packages/web/tests/components/search/SearchActivityPanel.stop.test.tsx
git commit -m "feat(web): add Stop button and currentTaskId tracking for in-flight searches"
```

---

## Phase 10 — Integration test for cancellation

### Task 10: Extend the Google Jobs e2e with a cancellation scenario

**Files:**
- Modify: `packages/server/tests/integration/google-jobs-e2e.test.ts` (extend)

Alternatively, if the test file is already large or the cancellation requires its own fixtures, create a sibling `packages/server/tests/integration/search-cancel-e2e.test.ts` and lift the relevant `beforeEach` plumbing.

**Approach.** Reuse the existing SerpAPI fixture and `makeFixtureSearch`. The new test:

1. Enqueues a `search` task via the queue, then starts the worker.
2. Subscribes a listener to `search:cancelled` on the bus.
3. As soon as the first `jobs:updated` event fires (proof the iterator yielded at least one listing), calls `cancelActiveTask(task.id)`.
4. After the worker drains, asserts:
   - the task row's `status === 'cancelled'` and `failed_reason === 'cancelled_by_user'`;
   - at least one job persists in the DB;
   - `listings_added` in the `search:cancelled` event payload equals the actual job count;
   - no `search:completed` event was emitted.

The fixture has three pages of listings; cancelling after the first page persists 25 listings (1 page worth) and leaves the second + third pages unfetched.

- [ ] **Step 1: Re-read the existing e2e test**

Read `packages/server/tests/integration/google-jobs-e2e.test.ts` (already cached above). Confirm `startGoogleJobsFixture` returns a handle with `url` and `close()`. The `makeFixtureSearch` helper preserves `opts.signal`, so the iterator will return on abort.

- [ ] **Step 2: Write the failing test**

Append to `google-jobs-e2e.test.ts`:

```ts
it('cancellation mid-search persists listings up to the abort, flips task to cancelled, emits search:cancelled, no completed', async () => {
  const { createWorker } = await import('../../src/queue/worker.js');
  const { enqueue, findById } = await import('../../src/db/repositories/task-queue.js');
  const { cancelActiveTask, _resetActiveTasksForTests } = await import('../../src/queue/active-tasks.js');

  _resetActiveTasksForTests();

  const bus = createEventBus();
  const events: Array<{ name: string; payload: unknown }> = [];
  bus.on('search:cancelled', (p) => events.push({ name: 'search:cancelled', payload: p }));
  bus.on('search:completed', (p) => events.push({ name: 'search:completed', payload: p }));

  const fixtureSearch = makeFixtureSearch(fixture.url);
  const searchHandler = createSearchHandler({
    db,
    bus,
    browserManager: { getContext: async () => ({ newPage: async () => ({}) }), closeAll: async () => {} } as never,
    adapters: {},
    serpapiSearch: fixtureSearch,
  });

  // Enqueue and run via the real worker so the active-tasks plumbing kicks in.
  const task = enqueue(db, { kind: 'search', payload: { site_id: 'google' } });
  const worker = createWorker({
    db,
    bus,
    pollIntervalMs: 25,
    handlers: { search: searchHandler },
  });

  // Cancel as soon as the first listings are visible.
  let cancelled = false;
  bus.on('jobs:updated', () => {
    if (!cancelled) {
      cancelled = true;
      // Run on next tick to let the handler emit jobs:updated before we abort.
      setImmediate(() => cancelActiveTask(task.id));
    }
  });

  worker.start();

  // Wait up to 5s for the row to settle.
  const settled = await new Promise<boolean>((resolve) => {
    const t0 = Date.now();
    const poll = (): void => {
      const row = findById(db, task.id);
      if (row && (row.status === 'cancelled' || row.status === 'completed' || row.status === 'failed')) {
        return resolve(true);
      }
      if (Date.now() - t0 > 5_000) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  });
  await worker.stop(5_000);

  expect(settled).toBe(true);
  const row = findById(db, task.id)!;
  expect(row.status).toBe('cancelled');
  expect(row.failed_reason).toBe('cancelled_by_user');

  const jobs = listJobs(db, { site_id: 'google' });
  expect(jobs.length).toBeGreaterThan(0);

  const cancelledEvents = events.filter((e) => e.name === 'search:cancelled');
  expect(cancelledEvents.length).toBe(1);
  expect((cancelledEvents[0]!.payload as { listings_added: number }).listings_added).toBe(jobs.length);

  expect(events.find((e) => e.name === 'search:completed')).toBeUndefined();
});
```

If the fixture only serves a single page (verify by reading `tests/fixtures/sites/google/server.ts`), adjust the assertion to "at least one listing" and accept that the test exercises the "abort between listings within a single page" case rather than "abort between pages." Both code paths matter; if the fixture is single-page, add a multi-page variant of `startGoogleJobsFixture` for this test.

- [ ] **Step 3: Run the test, expect failure (or success if Phase 5 fully landed)**

Run: `pnpm --filter @vina/server test -- google-jobs-e2e`
Expected: depends on Phase 5 quality. If everything in Phase 5 landed correctly, this should PASS on the first try — the test exercises code paths already covered by unit tests. If it fails, the most likely culprits are (a) `setImmediate` timing — the cancel fires after the iterator has already finished yielding the page; (b) the worker's `cancelTaskRow` call running after the handler's `complete` emits — verify the AbortedError path takes precedence over `complete` in `runOne`.

- [ ] **Step 4: Iterate if needed**

If the test is flaky on cancel timing, tighten the iterator's page size in the fixture (one listing per page → cancel after the first listing) or wrap the test with a `vi.useFakeTimers` setup. Avoid raising the polling interval — it slows the rest of the suite.

- [ ] **Step 5: Run the full integration suite**

Run: `pnpm --filter @vina/server test -- integration`
Expected: PASS for both `google-jobs-e2e` and `linkedin-e2e`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/tests/integration/google-jobs-e2e.test.ts
git commit -m "test(server): integration cancel scenario for Google Jobs search"
```

---

## Phase 11 — Final verification

### Task 11: Full suite + lint + build + spec status flip

**Files:**
- Modify: `docs/superpowers/specs/2026-05-16-multi-source-search-controls-design.md` (status line)

- [ ] **Step 1: Full test pass**

Run from repo root: `pnpm test`
Expected: every workspace's test suite passes. Pay attention to:
- `@vina/shared` — events schema.
- `@vina/server` — worker, search handler, active-tasks, cancel route, integration e2e.
- `@vina/web` — site-status, cancel-search, validate-empty, SitesTile, SearchNowButton, SearchActivityPanel, store.

If any pre-existing test regresses, root-cause before continuing. Likely culprits and fixes:

- **`packages/web/tests/api/resources.google.test.tsx`** — likely asserts `state === 'connected'`. Update to `'active'`. (Already touched in Phase 6 if the rename was atomic; verify.)
- **`packages/server/tests/queue/handlers/search.test.ts`** (LinkedIn) — likely passes a synthetic payload `{ site_id: 'linkedin' }` without `_signal`. The handler defaults `_signal` to undefined; no change needed unless an assertion checks `payload._signal === undefined` after the run.
- **`packages/server/tests/integration/linkedin-e2e.test.ts`** — verify the AbortSignal threading doesn't break the LinkedIn path. The browser-search abort checks only fire when `signal?.aborted` — if the test never aborts, the new code is a no-op.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: clean. Fix any rule violations from the new code (`require-yield`, `no-floating-promises`, `prefer-as-const`).

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: every package compiles. Strict TypeScript on; any new `any` requires a `// reason:` comment per CLAUDE.md.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Spin up the dev server (`pnpm dev`) and click through the flow once:
- Settings → Sites: toggle LinkedIn off → search now button reflects only Google (or disabled if neither).
- Connect Google Jobs with an empty key → "Key is required" appears without a network call (B3).
- Disconnect Google Jobs with the edit form open → form auto-closes (B2).
- Both sources active → Search Now → dropdown opens → "Search both" fires two tasks.
- Click Stop mid-discovery → headline flips to "Cancelled · N listings" within ~2s; the task row in `task_queue` reads `'cancelled'`.

- [ ] **Step 5: Flip the spec status**

In `docs/superpowers/specs/2026-05-16-multi-source-search-controls-design.md`, change line 3:

```
**Status:** Implemented (2026-05-16).
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-05-16-multi-source-search-controls-design.md
git commit -m "docs(spec): mark multi-source search controls slice implemented"
```

---

## Appendix — Mapping spec § to tasks

| Spec § | Slice item | Plan task(s) |
|---|---|---|
| §1.2 (1) | `/api/sites` exposes `has_credentials` | Phase 1 / Task 1 |
| §1.2 (2) | Generic `useSiteStatus(id)` web hook | Phase 6 / Task 6A |
| §1.2 (3) | Per-source active/inactive toggle (Switch) | Phase 7 / Task 7B |
| §1.2 (4) | Multi-source-aware Search Now (B4) | Phase 9 / Task 9A |
| §1.2 (5) | Stop button + cancel route + AbortSignal threading | Phases 4, 5, 9 (Tasks 4A, 4B, 5, 9B) |
| §1.2 (6) B1 | `useSiteStatus` derives from `has_credentials` not `enabled` | Phase 6 / Task 6A |
| §1.2 (6) B2 | Auto-close edit-key form on `not_configured` | Phase 8 / Task 8 |
| §1.2 (6) B3 | `useValidateSerpapiKey` empty-key fence | Phase 7 / Task 7A |
| §1.2 (6) B4 | `SearchNowButton` multi-source enable check | Phase 9 / Task 9A |
| §1.3 | Deferred: per-source thresholds, mid-score cancel, CLI cancel, maxPages | (out of scope; no tasks) |
| §2.1 | `has_credentials` derivation | Phase 1 / Task 1 |
| §2.2 | `useSiteStatus(id)` projection + precedence | Phase 6 / Task 6A |
| §2.3 | Per-source enable toggle + `useToggleSite` reuse | Phase 7 / Task 7B |
| §2.4 | Search Now redesign + dropdown | Phase 9 / Task 9A |
| §2.5 | `active-tasks` map + `POST /api/searches/cancel` + handler signal threading + WS event | Phases 3, 4, 5 (Tasks 3, 4A, 4B, 5) |
| §2.6 | Schema: `task_queue.status` 'cancelled' (verify — no-op) | Phase 2 / Task 2 |
| §2.7 | Stop button UI + `currentTaskId` on the store | Phase 9 / Task 9B |
| §3.1 | B1 root cause + fix | Phase 6 / Task 6A |
| §3.2 | B2 auto-close `useEffect` | Phase 8 / Task 8 |
| §3.3 | B3 `useValidateSerpapiKey` guard | Phase 7 / Task 7A |
| §3.4 | B4 see §2.4 | Phase 9 / Task 9A |
| §4 | Server endpoints | Phase 1 (GET /api/sites), Phase 4 (POST /api/searches/cancel) |
| §5 | UX details | Phase 7 (Switch UI), Phase 9 (dropdown + Stop) |
| §6 | Edge cases — concurrent searches, cancel race, paused source toggle | Covered by tests in Phases 4, 5, 6, 9, 10 |
| §7 | Recorded decisions | (reference only; no tasks) |
| §8 | NOT in this slice | (out of scope; no tasks) |
| §9 | Success criteria | Phase 11 / Task 11 manual smoke covers each |
| §10 | Implementation order | Reordered slightly: schema verification (Phase 2) moved adjacent to server route changes; web hook refactor (Phase 6) precedes the per-source toggle (Phase 7) so the toggle can read the generic state immediately |
