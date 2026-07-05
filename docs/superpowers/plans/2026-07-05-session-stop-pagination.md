# Session-Expiry Detection, Search Stop Gaps, Jobs Pagination — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect LinkedIn's logged-out guest pages as session expiry, make search Stop work during retry backoff, and replace jobs-page infinite scroll with numbered pagination.

**Architecture:** Three independent changes per `docs/superpowers/specs/2026-07-05-session-stop-pagination-design.md`. (1) The LinkedIn adapter's `onSessionExpired` gains guest-page heuristics and the search handler asserts a logged-in landing pre-flight. (2) The cancel route flips pending/running task rows via the existing repository `cancel()` and emits `search:cancelled` for rows nothing is executing; the UI shows Stop through a new non-terminal `retrying` phase driven by a `will_retry` flag on `search:failed`. (3) `GET /api/jobs` gains `total`; the web jobs page swaps `useInfiniteQuery` + IntersectionObserver for a paged query plus a reusable `PaginationBar`.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Playwright (fixture-driven tests), zod, React 18, TanStack Query v5, Zustand, Vitest.

## Global Constraints

- Strict TypeScript; no `any` without `// reason:` comment.
- No default exports (except React page components / Vite entrypoints).
- Typed errors extending `VinaError`; never bare strings.
- Logger from `@vina/shared`; no `console.log`.
- Conventional Commits, scope by package, **single short subject line, no body, no Claude byline** (user preference).
- Specs are source of truth — `docs/api-spec.md` and `docs/browser-automation.md` updated in the tasks that change behaviour.
- Run commands from the repo root `/Users/user/Desktop/vina`.
- `pnpm --filter @vina/<pkg> test -- <path>` runs a single test file with Vitest.

---

### Task 1: LinkedIn guest-page session heuristics (automation)

LinkedIn serves logged-out visitors real pages (guest SERP with `public_jobs_*` tracking attributes, `/authwall`) instead of redirecting to `/login`. Teach `onSessionExpired` those markers, sharing one heuristics constant with the apply flow.

**Files:**
- Create: `packages/automation/src/adapters/linkedin/heuristics.ts`
- Modify: `packages/automation/src/adapters/linkedin/index.ts` (the `onSessionExpired` method, ~line 257)
- Modify: `packages/automation/src/adapters/linkedin/application.ts` (delete local `LINKEDIN_SESSION_HEURISTICS`, ~line 80; import instead)
- Modify: `tests/fixtures/sites/linkedin/pages.ts` (add `guestSearchResultsPage()`)
- Modify: `tests/fixtures/sites/linkedin/server.ts` (add `/jobs/search-guest`, `/authwall` routes and a `serp: 'guest'` option)
- Test: `packages/automation/tests/adapters/linkedin.test.ts`
- Docs: `docs/browser-automation.md` (session-detection paragraph)

**Interfaces:**
- Consumes: `SessionExpiredHeuristics`, `isSessionExpiredOnPage` from `packages/automation/src/detect/session.ts` (existing).
- Produces: `LINKEDIN_SESSION_HEURISTICS: SessionExpiredHeuristics` (exported from `heuristics.ts`); `startLinkedInFixture(opts?: { serp?: 'authed' | 'guest' })`; fixture routes `/jobs/search-guest` and `/authwall`. Task 2 relies on `startLinkedInFixture({ serp: 'guest' })` and on `linkedInAdapter.onSessionExpired` returning true on guest pages.

- [ ] **Step 1: Add the guest SERP fixture page**

In `tests/fixtures/sites/linkedin/pages.ts`, append:

```ts
/**
 * Logged-out "jserp" guest SERP: job cards exist but carry
 * `public_jobs_*` tracking names and /jobs/view/ anchors instead of the
 * authenticated SPA structure. Mirrors what LinkedIn serves when the
 * session cookie has expired (plus an authwall modal).
 */
export function guestSearchResultsPage(): string {
  return `<!doctype html><html><head><title>563 Software jobs in United Kingdom</title></head>
<body>
  <div role="dialog" class="authwall-modal">Sign in to view more jobs</div>
  <ul class="jobs-search__results-list">
    <li><a data-tracking-control-name="public_jobs_jserp-result_search-card" href="/jobs/view/101">Senior Software Engineer</a></li>
    <li><a data-tracking-control-name="public_jobs_jserp-result_search-card" href="/jobs/view/102">Backend Engineer</a></li>
  </ul>
</body></html>`;
}
```

- [ ] **Step 2: Serve it from the fixture server**

In `tests/fixtures/sites/linkedin/server.ts`, import `guestSearchResultsPage`, give `startLinkedInFixture` an options parameter, and register the new routes. Replace the function signature and the `respondWithSearchResults` block:

```ts
export async function startLinkedInFixture(
  opts: { serp?: 'authed' | 'guest' } = {},
): Promise<FixtureServerHandle> {
  return startFixtureServer(async (app) => {
    // ...existing routes unchanged...
    const respondWithSearchResults = async (
      _req: unknown,
      reply: { type: (mime: string) => { send: (body: string) => unknown } },
    ): Promise<unknown> =>
      reply
        .type('text/html')
        .send(opts.serp === 'guest' ? guestSearchResultsPage() : searchResultsPage());
    app.get('/jobs/search', respondWithSearchResults);
    app.get('/jobs/search/', respondWithSearchResults);
    // Always-on guest routes so adapter tests don't need a second fixture boot.
    app.get('/jobs/search-guest', async (_req, reply) =>
      reply.type('text/html').send(guestSearchResultsPage()),
    );
    app.get('/authwall', async (_req, reply) =>
      reply.type('text/html').send(guestSearchResultsPage()),
    );
    // ...existing /jobs/view/* routes unchanged...
  });
}
```

