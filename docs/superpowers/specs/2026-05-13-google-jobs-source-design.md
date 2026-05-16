# Google Jobs Source via SerpAPI — Design

**Status:** Implemented (2026-05-16).
**Date:** 2026-05-13.
**Scope:** Bring Google Jobs online as the second source. HTTP-only (no Playwright). Every listing routes through the existing JobsPage UX as `apply_method='manual'`. Tailored materials (CV + cover letter) are out of scope here — they land in Phase B.

This slice supersedes the original `build-order.md` M13. It assumes the LinkedIn end-to-end slice (`docs/superpowers/specs/2026-05-04-linkedin-end-to-end-slice-design.md`) has shipped, and aligns with ADR-015 (SerpAPI for Google Jobs) and ADR-019 (Indeed skipped).

---

## 1. Goal & Scope

### 1.1 Goal

A user who has supplied a valid SerpAPI key can enable Google Jobs as a source. The scheduler ticks, jobs flow into the Jobs page tagged `apply_method='manual'` with the original posting source visible (e.g. "via Greenhouse"), and the user clicks the smart-link Apply to open the external listing — same UX they already have for LinkedIn external listings. Marking applied uses the same status flip endpoint.

### 1.2 What ships

1. **SerpAPI client.** Filled-in `packages/server/src/services/serpapi-service.ts` — single-call wrapper around the Google Jobs endpoint with key redaction, pagination, and rate-limit handling.
2. **Search task dispatch.** The existing `search` queue handler routes `site_id='linkedin'` to the LinkedIn pipeline (already shipped) and `site_id='google'` to the SerpAPI pipeline. One worker, two branches.
3. **Wizard SerpAPI step.** New optional step in the onboarding wizard between LLM Provider and Preferences: "Enable Google Jobs (optional)". Paste key → validate → enable.
4. **Settings → Sites tile entry.** Google Jobs row alongside LinkedIn. Connected / Not configured / Key invalid states. Edit-key affordance reuses the same validate call.
5. **Scheduler wiring.** When Google Jobs is enabled, the per-tick fan-out enqueues a `search` task per enabled site. Already-built scheduler logic; just verify it reads `sites.enabled` for both sources.
6. **Doctor + status.** `vina doctor` adds a "SerpAPI key valid" check (skipped when no key). `vina status` reports the same.
7. **CV in score input — applies to Google Jobs too.** The score handler change from the LinkedIn slice already folds CV into `ScoreInput`; no Google-specific change needed.

### 1.3 Deferred — handled in Phase B

- **Tailored CV / cover letter for manual-apply jobs.** Listings appear in the Jobs page with the existing smart-link Apply, exactly like LinkedIn external listings. No "Ready to Apply" surface yet — that's Phase B.
- **Re-routing the `manual` branch from `Jobs / New` into a dedicated `Ready to Apply` tab.** Stays in `New` for this slice; Phase B introduces the tab split.

### 1.4 Out of scope

- Indeed source (ADR-019).
- Live search-progress events specific to api-kind sources beyond the existing `search:*` taxonomy.
- Per-source score thresholds. One shared `score_threshold` applies to both sources.
- Persistent caching of SerpAPI responses to reduce API spend. The free-tier quota (250/month) is enough for the typical schedule.

---

## 2. Architecture & Data Flow

### 2.1 Pipeline

```
Schedule cron tick           ┐
                             ├── for each enabled site:
"Search now" button (per site)┘     enqueue { kind:'search', payload:{ site_id } }
                                              │
                                              ▼
                                  search worker (concurrency=1 per site_id)
                                              │
                          ┌───────────────────┴───────────────────┐
                          │                                       │
            site_id='linkedin' (existing)               site_id='google' (new)
                          │                                       │
                          ▼                                       ▼
                  linkedInAdapter.search          serpapiService.searchGoogleJobs(prefs)
                          │                                       │
                          ▼                                       ▼
              per-listing flow (already                Iterate `jobs_results`:
              shipped: insert → enrich →                 insertJob({
              detectApplyMethod → enqueue                  site_id:'google',
              score)                                       apply_method:'manual',
                                                           external_apply_url: apply_options[0].link,
                                                           original_source: via,
                                                           description, salary, …
                                                         })
                                                         enqueue 'score' task
                                                         bus.emit('jobs:updated')
```

Concurrency: still 1 in-flight `search` task per `site_id`. SerpAPI is a single HTTP call (or a small number, see §3.4), so the constraint is symbolic for `google` — it prevents two schedule ticks landing simultaneously on the same source.

### 2.2 Status flow

Identical to the LinkedIn slice: `created` → `scored` → `applied` | `skipped`. Google Jobs listings have `apply_method='manual'`, which (post-LinkedIn-slice) means the Jobs page Apply button is a smart link to `external_apply_url` instead of `job.url`.

### 2.3 Data shape per listing

SerpAPI's Google Jobs `jobs_results[]` entries (relevant fields):

