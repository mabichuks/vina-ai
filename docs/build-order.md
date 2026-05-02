# Build Order

A suggested sequence for implementing Vina from an empty repository to a working MVP. Each milestone is small enough to land cleanly, with tests, before moving on.

This is a recommendation, not a contract. If a milestone's scope changes, update this file in the same change.

---

## Milestone 0 — Repo bootstrap

**Goal:** A working pnpm monorepo with empty packages and a green CI pipeline.

**Tasks.**

- `pnpm init` at the root, `pnpm-workspace.yaml` with `packages/*`
- `tsconfig.base.json` with strict settings
- ESLint + Prettier config at the root
- Empty `packages/{cli,server,orchestrator,automation,web,shared}` each with their own `package.json` and `tsconfig.json` extending the base
- `vitest` configured for the workspace
- A no-op CI job that runs `pnpm install`, `pnpm build`, `pnpm test`, `pnpm lint`

**Done when:** `pnpm test` runs and passes (with no tests yet); `pnpm build` succeeds.

---

## Milestone 1 — Shared types and schemas

**Goal:** The shape of the world is defined in one place.

**Tasks.**

- In `packages/shared/`:
  - Zod schemas for `Profile`, `Cv`, `CoverLetter`, `SearchPreferences`, `Settings`, `Schedule`, `LlmProvider`, `Site`, `Job`, `Application`, `ApplicationEvent`, `Alert`, `ProfileAnswer`, `ChatMessage`, `Task`
  - TypeScript types inferred from those schemas
  - Enum constants matching the `CHECK` constraints in `database-schema.md` (including `apply_method`, `ready_for_manual_apply`, `applied_manually`)
  - Event names for the in-process bus (including `application:ready_for_manual_apply` and `application:applied_manually`)
  - `VinaError` base class and the small hierarchy described in `backend-designer.md`
  - A `logger` re-export wrapping `pino`
- Tests: round-trip parse a fixture for every schema

**Done when:** `@vina/shared` can be imported from any other package and exports stable types.

---

## Milestone 2 — Database layer

**Goal:** A working SQLite database with the full schema and one repository per table.

**Tasks.**

- `packages/server/src/db/client.ts` — `better-sqlite3` singleton, WAL mode, foreign keys ON
- `packages/server/migrations/001_init.sql` — every table from `database-schema.md`, plus indexes. Seeds `sites` with `linkedin`, `indeed`, and `google` (`google` with `kind='api'`)
- `packages/server/src/db/migrate.ts` — runs forward-only migrations, tracks them in `_migrations`
- One repository file per table under `packages/server/src/db/repositories/` with named functions, no classes
- Repository tests using an in-memory database (`:memory:`)

**Done when:** `pnpm --filter @vina/server test` covers every repository's happy path and the basic constraint paths (uniqueness, FK).

---

## Milestone 3 — Server skeleton

**Goal:** Fastify boots, opens SQLite, serves `/api/bootstrap` and `/api/system/status`, and handles a clean shutdown.

**Tasks.**

- `packages/server/src/main.ts` — entrypoint
- `packages/server/src/http/app.ts` — Fastify factory with bearer-token middleware (per `api-spec.md`)
- `packages/server/src/config.ts` — port, paths, log level via `env-paths` + env vars
- `packages/server/src/lib/logger.ts` — pino with redaction for keys (LLM and SerpAPI) and cookies
- Routes: `/api/bootstrap`, `/api/system/status`, `/api/system/pause`, `/api/system/resume`, `/api/system/reset`
- Status file write on startup, delete on shutdown
- Graceful shutdown handler per `backend-designer.md` §4
- Integration test: spin up the server, hit `/api/bootstrap`, assert the response shape

**Done when:** `node packages/server/dist/main.js` serves a response from `curl http://localhost:7341/api/bootstrap`.

---

## Milestone 4 — CLI

**Goal:** `vina start`, `vina stop`, `vina status` work end-to-end against the server skeleton.

**Tasks.**

