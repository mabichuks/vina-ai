# Manual-Apply Pipeline — Design

**Status:** Implemented (2026-05-17).
**Date:** 2026-05-13.
**Scope:** Wake the dormant `cv-service` / `cover-letter-service` shells and the dormant `applications` table. Build the tailor-CV graph, the tailor-cover-letter graph, the `prepare_manual_apply` graph that orchestrates them, and the Ready-to-Apply UI surface. Both sources (LinkedIn external + Google Jobs) flow through this pipeline.

This slice folds the original `build-order.md` M14 (Tailor CV), M16 (Prepare-manual-apply), and M19 (Ready to Apply UI) into one cohesive surface. Auto-apply form-walker (M15) is **deferred (Phase C)** and explicitly out of scope.

This slice assumes Phase A (Google Jobs source) has shipped, so two manual-apply flows are live.

---

## 1. Goal & Scope

### 1.1 Goal

For any job marked `apply_method='manual'` (LinkedIn external + every Google Jobs listing), Vina prepares the user's materials: a tailored CV (DOCX) and — if the user uploaded a cover letter — a tailored cover letter, then surfaces them in a "Ready to Apply" view with the external link, download buttons, and a "Mark as applied" action. The Mark-applied action transitions the application to `applied_manually` and auto-resolves the alert.

### 1.2 What ships

1. **`tailor-cv` LangGraph graph** (`packages/orchestrator/src/graphs/tailor-cv.ts`) — structured-output prompt + DOCX renderer.
2. **`tailor-cover-letter` LangGraph graph** (`packages/orchestrator/src/graphs/tailor-cover-letter.ts`) — same shape, optional per application.
3. **`prepare-manual-apply` LangGraph graph** (`packages/orchestrator/src/graphs/prepare-manual-apply.ts`) — orchestrates the two tailoring graphs and writes the application transition.
4. **`prepare_manual_apply` queue handler** (`packages/server/src/queue/handlers/prepare-manual-apply.ts`) — invokes the graph, persists outputs, emits events.
5. **`applications` table activation** — creating an application row when a scored job is selected for tailoring (autonomous or supervised). Status flow: `queued` → `ready_for_manual_apply` → `applied_manually` | `skipped`.
6. **Tool kit boundary** (`packages/orchestrator/src/tools/`) — `saveTailoredCv` and `saveTailoredCoverLetter` tools, injected by the server, write files to `<dataDir>/files/tailored/` and `<dataDir>/files/tailored-cover-letters/`.
7. **HTTP routes** —
   - `POST /api/jobs/:id/prepare` — create application + enqueue `prepare_manual_apply` task.
   - `GET /api/applications` — list (filter by status; default `ready_for_manual_apply`).
   - `GET /api/applications/:id` — single.
   - `GET /api/applications/:id/tailored-cv` — stream DOCX.
   - `GET /api/applications/:id/tailored-cover-letter` — stream DOCX (404 if absent).
   - `POST /api/applications/:id/mark-applied` — flip to `applied_manually`; auto-resolve alert.
   - `POST /api/applications/:id/skip` — flip to `skipped`; auto-resolve alert.
8. **Alert kind `ready_for_manual_apply` activation** — already in the enum (M11 slice); now actually emitted with `{ application_id, external_apply_url, tailored_cv_path }` payload. Sidebar badge counts open `ready_for_manual_apply` alerts.
9. **Ready-to-Apply route** (`packages/web/src/routes/ready/ReadyToApplyPage.tsx`) — card list with title, company, score, download buttons, external link, Mark applied / Skip actions, optional notes textarea.
10. **Jobs page integration** — the Jobs page New tab gains a per-card "Prepare materials" action that calls `POST /api/jobs/:id/prepare`. Jobs that have an active application surface a "Tailoring…" or "Ready to apply" badge with a link to the corresponding application.
11. **Autonomy** — when `settings.mode='autonomous'`, the score worker enqueues `prepare_manual_apply` automatically for any scored job above `score_threshold`. When `'supervised'`, the user clicks "Prepare materials" per job.
12. **Dashboard tile** — top 3 ready-to-apply applications, link to `/ready`.
13. **Sidebar** — restore the `/ready` entry (currently redirected to `/jobs` by the LinkedIn slice).

### 1.3 Approval mode

Per `SPEC.md` §5, the approval-mode knob is implicit for manual-apply: the user always reviews because they're submitting. **This slice does not surface a separate approval-mode UI for manual-apply.** The `settings.approval` column stays, but is only consulted by the future auto-apply pipeline (Phase C).