```jsonc
{
  "title": "Senior TypeScript Engineer",
  "company_name": "Acme Corp",
  "location": "Remote",
  "via": "via Greenhouse",            // source for `jobs.original_source`
  "description": "...",
  "extensions": ["Full-time", "$180K–$220K"],   // parse salary out of this
  "detected_extensions": { "schedule_type": "Full-time", "salary": "$180K–$220K" },
  "apply_options": [
    { "title": "Apply on Greenhouse", "link": "https://..." }
  ],
  "job_id": "abc...",                 // upstream identifier; mapped to jobs.external_id
}
```

Mapping into `jobs`:

| SerpAPI field | `jobs` column | Notes |
|---|---|---|
| `title` | `title` | |
| `company_name` | `company` | |
| `location` | `location` | |
| `description` | `description` | Can be large — no truncation |
| `via` | `original_source` | Stored as-is ("via Greenhouse") |
| `apply_options[0].link` | `external_apply_url` | First entry; if absent, drop the listing |
| `detected_extensions.salary` ∥ regex on `extensions` | `salary_text` | Best-effort; null if not parseable |
| `job_id` | `external_id` | For dedupe against future ticks |
| — | `apply_method` | Always `'manual'` |
| — | `site_id` | Always `'google'` |
| — | `url` | Set to `apply_options[0].link` so smart-link Apply works without a separate code path (note in code: alias of `external_apply_url`) |

Dedupe: `(site_id, external_id)` unique constraint — already present from M2.

---

## 3. SerpAPI Service

### 3.1 File location

`packages/server/src/services/serpapi-service.ts`. The stub from M5 already exists; this slice fills it in. Per ADR-015 it does **not** live in `packages/automation/` — SerpAPI is HTTP, not browser.

### 3.2 Interface

```ts
export interface GoogleJobsSearchInput {
  keywords: string;         // joined preference keywords
  location?: string;        // single location string; first preference
  num?: number;             // default 20; max 100 per call
  next_page_token?: string; // for pagination
}

export interface GoogleJobsListing {
  external_id: string;
  title: string;
  company: string;
  location: string;
  description: string;
  via: string;              // "via Greenhouse"
  apply_url: string;        // first apply option
  salary_text: string | null;
}

export interface SerpapiService {
  validateKey(key: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  searchGoogleJobs(input: GoogleJobsSearchInput, opts?: { signal?: AbortSignal }): AsyncIterable<GoogleJobsListing>;
}
```

`searchGoogleJobs` is an async iterator so the search handler can short-circuit (signal aborted, queue back-pressure) without holding all results in memory. The implementation pages via `next_page_token` up to a soft cap of N pages (configurable; default 3 → ~60 listings/run).

### 3.3 Key handling

- Stored encrypted in `settings.encrypted_serpapi_key` per M5.
- Read at task start via `settings-service.getDecryptedSerpapiKey()`. If the column is empty, the search handler emits `Alert(kind='serpapi_key_missing')` and the task fails fast.
- Never logged. The `serpapi-service` constructs URLs without the key in any log line; the key is appended to the URL only at `fetch()` time and stripped from any retry/error log.

### 3.4 Rate limit + retry

- SerpAPI returns `429` on quota exhaustion. The service surfaces this as `SerpapiQuotaExhaustedError`. The search handler maps it to `Alert(kind='serpapi_quota_exhausted')` and increments the schedule's `consecutive_failures` (same pattern as LinkedIn session expired).
- Transient `5xx`: retry once with 2s backoff inside the service. Beyond that, surface to the handler.
- `403` (key invalid / revoked): `Alert(kind='serpapi_key_invalid')`. Schedule pauses after 3 strikes per the existing failure-tracking machinery.

### 3.5 Error taxonomy (new)

Three new alert kinds extend the enum widened by migration 002:

| Kind | Trigger | Severity | Surfaces |
|---|---|---|---|
| `serpapi_key_missing` | Google Jobs enabled but no key | `action_required` | Alerts page; Settings → Sites tile |
| `serpapi_key_invalid` | Key returns 403 | `action_required` | Alerts page; Settings → Sites tile |
| `serpapi_quota_exhausted` | Key returns 429 | `info` | Alerts page; auto-resolves on next successful tick |

These land in a forward-only migration `003_serpapi_alert_kinds.sql` that widens the `alerts.kind` CHECK constraint. Mirror in `@vina/shared` ALERT_KINDS.

---

## 4. Onboarding & Configuration

### 4.1 Wizard step

Insert a new step between `llm-provider` and `preferences` in the wizard step order:

```
welcome → profile → cv → llm-provider → google-jobs → preferences → schedule → connect-linkedin → done
```

The step is **optional** — primary action "Enable Google Jobs", secondary action "Skip for now". Skip is a real path (Google Jobs is an enhancer, not a hard dependency).

### 4.2 ConnectGoogleJobs step UX states