Keep every existing route; only the SRP responder becomes conditional.

- [ ] **Step 3: Write the failing adapter tests**

In `packages/automation/tests/adapters/linkedin.test.ts`, inside the `describe('linkedInAdapter — login predicates', ...)` block, add:

```ts
  it('onSessionExpired detects the logged-out guest SERP', async () => {
    await page.goto(`${fixture.url}/jobs/search-guest`);
    expect(await linkedInAdapter.onSessionExpired(page)).toBe(true);
  }, 30_000);

  it('onSessionExpired detects the authwall path', async () => {
    await page.goto(`${fixture.url}/authwall`);
    expect(await linkedInAdapter.onSessionExpired(page)).toBe(true);
  }, 30_000);

  it('onSessionExpired stays false on the authenticated SRP', async () => {
    await page.goto(`${fixture.url}/jobs/search?keywords=x`);
    expect(await linkedInAdapter.onSessionExpired(page)).toBe(false);
  }, 30_000);
```

- [ ] **Step 4: Run tests to verify the new ones fail**

Run: `pnpm --filter @vina/automation test -- tests/adapters/linkedin.test.ts`
Expected: the two new "detects" tests FAIL (`onSessionExpired` currently only checks `/login`); "stays false" and all pre-existing tests PASS.

- [ ] **Step 5: Create the shared heuristics module**

Create `packages/automation/src/adapters/linkedin/heuristics.ts`:

```ts
import type { SessionExpiredHeuristics } from '../../detect/session.js';

/**
 * LinkedIn doesn't bounce logged-out browsers to /login — it serves real
 * public pages: /authwall, the guest homepage, and a guest "jserp" SERP
 * whose elements carry `public_jobs_*` tracking names (markup that never
 * appears on the authenticated experience). Expiry detection therefore
 * needs DOM markers, not just URL paths.
 */
export const LINKEDIN_SESSION_HEURISTICS: SessionExpiredHeuristics = {
  loginPathPatterns: [/^\/login/, /^\/uas\/login/, /^\/authwall/],
  selectors: ['[data-tracking-control-name^="public_jobs_"]'],
  textPatterns: ['Sign in to continue'],
};
```

- [ ] **Step 6: Use it in the adapter and the apply flow**

In `packages/automation/src/adapters/linkedin/index.ts`, add imports and replace `onSessionExpired`:

```ts
import { isSessionExpiredOnPage } from '../../detect/session.js';
import { LINKEDIN_SESSION_HEURISTICS } from './heuristics.js';
```

```ts
  async onSessionExpired(page) {
    return isSessionExpiredOnPage(page, LINKEDIN_SESSION_HEURISTICS);
  },
```

In `packages/automation/src/adapters/linkedin/application.ts`, delete the local `const LINKEDIN_SESSION_HEURISTICS = { ... } as const;` (~line 80) and add:

```ts
import { LINKEDIN_SESSION_HEURISTICS } from './heuristics.js';
```

- [ ] **Step 7: Run the automation tests**

Run: `pnpm --filter @vina/automation test -- tests/adapters/linkedin.test.ts tests/adapters/linkedin-application.integration.test.ts tests/detect/session.test.ts`
Expected: ALL PASS.

- [ ] **Step 8: Update docs**

In `docs/browser-automation.md`, find the session-expiry/heuristics section and add one short paragraph: LinkedIn expiry detection matches `/login`, `/uas/login`, `/authwall` URL paths **and** the DOM marker `[data-tracking-control-name^="public_jobs_"]`, because LinkedIn serves logged-out visitors real guest pages rather than redirecting to a login URL.

- [ ] **Step 9: Commit**

```bash
git add packages/automation tests/fixtures/sites/linkedin docs/browser-automation.md
git commit -m "fix(automation): detect LinkedIn guest pages as expired session"
```

---

### Task 2: Search handler pre-flight + zero-listings session check (server)

**Files:**
- Modify: `packages/server/src/queue/handlers/search.ts` (pre-flight ~line 267; success-path zero-listings ~line 344)
- Test: `packages/server/tests/queue/handlers/search.test.ts`

**Interfaces:**
- Consumes: `startLinkedInFixture({ serp: 'guest' })` and guest-aware `onSessionExpired` from Task 1; existing `LinkedInSessionExpiredError`, `createSearchHandler`, `listAlerts`.
- Produces: no new exports — behavioural change only (guest session → `linkedin_session_expired` alert instead of `search_failed` "0 listings").

- [ ] **Step 1: Write the failing tests**

In `packages/server/tests/queue/handlers/search.test.ts`, inside `describe('search handler — real LinkedIn flow', ...)`, add:

```ts
  it('throws session-expired when the feed navigation lands off-feed', async () => {
    const handler = createSearchHandler({
      db,
      bus: createEventBus(),
      browserManager: bm,
      adapters: { linkedin: linkedInAdapter },
      // Guest-home stand-in: a LinkedIn page that is not /feed and not /login.
      feedUrlOverride: `${fixture.url}/jobs`,
    });
    await expect(handler({ site_id: 'linkedin' })).rejects.toThrow(/session/i);
    expect(listAlerts(db, { kind: 'linkedin_session_expired' }).length).toBe(1);
  }, 60_000);

  it('classifies the guest SERP as session-expired, not "0 listings"', async () => {
    const guest = await startLinkedInFixture({ serp: 'guest' });
    try {
      const handler = createSearchHandler({
        db,
        bus: createEventBus(),
        browserManager: bm,
        adapters: { linkedin: linkedInAdapter },
        feedUrlOverride: `${guest.url}/feed`,
      });
      await expect(handler({ site_id: 'linkedin' })).rejects.toThrow(/session/i);
      expect(listAlerts(db, { kind: 'linkedin_session_expired' }).length).toBe(1);
      expect(listAlerts(db, { kind: 'search_failed' }).length).toBe(0);
    } finally {
      await guest.close();
    }
  }, 90_000);
```

