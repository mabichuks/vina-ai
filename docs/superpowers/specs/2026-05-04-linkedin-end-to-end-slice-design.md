# LinkedIn End-to-End Slice — Design

**Status:** Brainstorm-approved · awaiting plan
**Date:** 2026-05-04
**Scope:** First product-shippable cut. Real LinkedIn search pipeline + UI flow, with CV/cover-letter tailoring, auto-apply form-walker, Indeed, and Google Jobs all deferred.

---

## 1. Goal & Scope

### 1.1 Goal

Ship a working LinkedIn-only job-search loop. The user logs into LinkedIn through Vina once, sets preferences + uploads CV + adds an LLM key, then sees scored job listings flow into the UI on a schedule and on demand. They open jobs in their browser, apply on LinkedIn (Easy Apply) or the external ATS, and mark the result back in Vina.

### 1.2 What ships

1. **LinkedIn login flow** — browser-driven via `BrowserManager` + `linkedInAdapter`. Persistent profile per ADR-013/ADR-018.
2. **Real LinkedIn search worker** — replaces the M10 stub. Uses `linkedInAdapter.search` + `openListing` + `detectApplyMethod` against real LinkedIn (and against the existing fixture in tests).
3. **LLM scoring per job** — existing `runScoreJob` graph + `score` queue handler are already built; just need to be triggered by real search results, with the user's CV folded into the score input (see §4.5).
4. **Jobs page** — filtered to `match_score >= score_threshold` by default; status tabs (New / Applied / Skipped); smart-link Apply per Q3 (Easy Apply → LinkedIn detail; External → captured external URL); score + apply-method badges.
5. **`Search now` button** + scheduler ticks — both enqueue the same `{ kind: 'search', payload: { site_id: 'linkedin' } }` task.
6. **Mark-applied / Skip endpoints + UI** — optimistic updates with toast-undo. Reopen action on Applied / Skipped tabs.
7. **Session-expired handling** — Alerts page surface + Settings reconnect. Scheduler auto-pauses after 3 consecutive failures. `Search now` disabled while expired.
8. **WebSocket-driven live updates** — `jobs:updated`, `search:*`, `linkedin:session-expired`, `alerts:new`.

### 1.3 Deferred — code stays in tree, dormant

- **CV tailoring** (`cv-service.ts` and any associated handler) — left as-is, not invoked. CV gets uploaded by the wizard CV step and used as scoring context only.
- **Cover-letter tailoring** (`cover-letter-service.ts`) — code stays. The wizard `CoverLetter` step is removed from the wizard route order (file unchanged).
- **Auto-apply form-walker (M15)** — the `SiteAdapter` interface already excludes form-walker methods (per Bucket 1 design); no change needed.
- **Profile-answers chatbot** — `/chat` route stays in the router but is hidden from the sidebar.

### 1.4 Hidden / removed from UI

- **`/ready` route** — removed from router and nav. Visiting `/ready` redirects to `/jobs`.
- **Wizard `Sources` step** — unrouted in the wizard's step order. File unchanged. Settings → Sites tile carries the multi-source surface (see §3.4) with Indeed / Google as "Coming soon".
- **Wizard `Mode` step** — autonomy/approval modes are auto-apply concepts. Unrouted in the wizard. Sensible defaults set in DB at install time.
- **Wizard `CoverLetter` step** — see §1.3.

---

## 2. Architecture & Data Flow

### 2.1 Pipeline

```
Wizard ─→ Connect LinkedIn (headed Chromium → polls onLoginSuccess → cookies persisted)

Schedule cron tick   ┐
                     ├── enqueue { kind: 'search', payload: { site_id: 'linkedin' } }
"Search now" button  ┘                              │
                                                    ▼
                                       search worker (concurrency=1 per site_id)
                                                    │
                          for each card on results page:
                            insertJob(rawListing)
                            openListing → fill description, salary_text
                            detectApplyMethod → fill apply_method, external_apply_url
                            enqueue 'score' task
                            emit WS jobs:updated
                                                    │
                                                    ▼
                                       score worker (parallel, capped by provider rate-limit)
                                                    │
                          runScoreJob(input + CV) → updateJobScore + status='scored'
                          emit WS jobs:updated
                                                    │
                                                    ▼
                                       UI: Jobs page updates live
                                                    │
                          user clicks Apply → smart link (LinkedIn detail or external URL)
                          user clicks Mark applied / Skip → POST /jobs/:id/{applied,skip,scored}
                          emit WS jobs:updated
```