| State | UI | Server |
|---|---|---|
| **Initial** | Title, 2-line explanation, key input, "Enable" + "Skip for now" | — |
| **Validating** | Disabled input + spinner | `POST /api/sites/google/test` → `validateKey()` |
| **Valid** | ✅ "Connected to SerpAPI", auto-advance after 1s | Server persists encrypted key, sets `sites.google.enabled=1` |
| **Invalid** | Red banner with the reason (quota, key) | Server returns 400; UI keeps user on step |

The validate endpoint reuses the M6 stub `POST /api/sites/google/test` — fill it in if not already wired.

### 4.3 Settings → Sites tile

The tile from the LinkedIn slice (`SettingsPage.tsx` Sites section) gains a Google Jobs row:

- **Not configured** (default): "Add a SerpAPI key" CTA.
- **Connected**: Last successful search time, "Edit key" / "Disconnect" affordances.
- **Key invalid / quota exhausted**: Alert-style row with "Update key" CTA.

Reuses the same `useLinkedInStatus` pattern as a `useGoogleJobsStatus({ pollMs })` hook.

### 4.4 Schedule wiring

The scheduler already enqueues one `search` task per enabled site on each tick (M10). Verify the existing query is `SELECT id FROM sites WHERE enabled=1` — not hard-coded to LinkedIn. If hard-coded, generalise. No new schedule UI surfaces.

---

## 5. Jobs Page Reuse

No structural changes. Listings flow into the existing `New` tab with `apply_method='manual'` and `external_apply_url` set. The JobCard already renders:

- "External" apply-method badge (amber-ish pill) — already implemented for LinkedIn external listings.
- `original_source` as a small caption under the company name: "via Greenhouse". **New** — minor JobCard tweak.
- Smart-link `Apply on Greenhouse` (label uses `original_source` stripped of "via" prefix when present, falling back to "Apply externally").

The Mark applied / Skip endpoints already work for any job regardless of `apply_method`.

---

## 6. Live Updates, Alerts, Edge Cases

### 6.1 WebSocket events

No new event kinds. Google Jobs ticks emit the same `search:started` / `search:completed { listings_added, scored }` / `jobs:updated` / `search:failed { error_kind }` events, with `site_id='google'`.

### 6.2 Edge cases

- **User has both LinkedIn and Google Jobs enabled.** Two `search` tasks enqueued per tick; per-site concurrency keeps them ordered. Counts in the Dashboard activity panel sum across both.
- **User disables Google Jobs.** `sites.google.enabled=0`. Existing jobs stay in the table; scheduler stops enqueuing.
- **User rotates SerpAPI key mid-session.** Settings → Sites "Edit key" re-validates and persists. In-flight tasks finish with the old key; next task picks up the new one.
- **Listing without `apply_options`.** Drop the listing — there's no URL to send the user to. Log a debug line.
- **SerpAPI returns duplicates across pages.** Handled by the `(site_id, external_id)` uniqueness constraint — `INSERT OR IGNORE`.
- **Listing where `via` is missing.** Stored as `null`; JobCard falls back to "Apply externally" label.

### 6.3 CLI

- `vina status` — adds "Google Jobs: connected (last search 14m ago)" / "not configured" / "key invalid".
- `vina doctor` — adds:
  - "SerpAPI key configured" (info; not a failure when absent)
  - "SerpAPI key valid" (skipped when not configured; checks `validateKey()` when present)

---

## 7. Recorded Decisions (Q&A trail)

| # | Question | Answer |
|---|---|---|
| Q1 | Where does the SerpAPI client live? | `packages/server/src/services/serpapi-service.ts`. Not `packages/automation/`. ADR-015. |
| Q2 | Pagination cap? | Default 3 pages × ~20 listings = ~60/tick. Configurable later if needed. |
| Q3 | Optional or required wizard step? | Optional. Skip is a real path. |
| Q4 | Show source in JobCard? | Yes — small caption "via Greenhouse". |
| Q5 | Listings without `apply_options[0].link`? | Drop. No way to direct the user. |
| Q6 | Caching SerpAPI responses? | No. Free-tier quota suffices. |
| Q7 | Per-source score threshold? | No. One shared threshold. |
| Q8 | Migration 003 needed? | Yes — three new alert kinds. |

---

## 8. Explicitly NOT in this slice

- **Tailored CV / cover letter generation.** Phase B.
- **`Ready to Apply` page split.** Phase B.
- **Indeed.** ADR-019.
- **Auto-apply form-walker.** Phase C (deferred).
- **Per-source dashboards / metrics breakdowns.** Future polish.

---

## 9. Success criteria

- A user with a valid SerpAPI key completes onboarding, enables Google Jobs, and sees Google-Jobs-originated listings in the Jobs page within one schedule tick of completion.
- Each Google Jobs listing in the Jobs page has: title, company, location, score badge, "External" apply-method badge, "via …" caption, smart-link Apply, and the Mark applied / Skip actions all work.
- An invalid key generates an `serpapi_key_invalid` alert; the user updates the key in Settings → Sites; the next tick succeeds without a restart.
- `vina doctor` with no key configured reports "Google Jobs: not configured" without failing. With a key configured, it reports validity.