### 1.4 Deferred / dormant

- **Auto-apply form-walker (M15)** — Phase C.
- **Reject-and-regenerate tailored CV** — once tailored, the user downloads it as-is. Re-tailoring lands later as a Ready-to-Apply card action ("Re-tailor"); for this slice the user gets one shot.
- **Editing the tailored CV in the UI** — DOCX editing in-browser is out of scope.
- **Profile-answers chatbot** — `/chat` stays hidden; manual-apply doesn't depend on profile-answers.
- **Application timeline (`application_events`)** — table exists; this slice only writes `created`, `cv_tailored`, `ready_for_manual_apply`, `applied_manually`, `skipped` events. The full event log surfaces in a later slice.

---

## 2. Architecture & Data Flow

### 2.1 Pipeline

```
Job exists at status='scored', apply_method='manual'
                              │
        ┌─────────────────────┴─────────────────────┐
        │                                           │
[supervised: user clicks                 [autonomous mode:
 "Prepare materials" in JobsPage]         score worker auto-enqueues
                                          when match_score >= threshold]
        │                                           │
        ▼                                           ▼
        POST /api/jobs/:id/prepare         (same internal helper)
                              │
                              ▼
              insertApplication({ job_id, status:'queued',
                                  apply_method:'manual', cv_id })
              enqueue task { kind:'prepare_manual_apply',
                             payload:{ application_id } }
              bus.emit('jobs:updated', { ids:[job_id] })  // for "Tailoring…" badge
                              │
                              ▼
                  prepare_manual_apply handler
                              │
                              ▼
         runPrepareManualApply({ application_id, job, cv, cover_letter_template? })
                              │
                              ▼
              tailor-cv subgraph → DOCX bytes → saveTailoredCv(...)
                              │
                              ▼
              (if cover_letter_template) tailor-cover-letter → DOCX → save…
                              │
                              ▼
              updateApplication({
                status:'ready_for_manual_apply',
                tailored_cv_path,
                tailored_cover_letter_path?,
                tailored_at: now
              })
              insertAlert({
                kind:'ready_for_manual_apply',
                payload:{ application_id, external_apply_url, … }
              })
              bus.emit('application:ready_for_manual_apply', { application_id })
              bus.emit('alerts:new', { id, kind, message })
                              │
                              ▼
                  Ready-to-Apply page updates live
                              │
        ┌─────────────────────┴─────────────────────┐
        │                                           │
"Mark applied" → POST /applications/:id/mark-applied   "Skip" → POST .../skip
        │                                           │
        ▼                                           ▼
   status='applied_manually'                  status='skipped'
   auto-resolve alert                         auto-resolve alert
   emit application:applied_manually          emit jobs:updated
```

### 2.2 Status flow (`applications.status`)

`queued` → `ready_for_manual_apply` → `applied_manually` | `skipped`

Failure path: any failure in the `prepare_manual_apply` handler transitions the application to `failed` and emits `Alert(kind='apply_failed')` per the existing taxonomy. Queue retries 3× with exponential backoff before failing.

### 2.3 Job ↔ Application relationship

- One job → 0 or 1 active applications. Active = `status NOT IN ('skipped', 'failed', 'dismissed')`.
- `POST /jobs/:id/prepare` is idempotent: if an active application already exists, return it without creating a new one.
- When the user marks the application applied or skipped, the job's `status` does NOT change. Jobs and applications are decoupled lists; the Jobs page shows jobs, the Ready-to-Apply page shows applications.
- Skipped/dismissed applications can be re-prepared (a new application row).

### 2.4 Worker concurrency

- `prepare_manual_apply` kind: parallel, cap = 4. LLM calls are independent; the per-provider rate-limit is the operative bound (mirrors `score`).
- `score` kind: unchanged (parallel, cap 4).
- `search` kind: unchanged (1 per `site_id`).

---

## 3. Orchestrator Graphs

### 3.1 `tailor-cv.ts`

**Input.**

```ts
interface TailorCvInput {
  job: { title: string; company: string; description: string; }
  source_cv_text: string;        // extracted text from cvs.text_content
  user_profile: { full_name: string; bio: string; }
}
```

**Output (structured).**

```ts
interface TailorCvOutput {
  summary: string;               // 2-3 sentences
  bullets: { section: string; bullet: string; }[];   // rewritten bullets, grouped by section
  skills: string[];              // promoted-to-top skills relevant to this job
}
```

**Process.**