### 2.2 Status flow

`created` → `scored` → `applied` | `skipped`

The slice treats `scored` as the worklist state. Existing schema enums (`cv_tailored`, `cv_approved`, `submitted`, `prepare_manual_apply`, etc.) stay valid in the schema but aren't reachable from this slice's code paths. M14/M15 will reactivate them.

### 2.3 Worker concurrency

- **`search` kind:** serialised to **1 in-flight task per `site_id`**. LinkedIn cookies and the persistent context can't be shared across concurrent searches. Implemented via the M10 queue's per-kind concurrency primitives.
- **`score` kind:** parallel, capped by a small constant (e.g. 4). LLM calls are independent and the provider's rate-limit is the operative bound.

---

## 3. Onboarding & Login

### 3.1 Wizard step order (8 steps)

1. Welcome
2. Profile (`full_name`, `bio`)
3. CV upload (PDF or paste; text extracted server-side via existing `extract-text.ts`)
4. LLM Provider (Anthropic / OpenAI / Ollama key + model)
5. Preferences (keywords, locations, work_models, seniority, `score_threshold`)
6. Schedule (cron cadence)
7. **Connect LinkedIn** ← new step
8. Done

### 3.2 Hidden steps

`Sources`, `Mode`, `CoverLetter` files are unchanged but excluded from the wizard's step order array.

### 3.3 Connect LinkedIn step — UX states

| State | UI | Server action |
|---|---|---|
| **Initial** | Title + 2-sentence explanation. Primary `Connect LinkedIn` button. **No skip.** | — |
| **Launching** | Disabled button + spinner. | `POST /sites/linkedin/connect` → BrowserManager launches headed Chromium → returns `{ attempting: true }` |
| **Waiting for login** | Spinner + "Log in to LinkedIn in the window we just opened. Vina will continue automatically once you're signed in." + secondary cancel link. | UI polls `GET /sites/linkedin/status` every ~1.5s; server polls `linkedInAdapter.onLoginSuccess(page)` against the actual Page object. |
| **Browser closed prematurely** | Reverts to Initial + "Looks like the window was closed. Try again." | Server detects context closed → flips `{ attempting: false }`. |
| **Timed out (5 min)** | "Login is taking longer than expected." Primary `Try again`. Secondary warned `Skip for now` (with banner explaining no jobs will arrive). | Server kills the attempt; profile dir is left untouched (the existing session may still be partially valid). |
| **Connected** | ✅ "Connected to LinkedIn." Auto-advances after ~1s. | Server stores connection metadata; cookies are already persisted in the profile dir. |

Headed Chromium is required (user must interact with LinkedIn). Polling continues through challenges (captcha, "verify it's you") for the duration of the timeout window — most resolve to `/feed` once the user completes them.

### 3.4 Settings → Sites tile

Existing surface, repurposed:

- One row per site. Status icon: `● Connected` / `○ Not connected` / `⚠ Session expired`.
- **LinkedIn** — live status from `GET /sites/linkedin/status`. `Reconnect` button reuses `POST /sites/linkedin/connect`. `Disconnect` button (`DELETE /sites/linkedin`) wipes the persistent profile dir (used when the user logged in with the wrong account).
- **Indeed**, **Google Jobs** — `Coming soon` chip, disabled.

### 3.5 Reconnect from Alert

When the worker fires `Alert(kind='linkedin_session_expired')`, the alert card on the Alerts page links to `/settings#sites` and visually highlights the LinkedIn row.

### 3.6 Server endpoints introduced

- `POST /sites/linkedin/connect` — start auth attempt. Idempotent: returns the in-flight attempt's status if one already exists.
- `GET /sites/linkedin/status` — `{ connected, attempting, last_success_at, error }`.
- `DELETE /sites/linkedin/connect` — cancel current attempt (used by wizard cancel link).
- `DELETE /sites/linkedin` — disconnect (wipe profile dir).

---

## 4. Search & Score Pipeline (Server)

### 4.1 Replacing the M10 stub

`packages/server/src/queue/handlers/search.ts` currently synthesises a fake job. The slice replaces the body with the real LinkedIn flow:

