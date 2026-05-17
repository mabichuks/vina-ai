# Multi-Source Search Controls + Settings UX Fixes — Design

**Status:** Implemented (2026-05-16).
**Date:** 2026-05-16.
**Scope:** Fix the LinkedIn-coupling bugs surfaced after Google Jobs landed (Phase A), plus add user-requested controls: a Stop button for in-flight searches and per-source active/inactive toggles. Reuses the LinkedIn-slice scaffolding (queue, schedule failure tracking, search progress store) and the Phase A Google Jobs surface; the changes are surgical to the surfaces that couple to a single source.

This slice is a follow-up to Phase A (Google Jobs). It assumes both LinkedIn (browser-kind) and Google Jobs (api-kind) sources are live.

---

## 1. Goal & Scope

### 1.1 Goal

Make Vina behave correctly when the user has more than one source configured (or only one of two configured). Specifically: the UI must reflect each source's true state, Search Now must respect whichever sources are active, the user can pause/resume a source without disconnecting credentials, and the user can stop a search mid-flight without losing the work already done.

### 1.2 What ships

1. **`/api/sites` exposes `has_credentials: boolean`** per row — `true` when a Playwright session is on disk (browser-kind) or a SerpAPI key is stored (api-kind). Computed server-side; no schema change.
2. **Generic `useSiteStatus(id)` web hook** that returns `{ state, enabled, has_credentials, last_search_at }` where `state ∈ 'not_configured' | 'active' | 'paused' | 'key_invalid' | 'quota_exhausted' | 'session_expired'`. The existing `useGoogleJobsStatus` and `useLinkedInStatus` keep their public names as thin wrappers; the projection logic lives in one place.
3. **Per-source active/inactive toggle.** Switch in Settings → Sites for each row, bound to `PATCH /api/sites/:id { enabled }`. Disabling pauses both scheduled and manual searches without clearing credentials.
4. **Multi-source-aware Search Now.** The button is enabled when **any** source is `active && has_credentials`. With exactly one active source, clicking searches it. With two, the button becomes a dropdown: `Search both / Search LinkedIn / Search Google Jobs`. Both fan-outs enqueue one `search` task per chosen site.
5. **Stop button** during in-flight searches. Server tracks `taskId → AbortController` in memory; `POST /api/searches/cancel { task_id? | site_id? }` aborts. The search handler honours the signal — already-discovered jobs and queued score tasks are preserved (score continues on its own queue).
6. **Settings UX bug fixes:**
   - **B1**: `useSiteStatus` reads `has_credentials` instead of `enabled` for the active-state check. Disconnects propagate visibly.
   - **B2**: The inline edit-key form auto-closes when the underlying site transitions to `not_configured` (e.g., Disconnect succeeded). A `useEffect` watches state and resets `editing` / `key` / `error`.
   - **B3**: The `useValidateSerpapiKey` mutation guards against `key === ''` and `key === undefined` (throws synchronously rather than firing a degenerate POST). The route still defends against empty `body` defensively but the hook is the primary fence.
   - **B4**: `SearchNowButton` enable check + click handler updated per (4).

### 1.3 Deferred

- **Per-source score thresholds.** Out of scope. One shared threshold.
- **Cancel mid-score.** Stop button cancels in-flight `search` only; `score` tasks already running finish. (Score is per-job and short; not worth complexity.)
- **Stop button accessible from CLI.** UI-only for now; `vina` CLI doesn't grow a `vina search cancel` subcommand.
- **Exposing SerpAPI `maxPages` cap to users.** The 60-listings-per-tick default ships unchanged. A "Max results per search" preference is queued for a later polish slice.
- **Generalizing other LinkedIn-coupled surfaces** (JobsPage tab counts, Dashboard tile copy) — handled opportunistically in this slice when touched but not the goal.

### 1.4 Out of scope

- Indeed (ADR-019, still skipped).
- Phase B (manual-apply pipeline) and Phase C (auto-apply form-walker) — separate slices.