1. Single LLM call via `withStructuredOutput(TailorCvOutputSchema)`. Temperature 0.4 — enough variation to rephrase, low enough to keep facts.
2. Strong "do not invent facts" instruction in the system prompt. Examples in the prompt show good rephrasing (keeps dates, numbers, employers) and bad invention (made-up tech, fake company).
3. Renderer: pure function `renderTailoredDocx(output: TailorCvOutput, source: ExtractedCvStructure): Buffer`. Uses `docx-js` to produce a single-section DOCX that mirrors the source CV's structure (header, summary, experience, skills, education). The renderer is **not LLM-touched** — the LLM produces structured content; the renderer lays it out deterministically.
4. The renderer ships a single template for MVP. Per-user CV layout preservation is out of scope.

**Why structured output, not "write me a DOCX":** The LLM is bad at producing well-formed DOCX XML. It's good at producing structured content. The deterministic renderer keeps the file valid.

### 3.2 `tailor-cover-letter.ts`

**Input.**

```ts
interface TailorCoverLetterInput {
  job: { title: string; company: string; description: string; }
  source_template: string;       // extracted text from cover_letters.text_content
  user_profile: { full_name: string; bio: string; }
}
```

**Output.**

```ts
interface TailorCoverLetterOutput {
  greeting: string;              // "Dear Hiring Manager," / "Dear Acme Team,"
  body_paragraphs: string[];     // 3-4 paragraphs
  closing: string;               // "Sincerely, Jane Doe"
}
```

Same shape and constraints as tailor-cv: structured output, deterministic renderer.

### 3.3 `prepare-manual-apply.ts`

A small orchestrator graph with three nodes:

```
START → tailor_cv → (cover_letter_present?) → tailor_cover_letter → save_and_finish
                                          ↓ (no)
                                          → save_and_finish
```

**State (typed).**

```ts
interface PrepareManualApplyState {
  application_id: string;
  job: JobForTailoring;
  cv: SourceCv;
  cover_letter_template: SourceCoverLetter | null;
  tailored_cv_path?: string;
  tailored_cover_letter_path?: string;
  error?: { stage: 'tailor_cv' | 'tailor_cover_letter' | 'save'; message: string };
}
```

The graph never touches the database directly — it returns the final state, and the queue handler does the writes. This keeps the graph testable with a fake `BaseChatModel` and no DB dependency.

### 3.4 Determinism, prompts, temperature

- `tailor-cv` / `tailor-cover-letter` use temperature 0.4 (per `docs/langgraph-orchestrator.md` §7 — tailoring needs some variation).
- Prompts live in `packages/orchestrator/src/prompts/tailor-cv.ts` and `tailor-cover-letter.ts`. Each prompt has 1 worked example showing the "rephrase, don't invent" boundary.
- Token budget: input CV truncated to 3500 tokens; job description truncated to 1500 tokens. Output capped at 2000 tokens. (Matches `docs/langgraph-orchestrator.md` §8.)

---

## 4. Server: Handlers and Routes

### 4.1 Queue handler

`packages/server/src/queue/handlers/prepare-manual-apply.ts`:

1. Load application + job + active CV + (optional) active cover letter.
2. Construct `PrepareManualApplyInput`. Truncate CV/cover-letter text to budget.
3. Call `runPrepareManualApply(input, modelFactory, toolKit)`.
4. On success: persist tailored paths, transition application status, insert alert, emit events.
5. On failure: increment retry count; on retry exhaustion, transition to `failed`, emit `apply_failed` alert. Existing retry machinery handles backoff (30s / 60s / 120s).

### 4.2 Tool kit

`packages/orchestrator/src/tools/save-tailored-cv.ts` and `save-tailored-cover-letter.ts` are **interfaces only** in the orchestrator package. The server-side implementations live in `packages/server/src/orchestrator/tools/` and are injected into the graph at task-handler invocation time. Per `docs/langgraph-orchestrator.md` §4, this is the standard tool-kit boundary.

File paths:

- Tailored CV: `<dataDir>/files/tailored/<application_id>.docx`
- Tailored cover letter: `<dataDir>/files/tailored-cover-letters/<application_id>.docx`

Permissions: 0600. Directory created on demand.

### 4.3 HTTP routes