```
1. Pull 'search' task; payload { site_id: 'linkedin' }
2. BrowserManager.getContext('linkedin') → persistent context (cached)
3. Open new Page; navigate to https://www.linkedin.com/feed
4. await linkedInAdapter.onSessionExpired(page)
     true → throw LinkedInSessionExpiredError (handled per §4.3)
5. for await (const rawListing of linkedInAdapter.search(page, prefs, signal)):
     try:
       const job = insertJob({ site_id, ...rawListing, status: 'created' })
       const detail = await linkedInAdapter.openListing(page, rawListing)
       const apply  = await linkedInAdapter.detectApplyMethod(page, rawListing)
       updateJobDetail(job.id, {
         description, salary_text, apply_method, external_apply_url
       })
       enqueue('score', { job_id: job.id })
       bus.emit('jobs:updated', { ids: [job.id] })
     catch err:
       log.warn(err); continue   // per-listing skip; whole task does NOT fail
6. Close page (BrowserManager keeps the context cached for the next task)
```

### 4.2 SearchPreferences

Read at task start (not at schedule-creation), so user preference edits take effect on the next tick. Already a property of `getOrInitSearchPreferences` returning the row by `id='default'`.

### 4.3 Error paths

| Failure | Handling |
|---|---|
| **Session expired (start of task)** | `onSessionExpired() === true` before search. Throw `LinkedInSessionExpiredError`. Queue marks task failed. Emit `Alert(kind='linkedin_session_expired')`. Increment `consecutive_failures` on the schedule row. **3 strikes → `paused=true`** on the schedule. Emit WS `linkedin:session-expired`. UI disables `Search now` and shows banner. |
| **Session expired mid-search** | Iterator throws. Same path as above. Already-inserted listings stay (best-effort). |
| **Single-listing extraction failure** (selector drift, network blip on a detail page) | Per-listing try/catch. Skip + warn. **No alert** (single listing isn't worth a notification). Job is either skipped entirely or persisted with partial data and dropped from later UI by the threshold filter. |
| **Whole-page fetch failure** (network down, captcha mid-search, Playwright timeout, unanticipated exception) | Task fails. `Alert(kind='search_failed')` with the error message. Schedule failure counter increments — 3 strikes pauses schedule. |
| **Score task failure** (LLM provider down, malformed model output past `runScoreJob`'s internal retry) | Queue retries score task **3× with exponential backoff**. If still failing, `Alert(kind='score_failed')`. Job stays `status='created'`, `match_score=NULL`, invisible to the Jobs page (which filters to threshold). Accepted limitation for the slice; "needs attention" view is a follow-up. |

### 4.4 Concurrency rules

- `search` kind: 1 in-flight task per `site_id`. M10 queue's per-kind concurrency primitives.
- `score` kind: parallel; cap = 4 (small constant, easy to tune).

### 4.5 CV in score input

The existing `score` handler reads `profile.full_name` and `profile.bio` only. The slice adds the user's uploaded CV to the prompt:

- **Decision (implementation-time):** add a `cv_text` field to `ScoreInput` rather than concatenating into `bio`. Keeps the score prompt clean and allows future tailoring graphs to read `cv_text` independently.
- The CV row in the `cvs` table already has `text_content` (or equivalent — verify exact column name when implementing) populated by `extract-text.ts` at upload time. Score handler reads the active CV (`cvs.is_active = 1` or similar; verify) and folds it into `ScoreInput.cv_text`.
- Score prompt template (in `packages/orchestrator/src/prompts/score.ts`) gets a small edit to reference `cv_text` after `profile`.

### 4.6 Schema changes

Suspected, to verify before plan-writing:

- `schedules` table needs `consecutive_failures: INTEGER NOT NULL DEFAULT 0` and `paused: INTEGER NOT NULL DEFAULT 0` (boolean). If absent, add a forward-only migration `00X_schedule_failure_tracking.sql`.
- `jobs.match_justification: TEXT NULLABLE` — referenced by the existing score handler, should already exist. Verify.
- `alerts` table — verify the `kind` enum values include `linkedin_session_expired`, `search_failed`, `score_failed`, `schedule_paused`, `provider_failed`. If using a CHECK constraint, widen.

Net: probably 0 or 1 small migration.

---

## 5. Jobs Page UX

### 5.1 Page header

- Title: `Jobs`
- Right side: `Search now` button (primary).
  - Disabled with tooltip "Reconnect LinkedIn first" when session is expired.
  - While a search task is in-flight, label changes to "Searching…" with a spinner.
- Subtitle line below header: `Last search: 12 min ago • 23 new jobs scored` (relative time + summary, updates live).

### 5.2 Status tabs

Tabs left-aligned under header:

- **New** (default) — `status='scored' AND match_score >= score_threshold`. Sorted by `match_score DESC, scored_at DESC`.
- **Applied** — `status='applied'`. Sorted by `applied_at DESC`.
- **Skipped** — `status='skipped'`. Sorted by `skipped_at DESC`.

Each tab label has a count badge that updates live: `New (12)`.

### 5.3 Job card

```
┌─────────────────────────────────────────────────────────────────────┐
│  Senior TypeScript Engineer · Acme Corp · Remote · 2d ago           │
│  [Easy Apply]  [Score 82]  $180k–$220k                              │
│  Backend role with TypeScript, Postgres, AWS. Looking for...        │
│  [Apply on LinkedIn]  [Mark applied]  [Skip]                        │
└─────────────────────────────────────────────────────────────────────┘
```

- Top line: title · company · location · posted-at (relative)
- Apply-method badge: `Easy Apply` (green-ish) or `External` (amber-ish) pill
- Score badge: 0–100 number with subtle colour gradient. Click opens a popover containing `match_justification` (the LLM's reasoning).
- Salary if extracted (else omitted)
- Snippet: `description` truncated to ~2 lines
- Actions:
  - **Primary:** `Apply on LinkedIn` — smart link (Q3D). Easy Apply targets `job.url` (LinkedIn detail page). External targets `external_apply_url` directly. Opens in new tab.
  - **Secondary:** `Mark applied` — POST `/jobs/:id/applied`. Optimistic. Toast: "Marked applied. **Undo**".
  - **Tertiary:** `Skip` — POST `/jobs/:id/skip`. Optimistic. Toast: "Skipped. **Undo**".

On the Applied and Skipped tabs each card has a single `Reopen` action that POSTs `/jobs/:id/scored` to flip back to the New tab.

### 5.4 Live updates

- `jobs:updated { ids }` → React Query invalidates the affected `GET /jobs/:id` queries; the page re-renders just those rows. New rows fade in.
- `search:started` / `search:completed { count }` → updates the `Search now` button state and the "Last search" subtitle.
- `linkedin:session-expired` → disables `Search now`; shows a banner above the tabs with `Reconnect` link to `/settings#sites`.

### 5.5 Server endpoints introduced

- `GET /jobs?status=scored&min_score=70&page=1&page_size=50` — paginated list
- `GET /jobs/:id` — single job (for the popover, if not already loaded)
- `POST /jobs/:id/applied` — flip status to `applied`
- `POST /jobs/:id/skip` — flip status to `skipped`
- `POST /jobs/:id/scored` — flip status to `scored` (Undo / Reopen)
- `POST /searches/run-now` — enqueue an immediate search. Idempotent: if one's already running for this site_id, returns the in-flight task's id.

---

## 6. Live Updates, Alerts, Edge Cases

### 6.1 WebSocket event taxonomy (server → client)

| Event | Payload | Triggered by |
|---|---|---|
| `jobs:updated` | `{ ids: string[] }` | Any job row insert/update (score, status flip, enrichment) |
| `search:started` | `{ task_id, site_id }` | Worker picks up a search task |
| `search:completed` | `{ task_id, site_id, listings_added, scored }` | Search task finished cleanly |
| `search:failed` | `{ task_id, site_id, error_kind }` | Search task threw; `error_kind ∈ { 'session_expired', 'network', 'unknown' }` |
| `linkedin:session-expired` | `{ at }` | Specific case — drives Jobs banner + Search-now disable |
| `alerts:new` | `{ id, kind, message }` | New row inserted into `alerts` table |

The connect-flow status (`linkedin:auth-progress`) intentionally stays REST-polled (§3.3). It's a transient one-time interaction inside the wizard step; not worth WS lifecycle coupling.

### 6.2 Alert kinds (persisted)

| Kind | Trigger | Surfaces |
|---|---|---|
| `linkedin_session_expired` | Worker hit `onSessionExpired === true` | Alerts page; Jobs page banner; Settings → Sites flag |
| `search_failed` | Non-session search failure | Alerts page |
| `score_failed` | Score retry budget exhausted | Alerts page |
| `schedule_paused` | 3 consecutive search failures auto-paused the schedule | Alerts page; Schedule settings flag |
| `provider_failed` | LLM provider repeatedly errored across multiple score tasks | Alerts page |

### 6.3 Edge cases

- **Wrong LinkedIn account.** `onLoginSuccess` doesn't validate identity. User clicks `Disconnect` in Settings → Sites (`DELETE /sites/linkedin`, wipes profile dir) and reconnects with the right account.
- **Corrupted profile dir.** BrowserManager fails to launch → emit alert, fall back to fresh launch (re-auth required from the user).
- **User edits search preferences mid-session.** Next search task reads the new prefs at start. No special handling.
- **User changes LLM provider mid-session.** In-flight score tasks finish with the old provider; new tasks pick up the new one. The score handler's existing factory pattern (`buildModel: () => Promise<BaseChatModel>`) handles this.
- **User uploads new CV.** Subsequent score tasks use it. Already-scored jobs keep old scores. A "re-score all" action is a follow-up.
- **Concurrent `Search now` + scheduler tick.** Queue concurrency=1 → second waits. UI shows `Searching…`; queues silently.
- **User opens app while daemon is starting.** Bootstrap gate already handles this with the existing "Cannot reach the Vina daemon" message.

### 6.4 CLI

Existing commands stay; a few get small additions for the slice:

- `vina start` — boots daemon, scheduler, search + score workers (already does this; verify search worker path picks up the new handler).
- `vina status` — adds: LinkedIn connection status, last-search timestamp, queue depth, paused-schedule flag.
- `vina doctor` — adds checks: Chromium installed (`pnpm exec playwright install chromium` ran), LinkedIn profile dir present, LLM provider configured, schedule not paused, no unacknowledged alerts.
- `vina logs`, `vina stop`, `vina reset` — unchanged.

---

## 7. Open Implementation-Time Resolutions

These are decisions deferred to plan/implementation, not open product questions:

1. **`ScoreInput.cv_text` exact wiring.** Verify which column on `cvs` carries extracted text and which row is "active". Adjust the score handler to load it; adjust the score prompt to reference it.
2. **Migration verification.** Read existing `schedules` and `alerts` tables; add a forward-only migration only if columns/values are missing.
3. **WS client wrapper.** Small client-side reconnect logic. Likely lives at `packages/web/src/lib/ws.ts` if not already present.

---

## 8. Explicitly NOT in This Slice

- **CV tailoring (M14)** — generation, approval flow, tailored-CV storage. Deferred; cv-service code stays dormant.
- **Cover-letter tailoring (M14)** — same reasoning. Wizard step removed; service code dormant.
- **Auto-apply form-walker (M15)** — `SiteAdapter` form methods, `ApplicationSession`, field inspection.
- **Indeed source (M12)** — adapter, fixture, integration. Settings → Sites surfaces "Coming soon".
- **Google Jobs source (M13)** — SerpAPI integration. Settings → Sites surfaces "Coming soon".
- **Profile-answers chatbot.** `/chat` route is unrouted from the sidebar.
- **"X hidden" Jobs-page escape hatch.** Below-threshold count display + show-all toggle. Follow-up after the slice ships.
- **Re-score-all action.** Following an LLM provider change or new CV upload. Follow-up.

---

## 9. Recorded Decisions (Q&A trail)

| # | Question | Answer |
|---|---|---|
| Q1 | LinkedIn login flow placement | **D** — In-wizard step + Settings tile for re-auth |
| Q2 | Search trigger | **C** — Schedule + manual `Search now` |
| Q3 | Apply-method UX | **D** — Badge + smart link, unified actions |
| Q4 | Sources / multi-site UI | **D** — Wizard skips Sources; Settings → Sites carries the multi-source surface with Indeed/Google "Coming soon" |
| Q5 | Page surface | **B′** — Jobs filtered to threshold; ReadyToApply removed; status filter stays; Chat hidden; "X hidden" deferred |
| Q6 | Connect LinkedIn step UX | **C** — Mandatory, 5-min timeout (Try again + warned Skip on timeout), headed Chromium, polls through challenges |
| Q7 | Session expired during a worker run | **A** — Fail loudly, alert, keep saved profile (transient sometimes); 3-strikes auto-pause; Search-now disabled while expired |
| Q8 | Live updates | **A** — WebSocket primary |