- `packages/cli/src/bin.ts` and `commands/{start,stop,status,logs,reset,doctor}.ts` per `cli-spec.md`
- PID file handling and status file parsing
- Spawn the server as a detached child in production; foreground in dev (`VINA_DEV=1`)
- Browser opener via `open` package
- Smoke test: `vina start && curl /api/bootstrap && vina stop` in CI

**Done when:** `vina start` boots the server, opens the browser, and `vina status` reports the running daemon. `vina stop` terminates cleanly.

---

## Milestone 5 — Secrets vault

**Goal:** API keys (LLM and SerpAPI) can be stored and read encrypted.

**Tasks.**

- `packages/server/src/secrets/vault.ts` — AES-256-GCM with the master key from `keytar` if available, otherwise from a `0600` file
- `llm_providers` repository updated to encrypt on insert and decrypt on read
- `settings` repository updated to encrypt the SerpAPI key on insert and decrypt on read
- A "test connection" path for each provider kind (Anthropic, OpenAI, Ollama) that does a minimal completion call
- A "test connection" path for SerpAPI that does a minimal Google Jobs query

**Done when:** Inserting an LLM provider or SerpAPI key with a real value, then reading it back, returns the original plaintext. The on-disk row contains ciphertext only.

---

## Milestone 6 — REST routes for the basic resources

**Goal:** Profile, CVs, cover letters, search preferences, schedules, settings, sites, LLM providers — all CRUD endpoints land. Settings now includes SerpAPI key handling.

**Tasks.**

- One route file per resource under `packages/server/src/http/routes/` per `api-spec.md`
- Services where business logic lives — keep routes thin
- Multipart upload for CVs and cover letters; text extraction (PDF via `pdf-parse`, DOCX via `mammoth`) populates `extracted_text`
- `PATCH /api/settings` validates and stores the SerpAPI key encrypted; `DELETE /api/settings/serpapi-key` clears it
- `POST /api/sites/google/test` validates the stored SerpAPI key
- Tests: per-route happy path + the obvious error cases

**Done when:** Postman / curl can create a profile, upload a CV, configure an LLM provider and SerpAPI key, and read settings. Onboarding APIs are usable end-to-end (without a UI yet).

---

## Milestone 7 — Frontend skeleton and bootstrap flow

**Goal:** The React app loads, fetches `/api/bootstrap`, and routes between pages.

**Tasks.**

- `packages/web/` Vite + Tailwind + shadcn/ui scaffold
- `packages/web/src/theme/tokens.css` populated from `docs/theme.md`
- Tailwind config wired to read CSS variables
- Fonts self-hosted (`@fontsource/{fraunces,geist,jetbrains-mono}`)
- App shell: topbar, sidebar (including Ready to Apply nav item), layout per `frontend-designer.md` §3
- TanStack Query and Zustand wired
- API client with bearer token from `/api/bootstrap`
- Empty page components for Dashboard / Jobs / Applications / Ready to Apply / Alerts / Chat / Profile / Settings
- Production build outputs into `packages/server/public/`; server serves via `@fastify/static`

**Done when:** Running `vina start` opens a working app shell with the editorial theme applied, dark-mode toggle works, and routing between empty pages works.

---

## Milestone 8 — Onboarding wizard

**Goal:** A new user can complete onboarding from the UI, including configuring Google Jobs.

**Tasks.**

- Routes under `/onboarding/*` for each of the 10 steps in `frontend-designer.md` §6
- Forms wired to the existing API endpoints (Profile, LLM Provider, CV upload, Cover letter, Search preferences, Sources, Schedule, Mode)
- Provider validation call before allowing the user to advance from the LLM step
- Sources step handles all three sources: LinkedIn / Indeed (mocked logins for now), Google Jobs (SerpAPI key entry + validate)
- Progress is persisted; the user can drop out and resume

**LinkedIn / Indeed login is mocked here.** Real Playwright login lands in M11. SerpAPI configuration, however, is real because it requires no browser.

**Done when:** A new install completes onboarding and lands on a Dashboard with all configuration persisted, including a validated SerpAPI key if the user enabled Google Jobs.

---

## Milestone 9 — Orchestrator: provider abstraction and score graph

**Goal:** `runScoreJob({ job, profile, prefs }, model)` returns a structured `{ score, justification }`.