`packages/server/src/http/routes/applications.ts` is **new**. Routes:

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/jobs/:id/prepare` | — | `{ application_id, status }` (idempotent: returns existing active application if present) |
| GET | `/api/applications` | query: `status`, `page`, `page_size` | `{ rows: Application[], next_page? }` |
| GET | `/api/applications/:id` | — | `Application` |
| GET | `/api/applications/:id/tailored-cv` | — | DOCX stream (404 if not yet tailored) |
| GET | `/api/applications/:id/tailored-cover-letter` | — | DOCX stream (404 if none) |
| POST | `/api/applications/:id/mark-applied` | `{ notes?: string }` | `Application` (post-flip) |
| POST | `/api/applications/:id/skip` | `{ reason?: string }` | `Application` (post-flip) |

Mark-applied and skip actions:

- Transition status.
- Set `applied_manually_at` / `applied_manually_notes` (mark-applied only).
- Auto-resolve the `ready_for_manual_apply` alert for this application.
- Emit `jobs:updated` (since the Jobs page card may show the application's badge).
- Emit `application:applied_manually` / `application:skipped`.

### 4.4 Score handler change

`packages/server/src/queue/handlers/score.ts` — after scoring, if `settings.mode='autonomous'` AND the new `match_score >= settings.score_threshold` AND the job's `apply_method='manual'`, enqueue `prepare_manual_apply` directly (via the same internal helper that `POST /jobs/:id/prepare` uses). For `apply_method='auto'`, do nothing — Phase C will activate that branch.

---

## 5. Ready-to-Apply UX

### 5.1 Route

`/ready` is restored as a top-level nav item. The Sidebar gets an entry with an action-required badge counting open `ready_for_manual_apply` alerts.

### 5.2 Page layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Ready to Apply                                                  │
│ 4 applications waiting · Last update 12s ago                    │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Senior TypeScript Engineer · Acme Corp · Remote             │ │
│ │ [External · via Greenhouse]  [Score 82]                     │ │
│ │ Tailored CV ready · Cover letter ready                      │ │
│ │ [Download CV] [Download cover letter] [Apply on Greenhouse] │ │
│ │ [Mark applied]  [Skip]                                      │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ … next card …                                               │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

Card actions:

- **Download CV** / **Download cover letter** — `GET /api/applications/:id/tailored-cv` etc. Browser downloads as `<company>-<job-title>.docx` (server sets `Content-Disposition: attachment; filename=…`).
- **Apply on …** — smart link using `original_source` (e.g. "Apply on Greenhouse", "Apply externally" fallback). Opens external_apply_url in a new tab.
- **Mark applied** — opens a small dialog: optional notes textarea, confirm button. On confirm, `POST mark-applied`. Optimistic; toast on success with **Undo** action (POST `/api/applications/:id/skip` is **not** undo — undo would need a new "reopen" endpoint deferred to follow-up).
- **Skip** — same shape; optional reason.

### 5.3 Empty state

"No applications waiting. Scored jobs you mark for tailoring will appear here." with a CTA link to `/jobs?status=scored`.

### 5.4 Live updates

- `application:ready_for_manual_apply` → invalidate the page query; new card fades in at the top.
- `alerts:new { kind:'ready_for_manual_apply' }` → already handled by the Alerts page; the Sidebar badge updates.

### 5.5 Dashboard integration

The Dashboard already shows LinkedIn status + counts + Search now. Phase B adds:

- A "Ready to apply" tile: count + 3 most-recent cards (read-only previews), link to `/ready`.
- The existing job counts row gains a "Ready" badge alongside New / Applied / Skipped.

### 5.6 Jobs page integration

The "New" tab JobCard gains:

- **"Prepare materials" button** — primary action when `apply_method='manual'`. Replaces the position previously occupied by the smart-link "Apply" button. Disabled with tooltip when the active application exists ("Already preparing… [Open]").
- **Application badge** — when an active application exists for the job, the card shows "Tailoring…" or "Ready to apply" with a link to `/ready#<application_id>`.
- The smart-link "Apply externally" stays as a secondary action — escape hatch for users who want to skip tailoring entirely. Clicking it does not change job status.

For `apply_method='auto'` jobs (LinkedIn Easy Apply), the JobCard keeps the existing "Apply on LinkedIn" smart link. Phase C activates the auto-submit path; until then the user uses LinkedIn directly.

---

## 6. Alerts Integration

### 6.1 `ready_for_manual_apply` alert

Already in the enum from the LinkedIn slice's migration 002. Now actually emitted by the `prepare_manual_apply` handler with payload:

```jsonc
{
  "application_id": "...",
  "job_id": "...",
  "external_apply_url": "https://...",
  "tailored_cv_path": "...",
  "tailored_cover_letter_path": "..." // or null
}
```