Note: the guest-SERP test takes ~35s — the card-selector wait (30s) must time out before the error path checks the session. That's the same path production took on 2026-07-05.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @vina/server test -- tests/queue/handlers/search.test.ts`
Expected: "lands off-feed" FAILS (no error thrown — today only `/login` counts). "guest SERP" PASSES already if Task 1 landed (the error path at line ~354 re-checks `onSessionExpired`, which now knows guest markers) — that's expected; it pins the regression. All pre-existing tests PASS.

- [ ] **Step 3: Implement the pre-flight assertion**

In `packages/server/src/queue/handlers/search.ts`, replace the pre-flight block (~lines 267-271):

```ts
      await page.goto(deps.feedUrlOverride ?? FEED_URL);

      // LinkedIn doesn't bounce logged-out browsers to /login — it redirects
      // /feed to the guest homepage and keeps serving public pages. Landing
      // anywhere other than the feed is as conclusive as a login redirect.
      if (
        (await adapter.onSessionExpired(page)) ||
        !(await adapter.onLoginSuccess(page))
      ) {
        throw new LinkedInSessionExpiredError();
      }
```

- [ ] **Step 4: Check the session before LLM recovery on the empty-success path**

Same file, the success-path zero-listings branch (~line 344) — add the session check ahead of `recoverViaSelectorResolver`, mirroring the error path at ~line 354:

```ts
        if (!signal?.aborted && listings.length === 0) {
          // A guest page yields zero cards "successfully" — don't burn LLM
          // selector-recovery calls on a page we can't be logged into.
          if (await adapter.onSessionExpired(page)) {
            throw new LinkedInSessionExpiredError();
          }
          const recovered = await recoverViaSelectorResolver();
          if (recovered.length > 0) listings = recovered;
        }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @vina/server test -- tests/queue/handlers/search.test.ts tests/queue/handlers/search.cancel.test.ts tests/queue/handlers/search.google.test.ts`
