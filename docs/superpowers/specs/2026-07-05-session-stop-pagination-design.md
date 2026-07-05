# Design: LinkedIn session-expiry detection, search Stop gaps, jobs-page pagination

Date: 2026-07-05
Status: approved (design discussed and accepted in session)

Three independent fixes/features, small enough to share one spec. Each section
lists motivation, behaviour, touched seams, and tests.

## 1. LinkedIn session-expiry detection (guest-page gap)

### Problem

When the persistent profile's LinkedIn session expires, LinkedIn does **not**
redirect to `/login`. It redirects `/feed` to the guest homepage and serves
`/jobs/search/` as the public "jserp" guest page (authwall modal, different
DOM, `public_jobs_*` tracking attributes). The adapter's
`onSessionExpired` only checks `pathname.startsWith('/login')`
(`packages/automation/src/adapters/linkedin/index.ts:257-259`), so the search
runs against the guest DOM, every authenticated selector matches zero
elements, LLM selector recovery burns calls and fails, and the user sees a
misleading "Search returned 0 listings" alert instead of "session expired".

### Behaviour

1. **Pre-flight assertion.** `runBrowserSearch`
   (`packages/server/src/queue/handlers/search.ts:267-271`) navigates to the
   feed URL, then throws `LinkedInSessionExpiredError` when
   `adapter.onSessionExpired(page)` is true **or**
   `adapter.onLoginSuccess(page)` is false. Logged-out browsers never land on
   `/feed`, so this catches expiry before any search work. (LinkedIn is the
   only browser adapter today; `onLoginSuccess` is already part of the
   `SiteAdapter` contract, `packages/automation/src/adapters/adapter.ts`.)
2. **Guest-page markers.** LinkedIn's `onSessionExpired` additionally returns
   true when the current page shows logged-out markers:
   - URL path `/authwall` or `/uas/login` (in addition to `/login`), or
   - the DOM contains `[data-tracking-control-name^="public_jobs_"]`
     elements — markup that only exists on the guest experience.
   Implemented via the existing heuristics helper
   (`packages/automation/src/detect/session.ts`), not ad-hoc page evals.
3. **Zero-listings path ordering.** In the search handler, when extraction
   yields zero listings, check `adapter.onSessionExpired(page)` **before**
   attempting cached/LLM selector recovery. Expired session → throw
   `LinkedInSessionExpiredError`; the existing catch already inserts the
   `linkedin_session_expired` alert and emits the event.

### Not in scope

Auto re-login, cookie refresh, or changes to the Google Jobs (SerpAPI) path.

### Tests

- New guest-SERP HTML fixture under `tests/fixtures/sites/linkedin/`
  (trimmed real guest page: authwall modal + `public_jobs_*` card anchors).
- Adapter unit tests: `onSessionExpired` true on guest SERP fixture and on
  `/authwall`; false on authenticated SRP fixture.
- Search-handler unit test: zero-listings + guest page → task fails with
  `LinkedInSessionExpiredError` and inserts the session alert, and the LLM
  selector resolver is **not** called.
- Pre-flight test: feed navigation landing off-`/feed` throws.

## 2. Search Stop — close the gaps

### Problem

`POST /api/searches/cancel` only aborts **actively running** tasks via the
in-memory `active-tasks` registry (`packages/server/src/http/routes/searches.ts:64-72`).
A search sitting in retry backoff (status `pending`, `attempts > 0`) has no
registry entry, so cancel is a no-op for it. In the UI the Stop button only
renders during the `discovering` phase
(`packages/web/src/components/search/SearchActivityPanel.tsx:101`), so a
retrying or slow-starting search shows no way to stop.

### Behaviour

1. **Server.** The cancel route, for `task_id`, aborts the active task (as
   today) **and** flips the task row via the existing repository `cancel()`
   (`packages/server/src/db/repositories/task-queue.ts:125`, idempotent,
   pending/running → `cancelled`, reason `cancelled_by_user`). For `site_id`,
   it does the same for every pending/running search task of that site.
   `cancelled` count = rows flipped (in-memory abort of an already-flipped row
   doesn't double-count).
2. **Web.** Stop button shows whenever the panel is tracking an in-flight
   search task (any non-terminal phase, including retry/backoff), not just
   `discovering`. Terminal = completed / cancelled / failed-final.
3. **Scope choice.** Scoring tasks spawned by a search are *not* cancelled —
   explicit user decision ("fix current gaps only").

### Tests

- Route unit tests: cancel of a pending (retry-backoff) task flips row to
  `cancelled` and the worker never runs it; cancel by `site_id` sweeps both
  pending and running search rows; double-cancel stays idempotent.
- Panel test (if component tests exist for it): Stop visible during
  non-terminal phases, hidden after terminal event.

## 3. Jobs page: pagination instead of infinite scroll

### Problem / decision

`JobsPage` uses `useInfiniteQuery` + an IntersectionObserver sentinel
(`packages/web/src/routes/jobs/JobsPage.tsx:44-68`). User wants classic
numbered pagination. `JobsPage`/`JobCard` themselves are kept — only the
fetching and list-footer mechanics change.

### Behaviour

1. **Server.** `GET /api/jobs` response gains `total`: a `COUNT(*)` using the
   same WHERE filters (status, min_score) as the item query. Response:
   `{ items, page, page_size, total }`. `docs/api-spec.md` is corrected in
   the same change (it documents `limit`/`cursor`, which was never built).
2. **Web.**
   - Replace `useInfiniteJobs` with a paged `useJobs(params)` query
     (TanStack `useQuery`, `placeholderData: keepPreviousData` so page flips
     don't flash empty).
   - New reusable `PaginationBar` component in `packages/web/src/components/ui/`:
     Prev/Next, numbered pages with ellipsis (window around current page,
     first/last always visible), "Showing X–Y of N". Pure props
     (`page`, `pageSize`, `total`, `onPageChange`), no data awareness.
   - `JobsPage`: local `page` state; filter changes (status tab, min-score)
     reset to page 1; page size 10 (user decision 2026-07-05, was 25);
     sentinel/IntersectionObserver code removed. Scroll to top of the list
     on page change.
   - `useInfiniteJobs` is deleted (JobsPage is its only consumer).

### Tests

- Route unit test: `total` reflects filters, independent of `page`/`page_size`.
- `PaginationBar` unit tests: windowing/ellipsis maths, boundary pages,
  single-page hides controls.
- JobsPage test (if page-level tests exist): filter change resets page.

## Sequencing

Three independent changes; implement and commit per section:
1. `fix(automation,server)` session-expiry guest-page detection
2. `fix(server,web)` search cancel covers retry-backoff; Stop button lifecycle
3. `feat(server,web)` jobs pagination + `total`

Specs to keep in sync: `docs/api-spec.md` (jobs response, cancel semantics),
`docs/browser-automation.md` (session heuristics note).