**Tasks.**

- `packages/orchestrator/src/providers/registry.ts` — `buildModel(cfg): BaseChatModel` for Anthropic / OpenAI / Ollama
- `packages/orchestrator/src/graphs/score-job.ts` — single-node graph with `withStructuredOutput`
- `packages/orchestrator/src/prompts/score.ts`
- Tests with a fake `BaseChatModel`
- Integration test (tagged `@slow`, opt-in) against a local Ollama

**Done when:** A unit test asserts a high score for a matching job and a low score for a non-matching one against fake responses, and the graph errors cleanly on invalid LLM output.

---

## Milestone 10 — Scheduler and queue

**Goal:** The scheduler enqueues `search` tasks per the user's cron schedule. The worker consumes them.

**Tasks.**

- `packages/server/src/scheduler/scheduler.ts` — registers `node-cron` jobs from the `schedules` table
- `packages/server/src/queue/queue.ts` — `p-queue` per kind, persisted to `task_queue`
- `packages/server/src/queue/runner.ts` — picks pending rows, dispatches by kind, handles retries with backoff
- A `search` task handler that, for now, just logs (real adapters land in M11–M12)
- A `score` task handler that calls `runScoreJob`
- WebSocket gateway emits `queue:updated` and `jobs:updated` events

**Done when:** Manually inserting a fake job triggers the score handler and updates the row's `match_score`. The Dashboard's "next run at" reflects the schedule.

---

## Milestone 11 — Browser automation: manager, login, LinkedIn search and apply-method detection

**Goal:** Vina can log into LinkedIn interactively, search listings, and classify each as auto or manual.

**Tasks.**

- `packages/automation/src/browser/manager.ts` — persistent context per site; headful/headless toggling
- `packages/automation/src/adapters/adapter.ts` — interface (including `detectApplyMethod`)
- `packages/automation/src/adapters/linkedin.ts` — login URL, login-success predicate, search iterator, listing detail, apply-method detection
- `packages/automation/src/detect/apply-method.ts` — generic helpers
- `packages/automation/src/lib/humanise.ts` — jittered timing helpers
- Server route `POST /api/sites/linkedin/login` launches the interactive flow; emits `site:login_status` over WS
- The `search` task handler now calls the LinkedIn adapter, writes raw listings to `jobs` with `apply_method` set, captures `external_apply_url` for manual ones, and enqueues `score` tasks
- E2E fixture: a tiny Fastify app under `tests/fixtures/sites/linkedin/` with stable selectors that mirror the LinkedIn DOM, including both Easy Apply and external-redirect listings

**Done when:** Onboarding's "Log in to LinkedIn" step actually opens a browser, the user logs in, the session is saved, and a manual "Search now" finds and stores listings with correct `apply_method` classification.

---

## Milestone 12 — Indeed adapter

**Goal:** Same as M11 but for Indeed, including apply-method detection.

**Tasks.**

- `packages/automation/src/adapters/indeed.ts`
- Fixture site under `tests/fixtures/sites/indeed/` with both Apply Now and external-redirect listings
- Adapter registered in the site registry
- Onboarding picks up Indeed automatically

**Done when:** Both browser-kind sites are searchable via the scheduler and via "Search now", with correct apply-method classification.

---

## Milestone 13 — Google Jobs source via SerpAPI

**Goal:** Vina discovers jobs from Google Jobs and stores them with `apply_method='manual'`.

**Tasks.**

- `packages/server/src/services/serpapi-service.ts` — Google Jobs client per `backend-designer.md` §2
- A `search` task handler dispatch that routes `site_id='google'` to the SerpAPI service rather than a Playwright adapter
- Listings inserted with `apply_method='manual'`, `external_apply_url` populated from `apply_options[0].link`, `original_source` from `via`
- A small fixture HTTP server returning canned SerpAPI responses for tests
- The Sources page in Settings shows Google Jobs status (enabled / valid key / last successful search)

**Done when:** With a valid SerpAPI key configured, `vina search-now` populates jobs from all three sources. Each Google Jobs entry has the correct `apply_method`, `external_apply_url`, and `original_source` populated.