The Alerts page (already shipped) gains a per-kind inline card for `ready_for_manual_apply`:

- "Tailored materials ready for *Senior TypeScript Engineer @ Acme Corp*."
- Inline buttons: **Download CV** · **Open external link** · **Mark applied**.
- Clicking any download/open does not auto-resolve. Marking applied does.

### 6.2 Auto-resolve

When the user marks the application applied or skipped, the matching `ready_for_manual_apply` alert flips to `resolved` automatically. Emit `alerts:resolved { id }`.

---

## 7. Edge Cases

- **User has no CV uploaded.** `POST /api/jobs/:id/prepare` returns 400 with a clear message: "Upload a CV in Profile first." UI surfaces a banner with a link.
- **User has no cover letter uploaded.** Tailoring runs without cover letter; application has `tailored_cover_letter_path=null`. Ready-to-Apply card shows "Cover letter: none" instead of a download button.
- **User changes CV mid-tailoring.** In-flight tasks finish with the old CV. New tasks use the new active CV.
- **User changes LLM provider mid-tailoring.** Provider factory pattern (already in place from the score handler) — new graph invocations pick up the new provider.
- **Application failed after retries.** Status flips to `failed`. Alert `apply_failed`. User can retry from the Ready-to-Apply page (a future card action — not in this slice; for now the user re-prepares from the Jobs page, which creates a new application).
- **Autonomous mode + 50 jobs above threshold.** Queue absorbs; worker processes 4 in parallel. No special handling.
- **Both LinkedIn and Google Jobs return the same listing (cross-source dupe).** Different `(site_id, external_id)` tuples — both inserted. The user sees both; clicking Prepare on either creates separate applications. Cross-source dedup is a future feature; for MVP a tiny duplication is acceptable.

---

## 8. Recorded Decisions

| # | Question | Answer |
|---|---|---|
| Q1 | Where does autonomy live in this slice? | Score handler — if mode=autonomous AND score>=threshold AND apply_method='manual', auto-enqueue prepare. No new UI knob; uses existing `settings.mode`. |
| Q2 | Approval-mode for manual-apply? | Implicit always-review (user submits externally). `settings.approval` is dormant in this slice. |
| Q3 | Tailored materials editable in UI? | No. One-shot generation. Re-tailor (regenerate) deferred. |
| Q4 | Ready-to-Apply route or only a tab? | Both. `/ready` is the focused list; Jobs page tabs gain a Ready-to-apply badge. |
| Q5 | Job status changes when application starts? | No. Job stays `scored` until applied/skipped. Application carries the lifecycle. |
| Q6 | DOCX rendering: LLM-driven or deterministic? | Deterministic renderer; LLM produces structured content. |
| Q7 | One layout template for tailored CVs? | Yes, MVP. Per-user layout preservation is a follow-up. |
| Q8 | What happens on cross-source dupes? | Both inserted (different external_ids). Dedup is a future feature. |
| Q9 | Undo after Mark-applied? | Not in this slice. Toast says "Marked applied" only; reopen is deferred. |

---

## 9. Explicitly NOT in this slice

- **Auto-apply form-walker (M15).** Phase C — auto-submit on LinkedIn Easy Apply.
- **CV editing in UI.** Out of scope.
- **Re-tailor / regenerate.** Out of scope.
- **Profile-answers chatbot.** Out of scope.
- **Application timeline (`application_events`) full surface.** Only the key state events are written this slice.
- **Cross-source dedup.** Out of scope.
- **Per-source dashboards / metrics.** Out of scope.
- **Indeed.** ADR-019.

---

## 10. Success criteria

- A user with a CV, cover letter, LLM provider, and scored jobs can:
  1. Click "Prepare materials" on a `manual` job — application appears in Ready-to-Apply within ~10s with downloadable tailored CV and cover letter.
  2. Download the materials — DOCX opens in Word, contains no invented facts (manually verified against fixtures).
  3. Click "Apply on …" — external link opens in new tab.
  4. Click "Mark applied" with optional notes — application moves to Applied; the alert auto-resolves; the Sidebar badge decrements.
- In autonomous mode, scored jobs above threshold auto-enqueue tailoring without user action.
- An LLM provider 5xx during tailoring retries 3× and surfaces `apply_failed` alert on retry exhaustion. The user can re-prepare from the Jobs page.
- Sidebar shows the ready badge live; Dashboard shows the top 3 ready applications.
- A tailored CV survives `vina stop` / `vina start` (file persists, application row persists, page renders).