---

## 2. Architecture & Data Flow

### 2.1 `has_credentials` derivation

`/api/sites` already returns `enabled` and `has_session`. Add `has_credentials`:

```ts
listSites(db).map((s) => ({
  id: s.id,
  display_name: s.display_name,
  kind: s.kind,
  enabled: s.enabled,
  has_session: s.session_path !== null,
  has_credentials:
    s.kind === 'browser' ? s.session_path !== null :
    s.kind === 'api'     ? hasSerpApiKey(db) :
    false,
  session_valid_at: s.session_valid_at,
  last_search_at: s.last_search_at,
}))
```

Note: this calls `hasSerpApiKey(db)` once per row but only the google row uses the result. Cheap. If profiling shows it matters later, hoist outside the map.

### 2.2 `useSiteStatus(id)` projection

```ts
type SiteState =
  | 'not_configured'   // !has_credentials
  | 'paused'           // has_credentials && !enabled
  | 'active'           // has_credentials && enabled && no degraded alerts
  | 'key_invalid'      // api-kind only, derived from open alert
  | 'quota_exhausted'  // api-kind only, derived from open alert
  | 'session_expired'; // browser-kind only, derived from open alert

interface SiteStatusData {
  state: SiteState;
  enabled: boolean;
  has_credentials: boolean;
  last_search_at: string | null;
}
```

Precedence: degraded alerts beat normal states (`key_invalid > quota_exhausted > session_expired > active > paused > not_configured`).

`useGoogleJobsStatus(opts)` → wraps `useSiteStatus('google', opts)`, narrows `state` to api-kind values.
`useLinkedInStatus(opts)` → wraps `useSiteStatus('linkedin', opts)`, narrows to browser-kind. Backwards-compatible for existing callers; the LinkedIn hook also keeps its custom polling behaviour for the connect-attempt flow.

### 2.3 Per-source enable toggle

UI: a `<Switch>` to the right of each Sites row, between the state label and the action buttons.
- ON when `enabled=true`.
- OFF when `enabled=false`.
- Disabled when `has_credentials=false` (toggling makes no sense without creds).
- Tooltip on the disabled state: "Connect first."

Binding: existing `PATCH /api/sites/:id { enabled: true|false }` route. Optimistic update with React Query.