---

## Milestone 14 — Tailor CV graph (and cover letter)

**Goal:** For a given job and source CV, produce a tailored DOCX. Same for cover letters.

**Tasks.**

- `packages/orchestrator/src/graphs/tailor-cv.ts` — structured-output prompt → renderer using `docx-js`
- `packages/orchestrator/src/graphs/tailor-cover-letter.ts` — same shape
- `packages/orchestrator/src/prompts/tailor.ts` and `tailor-cover-letter.ts` — explicit "do not invent" instructions, examples
- Tool kit methods `saveTailoredCv` and `saveTailoredCoverLetter` — server-side implementations write under `files/tailored/` and `files/tailored-cover-letters/`
- Server routes `GET /api/applications/:id/tailored-cv` and `GET /api/applications/:id/tailored-cover-letter` stream the DOCX

**Done when:** A fake application can be tailored end-to-end; the resulting DOCX opens in Word and has rephrased bullets without invented facts (verified against a few hand-checked fixtures).

---

## Milestone 15 — Apply graph and form walker (LinkedIn, auto-apply only)

**Goal:** End-to-end auto-apply works against the LinkedIn fixture for `apply_method='auto'` jobs.

**Tasks.**

- `packages/automation/src/forms/form-walker.ts` — generic enumeration and filling
- `packages/automation/src/forms/field-map.ts` — canonical keys with synonyms
- `packages/automation/src/detect/{captcha,session}.ts` — heuristics
- `packages/orchestrator/src/graphs/apply.ts` — the state graph from `langgraph-orchestrator.md` §5.4, with the defensive check that `apply_method === 'auto'`
- Tool kit fully implemented in the server, passed into graphs by the worker
- `apply` task handler: runs the apply graph, observes state transitions, writes `application_events`. Refuses to run for `apply_method='manual'` jobs (which should never be routed here)
- Resume logic: when an alert is resolved, the server re-enqueues the application

**Done when:** Against the LinkedIn fixture, an autonomous run picks a matched Easy Apply job, tailors the CV, fills the form, submits, and writes a `submitted` application with a complete event timeline. A second job with a missing field pauses, raises an alert, and resumes correctly when the user supplies the value.

---

## Milestone 16 — Prepare-manual-apply graph

**Goal:** Manual-apply jobs (Google Jobs and external-redirect LinkedIn / Indeed listings) get tailored CVs and cover letters and reach `ready_for_manual_apply`.

**Tasks.**

- `packages/orchestrator/src/graphs/prepare-manual-apply.ts` — the small graph from `langgraph-orchestrator.md` §5.5
- `prepare_manual_apply` task handler in the server — routes manual-apply jobs to this graph instead of the apply graph
- Server emits `application:ready_for_manual_apply` over WS when the graph completes
- Alert of kind `ready_for_manual_apply` is created with the application id, external apply URL, and tailored CV path in the payload

**Done when:** A Google Jobs entry passes the score threshold, gets tailored, and shows up as a `ready_for_manual_apply` application with both CV and cover letter ready. A LinkedIn external-redirect job goes through the same path.

---

## Milestone 17 — Apply graph for Indeed

**Goal:** Same as M15 but for Indeed.

**Tasks.**

- Indeed-specific selectors in `adapters/indeed.ts`
- Indeed fixture form covering the same shapes (text, select, file, multi-step)
- Verify all four mode-combinations (autonomous × supervised × auto-apply × review-first) work for Indeed Apply Now

**Done when:** Both browser-kind sites apply end-to-end against fixtures.

---

## Milestone 18 — Alerts UI

**Goal:** The Alerts tab from `frontend-designer.md` §7.5 is fully wired, including the new `ready_for_manual_apply` kind.

**Tasks.**

- `GET /api/alerts`, `POST /api/alerts/:id/resolve`, `POST /api/alerts/:id/dismiss` end-to-end
- WS `alert:created` / `alert:resolved` / `alert:dismissed` events
- Per-kind inline action UIs: missing-field input, CAPTCHA "I solved it", awaiting-approval CV preview, session-expired re-login button, ready-for-manual-apply action card (download / open / mark applied)
- Sidebar badge with action-required count