Expected: ALL PASS (the off-feed pre-flight test now throws `LinkedInSessionExpiredError`).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/queue/handlers/search.ts packages/server/tests/queue/handlers/search.test.ts
git commit -m "fix(server): treat off-feed landing and guest SERP as expired LinkedIn session"
```

---

### Task 3: Cancel covers retry-backoff tasks (server)

`POST /api/searches/cancel` today only aborts the in-memory registry. Make it also flip pending/running `task_queue` rows (repository `cancel()` already exists) and emit `search:cancelled` when nothing is executing the row, so the UI leaves its retry state.

**Files:**
- Modify: `packages/server/src/db/repositories/task-queue.ts` (`cancel` returns boolean; add `findTaskById`, `listCancellableSearchTasks`)
- Modify: `packages/server/src/queue/active-tasks.ts` (`cancelTasksForSite` returns the aborted ids)
- Modify: `packages/server/src/http/routes/searches.ts` (cancel route rewrite; deps gain `bus`)
- Modify: `packages/server/src/app.ts:79` (pass `bus` to `searchRoutes`)
- Test: `packages/server/tests/http/searches.test.ts`, `packages/server/tests/queue/active-tasks.test.ts`
- Docs: `docs/api-spec.md` (cancel endpoint semantics)

**Interfaces:**
- Consumes: existing `cancel(db, id, reason)` / `Task` type from the task-queue repository; `cancelActiveTask` from `active-tasks.ts`; `EventBus`.
- Produces: `cancel(db, id, reason?): boolean` (true when a pending/running row was flipped); `findTaskById(db, id): Task | null`; `listCancellableSearchTasks(db, siteId): Task[]`; `cancelTasksForSite(siteId): string[]` (aborted task ids — **breaking change** from the old `number` return, callers updated here). Task 4's web work relies on the route emitting `search:cancelled` for backoff rows.

- [ ] **Step 1: Write the failing route tests**

In `packages/server/tests/http/searches.test.ts`, extend the imports:

```ts
import {
  enqueue,
  fail as failTask,
  findTaskById,
  setNextAttemptAt,
} from '../../src/db/repositories/task-queue.js';
```

Add inside `describe('POST /api/searches/cancel', ...)`:

```ts
  it('flips a pending retry-backoff search task to cancelled', async () => {
    const t = enqueue(h.db, { kind: 'search', payload: { site_id: 'linkedin' } });
    failTask(h.db, t.id, 'handler_timeout: search exceeded 300000ms', true);
    setNextAttemptAt(h.db, t.id, new Date(Date.now() + 60_000).toISOString());

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/searches/cancel',
      headers: auth(h.token),
      payload: { task_id: t.id },
    });
    expect(res.json()).toEqual({ cancelled: 1 });
    expect(findTaskById(h.db, t.id)?.status).toBe('cancelled');
  });

  it('cancel by site_id sweeps pending search rows and leaves other sites alone', async () => {
    const mine = enqueue(h.db, { kind: 'search', payload: { site_id: 'linkedin' } });
    const other = enqueue(h.db, { kind: 'search', payload: { site_id: 'google' } });
    const score = enqueue(h.db, { kind: 'score', payload: { job_id: 'j1' } });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/searches/cancel',
      headers: auth(h.token),
      payload: { site_id: 'linkedin' },
    });
    expect(res.json()).toEqual({ cancelled: 1 });
    expect(findTaskById(h.db, mine.id)?.status).toBe('cancelled');
    expect(findTaskById(h.db, other.id)?.status).toBe('pending');
    expect(findTaskById(h.db, score.id)?.status).toBe('pending');
  });

  it('double-cancel is idempotent — second call reports 0', async () => {
    const t = enqueue(h.db, { kind: 'search', payload: { site_id: 'linkedin' } });
    const fire = () =>
      h.app.inject({
        method: 'POST',
        url: '/api/searches/cancel',
        headers: auth(h.token),
        payload: { task_id: t.id },
      });
    expect((await fire()).json()).toEqual({ cancelled: 1 });
    expect((await fire()).json()).toEqual({ cancelled: 0 });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @vina/server test -- tests/http/searches.test.ts`
Expected: the three new tests FAIL (`cancelled: 0` and rows stay `pending` — the route never touches the DB today). The four pre-existing cancel tests PASS.

- [ ] **Step 3: Repository additions**

In `packages/server/src/db/repositories/task-queue.ts`, change `cancel` (~line 125) to report whether it flipped a row:

```ts
export function cancel(db: DatabaseType, id: string, reason = 'cancelled_by_user'): boolean {
  const info = db
    .prepare(
      `UPDATE task_queue
         SET status = 'cancelled', failed_reason = ?
       WHERE id = ? AND status IN ('pending', 'running')`,
    )
    .run(reason, id);
  return info.changes > 0;
}
```

Append (reuse the file's existing `Task` row type and row-mapping helper if one exists — follow how `listPending` returns rows):

```ts
export function findTaskById(db: DatabaseType, id: string): Task | null {
  const row = db.prepare(`SELECT * FROM task_queue WHERE id = ?`).get(id) as Task | undefined;
  return row ?? null;
}

/**
 * Search tasks a user Stop can act on: running rows (abort the in-memory
 * signal) and pending rows (retry backoff — flip directly so the worker
 * never claims them). Payload is JSON; site filtering happens in JS.
 */
export function listCancellableSearchTasks(db: DatabaseType, siteId: string): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM task_queue
        WHERE kind = 'search' AND status IN ('pending', 'running')`,
    )
    .all() as Task[];
  return rows.filter((r) => {
    try {
      return (JSON.parse(r.payload) as { site_id?: string }).site_id === siteId;
    } catch {
      return false;
    }
  });
}
```

- [ ] **Step 4: `cancelTasksForSite` returns ids**

In `packages/server/src/queue/active-tasks.ts` (~lines 35-44), change the return type so the route can flip the matching rows:

```ts
/** Abort every active task registered for `siteId`; returns their task ids. */
export function cancelTasksForSite(siteId: string): string[] {
  const ids: string[] = [];
  for (const [taskId, entry] of activeTasks) {
    if (entry.site_id === siteId) {
      entry.abort();
      activeTasks.delete(taskId);
      ids.push(taskId);
    }
  }
  return ids;
}
```

(Keep the map-iteration/deletion pattern the file already uses; only the accumulator changes from a count to an id list.) Update `packages/server/tests/queue/active-tasks.test.ts` assertions from numbers to id arrays, e.g. `expect(cancelTasksForSite('google')).toEqual(['a', 'b'])` — adjust to that file's existing cases.

- [ ] **Step 5: Rewrite the cancel route**

In `packages/server/src/http/routes/searches.ts`: extend deps to `{ db: DatabaseType; poke: () => void; bus: EventBus }` (import `type { EventBus } from '../../events/bus.js'`), extend the task-queue import with `cancel as cancelTaskRow, findTaskById, listCancellableSearchTasks`, and replace the cancel handler:

```ts
  /**
   * Cancel one task: abort the live signal if it's running, flip the row so
   * a pending retry never runs. When nothing is executing the task (backoff
   * window) no handler will emit `search:cancelled` — emit it here so the
   * UI leaves its retrying state.
   */
  const cancelOne = (taskId: string): number => {
    const row = findTaskById(db, taskId);
    const flipped = row && row.kind === 'search' ? cancelTaskRow(db, taskId) : false;
    const aborted = cancelActiveTask(taskId);
    if (flipped && !aborted && row) {
      let siteId: string | undefined;
      try {
        siteId = (JSON.parse(row.payload) as { site_id?: string }).site_id;
      } catch {
        siteId = undefined;
      }
      bus.emit('search:cancelled', {
        task_id: taskId,
        site_id: siteId ?? 'unknown',
        listings_added: 0,
        scored: 0,
      });
    }
    return flipped || aborted ? 1 : 0;
  };

  app.post('/api/searches/cancel', async (req) => {
    const body = parse(CancelBodySchema, req.body, 'request body');
    if (body.task_id) {
      return { cancelled: cancelOne(body.task_id) };
    }
    // Site-wide: abort live registrations first (authoritative for running
    // work), then flip their rows plus any backoff rows for the site.
    const abortedIds = cancelTasksForSite(body.site_id!);
    for (const id of abortedIds) cancelTaskRow(db, id);
    let flippedExtra = 0;
    for (const row of listCancellableSearchTasks(db, body.site_id!)) {
      if (cancelTaskRow(db, row.id)) {
        flippedExtra += 1;
        let siteId: string | undefined;
        try {
          siteId = (JSON.parse(row.payload) as { site_id?: string }).site_id;
        } catch {
          siteId = undefined;
        }
        bus.emit('search:cancelled', {
          task_id: row.id,
          site_id: siteId ?? body.site_id!,
          listings_added: 0,
          scored: 0,
        });
      }
    }
    return { cancelled: abortedIds.length + flippedExtra };
  });
```

Remove the now-unused `cancelTasksForSite`-as-count usage; `destructure bus` alongside `db, poke`. In `packages/server/src/app.ts:79`, change the registration to `await searchRoutes(api, { db: deps.db, poke: deps.poke, bus: deps.bus });`.

- [ ] **Step 6: Run the server tests**

Run: `pnpm --filter @vina/server test -- tests/http/searches.test.ts tests/queue/active-tasks.test.ts tests/queue/worker.cancel.test.ts`
Expected: ALL PASS — including the pre-existing cancel tests (registry-only ids like `'t-known'` have no DB row: `flipped=false`, `aborted=true`, count 1).

- [ ] **Step 7: Update `docs/api-spec.md`**

Find the `POST /api/searches/cancel` section and document: cancels running **and** pending (retry-backoff) search tasks; pending rows are flipped to `cancelled` directly and a `search:cancelled` WebSocket event is emitted for them; `cancelled` counts distinct tasks acted on.

- [ ] **Step 8: Commit**

```bash
git add packages/server docs/api-spec.md
git commit -m "fix(server): search cancel also flips pending retry-backoff tasks"
```

---

### Task 4: `will_retry` flag + `retrying` phase + Stop lifecycle (shared, server, web)

A failed-but-retrying search is invisible to the UI today (`search:failed` → terminal error → auto-reset). Thread `will_retry` through the event so the store can hold a non-terminal `retrying` phase with the Stop button available.

**Files:**
- Modify: `packages/shared/src/events.ts` (SearchFailedPayload)
- Modify: `packages/server/src/queue/worker.ts` (~line 147 block: stamp `_will_retry`)
- Modify: `packages/server/src/queue/handlers/search.ts` (payload type ~line 222; both `search:failed` emits, lines ~533 and ~763)
- Modify: `packages/web/src/api/ws.ts` (`search:failed` case)
- Modify: `packages/web/src/store/search-progress-store.ts` (phase union, `markRetrying`)
- Modify: `packages/web/src/components/search/SearchActivityPanel.tsx` (headline + Stop condition)
- Modify: `packages/web/src/components/search/SearchNowButton.tsx` (label + inFlight)
- Test: `packages/shared/tests/events.test.ts`, `packages/server/tests/queue/worker.cancel.test.ts`, `packages/web/tests/store/search-progress-store.test.ts`, `packages/web/tests/components/search/SearchActivityPanel.stop.test.tsx`

**Interfaces:**
- Consumes: worker's claimed `task.attempts`/`task.max_attempts` (post-claim attempt count — same expression the retry decision uses); Task 3's route-emitted `search:cancelled`.
- Produces: `SearchFailedPayload.will_retry?: boolean`; transient `payload._will_retry` (search tasks only, like `_signal`); `SearchPhase` gains `'retrying'`; store action `markRetrying(): void`.

- [ ] **Step 1: Failing shared-events test**

In `packages/shared/tests/events.test.ts`, add to the `fixtures` array in the round-trip test:

```ts
      [
        EVENTS.SEARCH_FAILED,
        { task_id: '01T', site_id: 'linkedin', error_kind: 'unknown', will_retry: true },
      ],
```

Run: `pnpm --filter @vina/shared test -- tests/events.test.ts` — expected FAIL (unknown key / strict schema rejects `will_retry`).

- [ ] **Step 2: Extend the schema**

In `packages/shared/src/events.ts` (~line 85):

```ts
const SearchFailedPayload = z.object({
  task_id: z.string(),
  site_id: z.string(),
  error_kind: z.enum(['session_expired', 'network', 'unknown']),
  /** True when the worker will re-run this task (attempts remain). */
  will_retry: z.boolean().optional(),
});
```

Run the same test — expected PASS. Then `pnpm --filter @vina/shared build` (server/web consume the built types).

- [ ] **Step 3: Failing worker test**

In `packages/server/tests/queue/worker.cancel.test.ts`, add (same harness as the file's first test — full handler map, `pollIntervalMs: 5`, `vi.waitFor`):

```ts
  it('stamps _will_retry on search payloads while attempts remain', async () => {
    let observed: boolean | undefined;
    const worker = createWorker({
      db,
      bus: createEventBus(),
      handlers: {
        search: async (payload) => {
          observed = (payload as { _will_retry?: boolean })._will_retry;
        },
        score: async () => undefined,
        tailor: async () => undefined,
        apply: async () => undefined,
        prepare_manual_apply: async () => undefined,
        resume: async () => undefined,
      },
      pollIntervalMs: 5,
    });
    enqueue(db, { kind: 'search', payload: { site_id: 'google' }, max_attempts: 3 });
    worker.start();
    await vi.waitFor(() => expect(observed).toBe(true), { timeout: 2_000, interval: 25 });
    await worker.stop();
  });
```

Run: `pnpm --filter @vina/server test -- tests/queue/worker.cancel.test.ts` — expected FAIL (`observed` is `undefined`).

- [ ] **Step 4: Stamp it in the worker**

In `packages/server/src/queue/worker.ts`, inside the existing `if (task.kind === 'search')` block (after the `task_id` stamp, ~line 156):

```ts
      // Same transient-slot trick as _signal: lets the handler annotate
      // search:failed with whether the worker will re-run the task, without
      // widening TaskHandler<P>. task.attempts is the post-claim attempt
      // count — the same value the retry decision in the catch uses.
      (payload as Record<string, unknown>)._will_retry =
        task.attempts < task.max_attempts;
```

Run the worker test — expected PASS.

- [ ] **Step 5: Emit it from the search handler**

In `packages/server/src/queue/handlers/search.ts`: add `_will_retry?: boolean;` next to `_signal` in the payload type (~line 222, browser path) and its google-path equivalent if typed separately. Update **both** `search:failed` emits (~line 533 and ~line 763):

```ts
    deps.bus.emit('search:failed', {
      task_id: payload.task_id ?? 'unknown',
      site_id: site.id,
      error_kind: errorKind,
      will_retry: payload._will_retry === true,
    });
```

(At line 763 the variable holding the error kind may be named differently — keep that emit's existing fields and add only `will_retry`.)

Run: `pnpm --filter @vina/server test -- tests/queue/handlers` — expected ALL PASS.

- [ ] **Step 6: Failing web store test**

In `packages/web/tests/store/search-progress-store.test.ts`, add (match the file's existing get/act/assert style):

```ts
  it('markRetrying holds a non-terminal retrying phase and keeps the task id', () => {
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't7' });
    useSearchProgressStore.getState().markRetrying();
    const s = useSearchProgressStore.getState();
    expect(s.phase).toBe('retrying');
    expect(s.currentTaskId).toBe('t7');
  });
```

Run: `pnpm --filter @vina/web test -- tests/store/search-progress-store.test.ts` — expected FAIL (`markRetrying` doesn't exist).

- [ ] **Step 7: Store + dispatcher + components**

`packages/web/src/store/search-progress-store.ts`:
- `export type SearchPhase = 'idle' | 'discovering' | 'retrying' | 'scoring' | 'done' | 'error';`
- Document the transition in the header comment: `discovering → retrying` on `search:failed { will_retry: true }`; `retrying → discovering` when the retry's `search:started` arrives; `retrying → done(wasCancelled)` on `search:cancelled`.
- Add to `SearchProgressActions`: `markRetrying: () => void;`
- Implementation (deliberately does NOT touch `currentTaskId` — the retry reuses the same task row):

```ts
    markRetrying: () =>
      set((s) =>
        s.phase === 'retrying' ? s : { phase: 'retrying', phaseChangedAt: Date.now() },
      ),
```

The auto-reset subscription stays untouched — `retrying` is non-terminal by design.

`packages/web/src/api/ws.ts`, `search:failed` case:

```ts
    case 'search:failed': {
      const p = payload as SearchFailedPayload | undefined;
      // Session expiry retries are pointless from the user's seat — surface
      // the actionable error immediately instead of "retrying…".
      if (p?.error_kind === 'session_expired') {
        store.markError('session_expired');
        break;
      }
      if (p?.will_retry) {
        store.markRetrying();
        break;
      }
      store.markError(p?.error_kind ?? 'unknown');
      break;
    }
```

`packages/web/src/components/search/SearchActivityPanel.tsx`:
- headline switch, new case above `'scoring'`:

```ts
      case 'retrying':
        return 'Search failed · retrying shortly…';
```

- Stop button condition (line ~101):

```tsx
          {(phase === 'discovering' || phase === 'retrying') && currentTaskId && (
```

`packages/web/src/components/search/SearchNowButton.tsx`:
- `const inFlight = runNow.isPending || phase === 'discovering' || phase === 'retrying' || phase === 'scoring';`
- label switch, new case:

```ts
      case 'retrying':
        return 'Retrying…';
```

(`use-search-gerund.ts` needs no change — `POOLS` is a `Partial` record; `retrying` simply has no pool.)

- [ ] **Step 8: Panel test for Stop-during-retry**

In `packages/web/tests/components/search/SearchActivityPanel.stop.test.tsx`:

```tsx
  it('keeps Stop visible while a failed search awaits retry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't9' });
    useSearchProgressStore.getState().markRetrying();
    renderPanel();
    expect(await screen.findByRole('button', { name: /stop/i })).toBeInTheDocument();
    expect(screen.getByText(/retrying/i)).toBeInTheDocument();
  });
```

- [ ] **Step 9: Run the web tests**

Run: `pnpm --filter @vina/web test -- tests/store/search-progress-store.test.ts tests/components/search/SearchActivityPanel.stop.test.tsx tests/components/search/SearchNowButton.test.tsx`
Expected: ALL PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/shared packages/server packages/web
git commit -m "feat(server,web): surface search retry state with Stop via will_retry flag"
```

---

### Task 5: `GET /api/jobs` returns `total` (server)

**Files:**
- Modify: `packages/server/src/db/repositories/jobs.ts` (extract WHERE builder, add `countJobs`)
- Modify: `packages/server/src/http/routes/jobs.ts` (~lines 38-51)
- Test: `packages/server/tests/db/repositories/jobs.test.ts`, `packages/server/tests/http/jobs.test.ts`
- Docs: `docs/api-spec.md` (jobs list section)

**Interfaces:**
- Consumes: existing `JobFilters` type and `listJobs` WHERE-clause logic.
- Produces: `countJobs(db, filters: Omit<JobFilters, 'limit' | 'offset'>): number`; route response `{ items, page, page_size, total }`. Task 6 relies on `total`.

- [ ] **Step 1: Failing tests**

`packages/server/tests/http/jobs.test.ts`, in `describe('GET /api/jobs', ...)`:

```ts
  it('returns a filter-aware total independent of page size', async () => {
    for (let i = 0; i < 5; i++) seedJob({ score: 80, status: 'scored' });
    seedJob({ score: 10, status: 'scored' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/jobs?status=scored&min_score=70&page=1&page_size=2',
      headers: auth(h.token),
    });
    expect(res.json().items).toHaveLength(2);
    expect(res.json().total).toBe(5);
  });
```

`packages/server/tests/db/repositories/jobs.test.ts` (mirror the file's existing seed helpers):

```ts
  it('countJobs applies the same filters as listJobs', () => {
    // seed 3 scored jobs ≥70 and 1 below using the file's seed pattern
    expect(countJobs(db, { status: 'scored', min_score: 70 })).toBe(3);
    expect(countJobs(db, {})).toBe(4);
  });
```

Run: `pnpm --filter @vina/server test -- tests/http/jobs.test.ts tests/db/repositories/jobs.test.ts`
Expected: both new tests FAIL (`total` undefined; `countJobs` not exported).

- [ ] **Step 2: Repository — shared WHERE builder + `countJobs`**

In `packages/server/src/db/repositories/jobs.ts`, extract the filter-building block at the top of `listJobs` (status/site_id/apply_method/min_score/search pushes) into:

```ts
function buildJobWhere(filters: Omit<JobFilters, 'limit' | 'offset'>): {
  whereSql: string;
  params: Record<string, unknown>;
} {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  // ...move the five existing filter blocks here verbatim (status, site_id,
  // apply_method, min_score incl. the NULL-keeps-unscored comment, search)...
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}
```

Move the blocks unchanged — do not reword the min_score comment. `listJobs` becomes a call to `buildJobWhere` + its existing ORDER BY/LIMIT tail. Add:

```ts
export function countJobs(
  db: DatabaseType,
  filters: Omit<JobFilters, 'limit' | 'offset'> = {},
): number {
  const { whereSql, params } = buildJobWhere(filters);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM jobs ${whereSql}`)
    .get(params) as { n: number };
  return row.n;
}
```

- [ ] **Step 3: Route returns total**

In `packages/server/src/http/routes/jobs.ts`, import `countJobs` and change the list handler's return:

```ts
    const filterArgs = {
      ...(status && { status }),
      ...(q.min_score !== undefined && { min_score: q.min_score }),
    };
    const items = listJobs(db, { ...filterArgs, limit: q.page_size, offset });
    const total = countJobs(db, filterArgs);
    return { items, page: q.page, page_size: q.page_size, total };
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @vina/server test -- tests/http/jobs.test.ts tests/db/repositories/jobs.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Fix `docs/api-spec.md`**

Replace the jobs-list section's `limit`/`cursor` description (never implemented) with the real contract: query `status` (comma-separated), `min_score`, `page` (1-based, default 1), `page_size` (1-100, default 50); response `{ items, page, page_size, total }` where `total` is the filter-aware count.

- [ ] **Step 6: Commit**

```bash
git add packages/server docs/api-spec.md
git commit -m "feat(server): filter-aware total on GET /api/jobs"
```

---

### Task 6: Jobs page pagination (web)

**Files:**
- Create: `packages/web/src/components/ui/pagination-bar.tsx`
- Modify: `packages/web/src/api/resources.ts` (`JobsListResponse` +total; add `useJobsPage`; delete `useInfiniteJobs`)
- Modify: `packages/web/src/routes/jobs/JobsPage.tsx` (page state, PaginationBar, remove sentinel)
- Test: `packages/web/tests/components/ui/pagination-bar.test.tsx` (new)

**Interfaces:**
- Consumes: `total` from Task 5; existing `Job`, `JobsFilters`, `api<T>()`, `Button`.
- Produces: `pageWindow(page: number, totalPages: number): Array<number | 'gap'>` and `PaginationBar({ page, pageSize, total, onPageChange }): JSX.Element | null`; `useJobsPage(filters: JobsFilters): { items: Job[]; total: number; isLoading: boolean }`. `useInfiniteJobs` is **removed** (JobsPage is its only consumer — verify with `grep -rn useInfiniteJobs packages/web/src packages/web/tests`).

- [ ] **Step 1: Failing PaginationBar test**

Create `packages/web/tests/components/ui/pagination-bar.test.tsx`:

```tsx
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { PaginationBar, pageWindow } from '../../../src/components/ui/pagination-bar.js';

afterEach(cleanup);

describe('pageWindow', () => {
  it('shows all pages when few', () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
  });
  it('collapses the middle with gaps', () => {
    expect(pageWindow(5, 23)).toEqual([1, 'gap', 4, 5, 6, 'gap', 23]);
  });
  it('handles first and last page without leading/trailing gaps', () => {
    expect(pageWindow(1, 23)).toEqual([1, 2, 'gap', 23]);
    expect(pageWindow(23, 23)).toEqual([1, 'gap', 22, 23]);
  });
});

describe('PaginationBar', () => {
  it('hides itself when everything fits on one page', () => {
    const { container } = render(
      <PaginationBar page={1} pageSize={25} total={10} onPageChange={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the range summary and fires onPageChange', () => {
    const onPageChange = vi.fn();
    render(<PaginationBar page={3} pageSize={25} total={563} onPageChange={onPageChange} />);
    expect(screen.getByText('Showing 51–75 of 563')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(onPageChange).toHaveBeenCalledWith(4);
    fireEvent.click(screen.getByRole('button', { name: /prev/i }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('disables Prev on page 1 and Next on the last page', () => {
    render(<PaginationBar page={1} pageSize={25} total={30} onPageChange={() => undefined} />);
    expect(screen.getByRole('button', { name: /prev/i })).toBeDisabled();
    render(<PaginationBar page={2} pageSize={25} total={30} onPageChange={() => undefined} />);
    expect(screen.getAllByRole('button', { name: /next/i }).at(-1)).toBeDisabled();
  });
});
```

Run: `pnpm --filter @vina/web test -- tests/components/ui/pagination-bar.test.tsx` — expected FAIL (module doesn't exist).

- [ ] **Step 2: Implement PaginationBar**

Create `packages/web/src/components/ui/pagination-bar.tsx`:

```tsx
import { Button } from './button.js';

/**
 * Which page numbers to render: current ±1, first, last, with 'gap'
 * markers where the sequence jumps. Exported for direct unit testing.
 */
export function pageWindow(page: number, totalPages: number): Array<number | 'gap'> {
  const wanted = [1, page - 1, page, page + 1, totalPages];
  const pages = [...new Set(wanted)]
    .filter((p) => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  let prev = 0;
  for (const p of pages) {
    if (p - prev > 1) out.push('gap');
    out.push(p);
    prev = p;
  }
  return out;
}

interface PaginationBarProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

/**
 * Numbered pagination with Prev/Next and a "Showing X–Y of N" summary.
 * Purely presentational; hidden entirely when one page holds everything.
 */
export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
}: PaginationBarProps): JSX.Element | null {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
      <span className="text-xs text-ink-muted">
        Showing {from}–{to} of {total}
      </span>
      <nav aria-label="Pagination" className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          ◀ Prev
        </Button>
        {pageWindow(page, totalPages).map((p, i) =>
          p === 'gap' ? (
            <span key={`gap-${i}`} aria-hidden className="px-1 text-ink-muted">
              …
            </span>
          ) : (
            <Button
              key={p}
              variant="ghost"
              size="sm"
              aria-current={p === page ? 'page' : undefined}
              className={p === page ? 'font-semibold text-ink-primary underline' : ''}
              onClick={() => onPageChange(p)}
            >
              {p}
            </Button>
          ),
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next ▶
        </Button>
      </nav>
    </div>
  );
}
```

Run the test again — expected PASS. (If `Button` doesn't accept `className`, check `packages/web/src/components/ui/button.tsx` — shadcn buttons merge it via `cn()`; adjust only if it truly doesn't.)

- [ ] **Step 3: Paged query hook**

In `packages/web/src/api/resources.ts`:

1. Add `total: number;` to `JobsListResponse` (~line 432).
2. Add `keepPreviousData` to the `@tanstack/react-query` import.
3. Replace the entire `useInfiniteJobs` function (~lines 464-515, including its doc comment) with:

```ts
/**
 * Classic paged jobs query for the numbered-pagination Jobs page.
 * `keepPreviousData` keeps the previous page's rows rendered while the next
 * page loads, so page flips don't flash an empty list. The 'jobs' key prefix
 * keeps the existing mutation invalidations (`['jobs']`) effective.
 */
export function useJobsPage(filters: JobsFilters): {
  items: Job[];
  total: number;
  isLoading: boolean;
} {
  const pageSize = filters.page_size ?? 25;
  const page = filters.page ?? 1;
  const qs = new URLSearchParams();
  if (filters.status) {
    qs.set(
      'status',
      Array.isArray(filters.status) ? filters.status.join(',') : filters.status,
    );
  }
  if (filters.min_score !== undefined) qs.set('min_score', String(filters.min_score));
  qs.set('page', String(page));
  qs.set('page_size', String(pageSize));

  const q = useQuery<JobsListResponse, Error>({
    queryKey: ['jobs', 'page', qs.toString()],
    queryFn: () => api<JobsListResponse>(`/api/jobs?${qs.toString()}`),
    placeholderData: keepPreviousData,
  });
  return {
    items: q.data?.items ?? [],
    total: q.data?.total ?? 0,
    isLoading: q.isLoading,
  };
}
```

4. `grep -rn useInfiniteJobs packages/web/src packages/web/tests` — the only hit should be `JobsPage.tsx` (fixed next step). If a test references it, update that test to `useJobsPage`.

- [ ] **Step 4: Rewire JobsPage**

In `packages/web/src/routes/jobs/JobsPage.tsx`:

1. Imports: swap `useInfiniteJobs` → `useJobsPage`; drop `useRef`; add `PaginationBar`:

```ts
import { useEffect, useState } from 'react';
import { PaginationBar } from '../../components/ui/pagination-bar.js';
```

2. Replace the hook call + sentinel block (lines ~44-68) with:

```ts
  const PAGE_SIZE = 25;
  const [page, setPage] = useState(1);
  // Filter changes re-anchor to page 1 — page 7 of a different filter set
  // is meaningless.
  useEffect(() => {
    setPage(1);
  }, [tab, minScore]);

  const jobs = useJobsPage({
    status: STATUS_FILTER_FOR_TAB[tab],
    ...(tab === 'new' && { min_score: minScore }),
    page,
    page_size: PAGE_SIZE,
  });
```

3. In the JSX: `jobs.pages.length === 0` → `jobs.items.length === 0`; `jobs.pages.map` → `jobs.items.map`; delete the sentinel `<li>` (lines ~204-215: the `sentinelRef` div, the `isFetchingNextPage` loader and the "End of list." paragraph). After the closing `</ul>`, add:

```tsx
      {!jobs.isLoading && (
        <PaginationBar
          page={page}
          pageSize={PAGE_SIZE}
          total={jobs.total}
          onPageChange={(p) => {
            setPage(p);
            window.scrollTo({ top: 0 });
          }}
        />
      )}
```

(Place it inside the outer `<section>` so it renders for every tab; it self-hides when `total <= PAGE_SIZE`.)

- [ ] **Step 5: Run web tests, typecheck, lint**

Run: `pnpm --filter @vina/web test` and `pnpm --filter @vina/web lint` (or `pnpm lint` at root)
Expected: ALL PASS; no unused-import or no-floating-promise errors. If any web test still imports `useInfiniteJobs`, it was missed in Step 3.4 — fix it.

- [ ] **Step 6: Commit**

```bash
git add packages/web
git commit -m "feat(web): numbered pagination on Jobs page, drop infinite scroll"
```

---

### Task 7: Full verification

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: all packages green. Playwright-fixture suites (automation, server search handler) are the slow ones — budget ~5 minutes.

- [ ] **Step 2: Lint + build**

Run: `pnpm lint && pnpm build`
Expected: clean.

- [ ] **Step 3: Verify the spec docs match reality**

Re-read the three edited sections of `docs/api-spec.md` / `docs/browser-automation.md` against the shipped code (`total` in jobs response, cancel semantics, session heuristics). Fix any drift in the same commit as the fix.

- [ ] **Step 4: Commit any doc drift fixes**

```bash
git add docs
git commit -m "docs: sync api-spec and browser-automation with shipped behaviour"
```

(Skip if nothing drifted.)