Scheduler already filters on `sites.enabled` (verify in implementation — touch `scheduler/scheduler.ts` only if it doesn't).

`POST /api/searches/run-now` (manual fan-out) must also honour `enabled`. Verify: the existing handler enqueues a task for whatever `site_id` is given. The fan-out logic moves to the SearchNowButton — it only sends requests for `enabled && has_credentials` sites.

### 2.4 Search Now redesign

The button at `packages/web/src/components/search/SearchNowButton.tsx` becomes:

```ts
const sites = useSites().data;
const linkedinStatus = useLinkedInStatus({ pollMs: 5_000 });
const googleStatus = useGoogleJobsStatus({ pollMs: 5_000 });

const activeSites = [
  linkedinStatus.data?.state === 'active' ? 'linkedin' : null,
  googleStatus.data?.state === 'active'   ? 'google'   : null,
].filter(Boolean) as ('linkedin' | 'google')[];

const inFlight = phase === 'discovering' || phase === 'scoring' || runNow.isPending;
const disabled = activeSites.length === 0 || inFlight;
```

Click behaviour:
- **0 active sites** → button disabled (with tooltip: "No source configured & active").
- **1 active site** → click enqueues `POST /api/searches/run-now { site_id }` for that one site.
- **2 active sites** → click opens a dropdown menu:
  - `Search both` (default, focused)
  - `Search LinkedIn only`
  - `Search Google Jobs only`

  The dropdown enqueues either one or two `search` tasks. The search progress store already supports merging concurrent phases (verify; if not, extend it).

Existing label morphing (`Sussing… (3 found)` etc.) stays — the gerund hook is unchanged.

### 2.5 Stop button + cancellation

**Server side:**

New `packages/server/src/queue/active-tasks.ts`:

```ts
const activeTasks = new Map<string, { signal: AbortSignal; abort: () => void; site_id: string }>();

export function registerActiveTask(taskId: string, site_id: string): AbortSignal {
  const ac = new AbortController();
  activeTasks.set(taskId, { signal: ac.signal, abort: () => ac.abort(), site_id });
  return ac.signal;
}
export function unregisterActiveTask(taskId: string): void { activeTasks.delete(taskId); }
export function cancelActiveTask(taskId: string): boolean {
  const entry = activeTasks.get(taskId);
  if (!entry) return false;
  entry.abort();
  return true;
}
export function cancelTasksForSite(site_id: string): number {
  let n = 0;
  for (const [id, entry] of activeTasks) if (entry.site_id === site_id) { entry.abort(); n++; }
  return n;
}
```

The queue worker, when it picks up a `search` task, calls `registerActiveTask(task.id, payload.site_id)` and passes the returned signal into the search handler. `unregisterActiveTask` runs in a `finally` block.

**Search handler change.** Both `runApiSearch` and `runBrowserSearch` accept an `AbortSignal` param and pass it into `searchGoogleJobs` / `linkedInAdapter.search`. The iterators already honour the signal — the abort path was tested in Task 3 (`'aborts mid-pagination when signal is triggered'`).

**On abort:** the iterator returns cleanly mid-loop. Already-inserted jobs stay. Already-enqueued score tasks stay (they're on the `score` queue, untouched by search cancellation). The search task status flips to `cancelled` (new task_queue status enum value — see §2.6). `bus.emit('search:cancelled', { task_id, site_id, listings_added, scored })` for the UI.

**HTTP route:** `POST /api/searches/cancel` with body `{ task_id?: string; site_id?: string }`. If `task_id` provided, cancel that one. If `site_id` provided, cancel all active tasks for that site (typically there's at most one per site due to queue concurrency). Returns `{ cancelled: number }`. 200 always; absence of a matching task is not an error.

**WS event:** `search:cancelled` joins the existing `search:*` taxonomy.

### 2.6 Schema change: task_queue status

The `task_queue.status` CHECK constraint currently allows `'pending', 'running', 'completed', 'failed', 'cancelled'` per `docs/database-schema.md`. Verify in code — if `'cancelled'` isn't already in the SQL CHECK, that's a forward-only migration `004_task_queue_cancelled.sql`. Adapt at implementation time.

If the constraint already allows `'cancelled'`, no migration needed.

### 2.7 Stop button UI

In the existing search-progress region (where the Stop is needed during `discovering` / `scoring` phases), add a small `Stop` button to the right of the morphing label. Renders only when `phase === 'discovering'`. Clicking POSTs to `/api/searches/cancel` with the most recent in-flight task_id (the progress store needs to track it — extend `useSearchProgressStore` with `currentTaskId?: string`).

Mid-`scoring`, the search has already completed; there's nothing to cancel. The Stop button hides.

---

## 3. Bug Fixes

### 3.1 B1 — Settings tile state derives from `has_credentials`

After §2.1 lands, `useSiteStatus` uses `has_credentials` instead of `enabled` for the not-configured check. State precedence:

- `!has_credentials` → `not_configured`
- `has_credentials && !enabled` → `paused`
- `has_credentials && enabled` → `active` (or one of the degraded states)

This makes Disconnect's effect visible: clearing credentials flips `has_credentials` to `false`, state becomes `not_configured`, the buttons swap to "Add SerpAPI key" / "Connect LinkedIn".

### 3.2 B2 — Edit-key form auto-closes on state change

In `GoogleJobsRow` (and any equivalent LinkedIn edit-form) add:

```ts
useEffect(() => {
  if (state === 'not_configured') {
    setEditing(false);
    setKey('');
    setError(null);
  }
}, [state]);
```

So Disconnect succeeds → state → `not_configured` → form closes → user sees the clean state without manually clicking Cancel.

### 3.3 B3 — Validate hook guards against empty key

In `useValidateSerpapiKey`:

```ts
mutationFn: (key) => {
  if (typeof key !== 'string' || key.trim().length === 0) {
    return Promise.resolve({ ok: false as const, reason: 'empty_key' as const, detail: 'Key is required' });
  }
  return api<SerpapiValidateResult>('/api/sites/google/test', { method: 'POST', body: { key } });
}
```

Add `'empty_key'` to `SerpapiValidateResult.reason`. The Settings tile's error renderer already shows `res.reason ?? res.detail`. The route's `no_key_configured` path stays as a server-side defense for direct API callers, but the hook fence prevents the cascade in normal UI flow.

### 3.4 B4 — Search Now multi-source

See §2.4. The button no longer hard-codes `linkedin`.

---

## 4. Server Endpoints

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| GET | `/api/sites` | — | `SiteResponse[]` with new `has_credentials` field | Existing route extended |
| POST | `/api/searches/cancel` | `{ task_id?: string; site_id?: string }` | `{ cancelled: number }` | New |
| POST | `/api/searches/run-now` | `{ site_id }` | existing shape | Unchanged signature, but multi-source caller fans out |

No new tables. No new alerts. Possibly migration 004 if `task_queue.status` CHECK doesn't already include `'cancelled'` — verify.

---

## 5. UX Details

### 5.1 Settings → Sites tile (after the slice)

```
┌──────────────────────────────────────────────────────────────────┐
│ Sites                                                            │
├──────────────────────────────────────────────────────────────────┤
│ LinkedIn                                                         │
│ ● Active · last search 14m ago         [ON]  [Edit] [Disconnect] │
├──────────────────────────────────────────────────────────────────┤
│ Google Jobs                                                      │
│ ⊘ Paused (credentials saved)           [OFF] [Edit] [Disconnect] │
└──────────────────────────────────────────────────────────────────┘
```

- **Toggle switch** (ON/OFF) reflects `enabled`.
- **State label** reflects derived `state`. Paused = "⊘ Paused (credentials saved)". Not configured = "○ Not configured" (with "Add SerpAPI key" CTA, no toggle).
- **Action buttons** condition on state per Phase A; toggle is independent.

### 5.2 Dashboard / JobsPage Search Now

- **Disabled** with tooltip `"No source configured & active"` when `activeSites.length === 0`.
- **Single button** "Search now" when exactly one source is active. Same morphing labels.
- **Dropdown** when both active: primary button labelled "Search now" with a chevron; dropdown items: "Search both" (default) / "Search LinkedIn" / "Search Google Jobs". After click, the dropdown closes and the morphing label takes over.

### 5.3 Stop button

Appears during `phase === 'discovering'` only. Tertiary style (small, ghost variant). Clicking → POST cancel → button hides immediately (optimistic) → `search:cancelled` event arrives → progress store flips to `done` with whatever counts had been recorded.

If the user cancels during the discovering phase but score tasks were already enqueued for some discovered jobs, the score worker keeps running — the user sees the score count climb under a "Done · cancelled · 3 scored" label.

---

## 6. Edge Cases

- **Concurrent searches on the same site.** Per-site concurrency = 1 stays; cancelling cancels the one in flight.
- **Cancel race.** If cancel arrives just as the search finishes, `cancelActiveTask` returns false (task already done). No error.
- **Re-enable a paused source.** Toggle ON → next scheduler tick picks it up. Manual Search Now picks it up immediately.
- **All sources paused.** Search Now disabled. Scheduler ticks find no enabled sites, log "no active sources", emit no tasks.
- **Disconnect while a search is running for that site.** Disconnect API clears credentials; in-flight task likely fails on next page fetch (key gone) → emits the appropriate alert. The user sees both Disconnect and the failure alert; acceptable.
- **Validate hook called with empty key (B3).** Resolves locally with `{ ok: false, reason: 'empty_key' }`. No network call. UI shows "Key is required".

---

## 7. Recorded Decisions

| # | Question | Answer |
|---|---|---|
| Q1 | Should `enabled` mean "active" or "has credentials"? | **Active.** `has_credentials` is computed separately. Splits user intent (toggle) from technical state (credential presence). |
| Q2 | Per-source toggle: switch UI? | **Switch** (binary), not a dropdown. Faster pause/resume. |
| Q3 | Search Now with 2 active sources: button or dropdown? | **Dropdown** with "Search both" as default. Lets users target one source without disabling the other. |
| Q4 | Cancel granularity: per-task or per-site? | **Per-task and per-site.** Per-site is the common UI case (only one in-flight per site); per-task is precise. |
| Q5 | Should cancel kill score tasks too? | **No.** Score is independent and short-lived. Cancel only stops discovery. |
| Q6 | Expose SerpAPI `maxPages` in Settings? | **Deferred.** 60-listings default ships. |
| Q7 | New WS event for cancel? | **Yes** — `search:cancelled` joins the `search:*` taxonomy. |
| Q8 | Bug 3's root cause beyond the hook fence? | **Stale React state during Disconnect-then-immediate-Save flow.** The auto-close effect (B2) prevents the bad state from being reachable. The hook fence (B3) is belt-and-braces. |

---

## 8. Explicitly NOT in this slice

- Indeed.
- Phase B (manual-apply pipeline) work.
- Phase C (auto-apply form-walker).
- CLI cancel command.
- Per-source score threshold.
- Cross-source job dedup.
- "Re-score all" trigger after settings change.

---

## 9. Success Criteria

- Settings → Sites: when the user disconnects Google Jobs, the row visibly transitions to "Not configured" within 1 tick of React Query refetch (≤2s). The inline form (if open) auto-closes.
- Per-source toggle: flipping LinkedIn to OFF prevents the next scheduler tick from enqueuing a LinkedIn search. Flipping back to ON resumes. Confirmed via test seam.
- Multi-source Search Now: with both sources active, the dropdown shows three options. Clicking "Search both" enqueues one task per site. Clicking "Search LinkedIn only" enqueues one task with `site_id='linkedin'`.
- Stop: during a `searchGoogleJobs` iteration (3-page fixture), POSTing cancel mid-iteration causes the iterator to return after the next listing. Already-discovered listings stay. Score tasks for those listings continue.
- B1: with no SerpAPI key stored, `useSiteStatus('google').data?.state` is `'not_configured'` regardless of `enabled`'s value.
- B2: triggering Disconnect with the edit-key form open auto-closes the form.
- B3: clicking Save with an empty key resolves locally — no network call — error reads "Key is required".
- B4: Search Now button is enabled iff any source is active+has_credentials; disabled with the right tooltip otherwise.

---

## 10. Implementation order (high level)

1. Phase 1 — Server `/api/sites` response + (if needed) migration 004.
2. Phase 2 — Shared types and `useSiteStatus`.
3. Phase 3 — `useGoogleJobsStatus` / `useLinkedInStatus` rewritten on top.
4. Phase 4 — Settings tile per-source toggle + auto-close form (B1, B2).
5. Phase 5 — Validate hook fence (B3).
6. Phase 6 — Server cancel route + active-tasks map + handler signal threading.
7. Phase 7 — Search Now multi-source + dropdown + cancel button + progress-store `currentTaskId` (B4 + stop).
8. Phase 8 — Integration test for cancel (extend the existing Google Jobs e2e).
9. Phase 9 — Final verification.

Detailed task breakdown lives in `docs/superpowers/plans/2026-05-16-multi-source-search-controls.md`.