**Done when:** A user can resolve every kind of alert from the Alerts tab and see the corresponding application resume in real time, including marking manual-apply jobs as applied.

---

## Milestone 19 — Ready to Apply UI

**Goal:** The Ready to Apply page from `frontend-designer.md` §7.4 is fully wired.

**Tasks.**

- `/ready-to-apply` route with the card list, action buttons, and notes textarea
- `POST /api/applications/:id/mark-applied` endpoint and matching service logic — transitions to `applied_manually`, sets timestamps, auto-resolves the related alert
- Sidebar badge for ready count
- Dashboard preview card with top 3
- Empty state and skeleton

**Done when:** The user can open `/ready-to-apply`, download a tailored CV, click through to the external site, and mark the job as applied. The application moves to `applied_manually` and disappears from the page.

---

## Milestone 20 — Chatbot

**Goal:** A working conversational interface with persistent memory and tool use.

**Tasks.**

- `packages/orchestrator/src/graphs/chat.ts` — ReAct loop with the full tool kit
- `packages/orchestrator/src/memory/{chat-memory,summarisation}.ts`
- Server: `GET/POST /api/chat/messages`, WS streaming via `chat:token`
- Frontend: chat page and slide-over panel, streaming output, pinned alerts at the top (including `ready_for_manual_apply` cards)

**Done when:** "What have you applied to today?" returns an accurate count distinguishing auto-applied and manually-applied. "I have 8 years of Python experience" resolves a relevant open alert and saves the answer to `profile_answers`. "What's ready for me to apply to manually?" surfaces the ready list.

---

## Milestone 21 — Application detail and tailored-CV preview

**Goal:** The user can audit any application end to end, including manual-apply ones.

**Tasks.**

- Application detail page with tabs: Overview, Tailored CV (DOCX rendered via `mammoth`), Tailored cover letter (if any), Timeline, Source
- Reject-and-regenerate flow for review-first applications
- Retry flow for failed applications
- Manual-apply detail view shows the external link prominently and the mark-as-applied button

**Done when:** Every interaction path described in `frontend-designer.md` §7.3 works against a real application, for both auto and manual-apply.

---

## Milestone 22 — Polish, dashboards, settings

**Goal:** All non-essential UI surfaces land.

**Tasks.**

- Dashboard with stat cards (auto + manual splits), activity timeline, quick actions, ready-to-apply preview
- Settings page wiring all `settings` and `schedules` controls — including SerpAPI configuration and Google Jobs toggle
- Profile page with "Saved answers" management
- Empty states throughout
- Accessibility pass per `frontend-designer.md` §10

**Done when:** A new user can install, run `vina start`, complete onboarding, and have their first submitted application (auto) or first ready-to-apply (manual) within 30 minutes.

---

## Milestone 23 — Hardening

**Goal:** Edge cases, retries, and observability.

**Tasks.**

- Robust handling of LLM rate limits, network blips, and provider 5xx responses
- Robust handling of SerpAPI rate limits and key invalidation
- Application timeline shows screenshots on every failure (auto-apply only)
- Daily per-site application caps enforced
- `vina doctor` covers Playwright browser binaries, port reachability, disk space, and (if configured) SerpAPI key validity
- Pretty error messages everywhere — no raw stack traces in user-visible surfaces

**Done when:** Running Vina overnight against the fixtures with synthetic failures (random 429s, occasional CAPTCHAs, induced session expiry, simulated SerpAPI 429s) leaves the system in a clean state every morning.

---

## Cross-cutting concerns

These are not their own milestones but are expected to be tended to throughout:

- **Tests.** Every milestone lands with tests. No milestone is "done" without them
- **Logging.** Every new module logs at appropriate levels with the shared `pino` logger; sensitive values redacted (LLM keys, SerpAPI keys, browser cookies)
- **Docs.** If a milestone changes a behaviour described in `SPEC.md` or `docs/*`, update those files in the same change
- **Schema migrations.** Never edit a previous migration; always add a new one
- **No leaks.** API keys, browser cookies, and storage state never appear in logs, screenshots (without redaction), or error messages
