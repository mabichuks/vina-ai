# Build Order

A suggested sequence for implementing Vina from an empty repository to a working MVP. Each milestone is small enough to land cleanly, with tests, before moving on.

This is a recommendation, not a contract. If a milestone's scope changes, update this file in the same change.

---

## Current status (2026-05-13)

The milestones below were planned before the LinkedIn end-to-end slice landed and ADR-019 was accepted. They remain as the long-form reference, but the active sequence is now:

| State | Milestones |
|---|---|
| **Shipped** | M0 – M10 in their original form; M11 in a form that overlaps with the LinkedIn end-to-end slice (see `docs/superpowers/specs/2026-05-04-linkedin-end-to-end-slice-design.md`, marked Implemented 2026-05-10) |
| **Skipped (ADR-019)** | ~~M12 (Indeed adapter)~~, ~~M17 (Apply graph for Indeed)~~. Removed from scope. |
| **Active queue** | **Phase A — Google Jobs via SerpAPI.** Replaces and supersedes the original M13. Spec: `docs/superpowers/specs/2026-05-13-google-jobs-source-design.md`. Plan: `docs/superpowers/plans/2026-05-13-google-jobs-source.md`. |
| | **Phase B — Manual-apply pipeline.** Wakes the dormant tailor-cv / tailor-cover-letter / prepare-manual-apply graphs and adds the Ready-to-Apply surface. Folds in the original M14, M16, and M19. Spec: `docs/superpowers/specs/2026-05-13-manual-apply-pipeline-design.md`. Plan: `docs/superpowers/plans/2026-05-13-manual-apply-pipeline.md`. |
| **Deferred indefinitely** | M15 — Apply graph and form-walker (LinkedIn Easy Apply auto-submit). Out of active queue; logged in `SPEC.md` §12. The manual-apply pipeline covers Easy Apply listings via Prepare materials, so auto-submit is no longer load-bearing. Reversing the deferral means writing the apply graph + LinkedIn form walker. |
| **Unchanged downstream** | M18 (Alerts UI — partially shipped by the LinkedIn slice, balance lands during Phase B), M20 (Chatbot), M21 (Application detail), M22 (Polish, dashboards), M23 (Hardening) |
| **Pre-release** | **M24 — Installer & release pipeline** (ADR-020). One-line `install.sh` / `install.ps1` against GitHub Release tarballs; tag-push CI to produce the tarball. Design: `docs/installer.md`. Sized small (~2–3 days) and runs after M23, before any public release. |

The milestone sections below remain as written. Where a milestone is superseded by a Phase A/B/C above, a one-line annotation at the top of the milestone records the supersession.

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

- `packages/server/src/scheduler/scheduler.ts` — registers `node-cron` jobs from the `schedules` table; on fire, enqueues a `search` task per enabled site, persists `last_run_at`/`next_run_at`, and pokes the worker. Live refresh on schedule mutation is deferred — see `packages/server/src/scheduler/scheduler.ts` top-of-file
- `packages/server/src/scheduler/cron.ts` — pure `nextRunAt(expr, from?)` helper using `cron-parser`, reused by route handlers
- `packages/server/src/queue/worker.ts` — combined queue + runner: poll loop on `task_queue`, `p-queue` per `TaskKind` for in-memory concurrency, retry-with-backoff (default 30/60/120s, overrideable for tests). Lifecycle (`start/poke/stop`) integrates with daemon shutdown
- `packages/server/src/queue/concurrency.ts` — `DEFAULT_CONCURRENCY` per kind
- `packages/server/src/queue/handlers/search.ts` — M10 stub that synthesises a job; replaced by real adapters in M11–M13
- `packages/server/src/queue/handlers/score.ts` — calls orchestrator's `runScoreJob`, persists `match_score` + `match_justification` atomically, transitions status to `scored`
- `packages/server/src/events/bus.ts` — typed in-process event bus consumed by the WS gateway
- WebSocket gateway emits `queue:updated` and `jobs:updated` events through the bus

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

**Status:** **Skipped per ADR-019** (2026-05-13). Section retained for historical context only — do not implement.

**Goal:** Same as M11 but for Indeed, including apply-method detection.

**Tasks.**

- `packages/automation/src/adapters/indeed.ts`
- Fixture site under `tests/fixtures/sites/indeed/` with both Apply Now and external-redirect listings
- Adapter registered in the site registry
- Onboarding picks up Indeed automatically

**Done when:** Both browser-kind sites are searchable via the scheduler and via "Search now", with correct apply-method classification.

---

## Milestone 13 — Google Jobs source via SerpAPI

**Status:** Superseded by **Phase A** (`docs/superpowers/specs/2026-05-13-google-jobs-source-design.md`). Phase A absorbs this milestone and refines its scope against the current codebase.

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

**Status:** Folded into **Phase B** (`docs/superpowers/specs/2026-05-13-manual-apply-pipeline-design.md`). Phase B bundles M14, M16, and M19 into one slice since they all serve the same manual-apply surface.

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

**Status:** **Deferred indefinitely** (2026-05-17). Out of the active queue. The manual-apply pipeline (Phase B, shipped) covers Easy Apply listings via Prepare materials → tailored CV → user submits, so auto-submit is no longer load-bearing. The tradeoff was: auto-submit adds detection risk on LinkedIn (our highest-value session to preserve) for a marginal time saving over an already-streamlined manual flow. Logged in `SPEC.md` §12. Reversing this milestone means writing the apply graph and the LinkedIn form walker; the orchestrator and adapter interfaces are already shaped to accommodate it.

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

**Status:** Folded into **Phase B**. See M14 supersession note.

**Goal:** Manual-apply jobs (Google Jobs and external-redirect LinkedIn listings) get tailored CVs and cover letters and reach `ready_for_manual_apply`.

**Tasks.**

- `packages/orchestrator/src/graphs/prepare-manual-apply.ts` — the small graph from `langgraph-orchestrator.md` §5.5
- `prepare_manual_apply` task handler in the server — routes manual-apply jobs to this graph instead of the apply graph
- Server emits `application:ready_for_manual_apply` over WS when the graph completes
- Alert of kind `ready_for_manual_apply` is created with the application id, external apply URL, and tailored CV path in the payload

**Done when:** A Google Jobs entry passes the score threshold, gets tailored, and shows up as a `ready_for_manual_apply` application with both CV and cover letter ready. A LinkedIn external-redirect job goes through the same path.

---

## Milestone 17 — Apply graph for Indeed

**Status:** **Skipped per ADR-019** (2026-05-13). Section retained for historical context only — do not implement.

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

**Status:** Folded into **Phase B**. See M14 supersession note.

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

## Milestone 24 — Installer and release pipeline

**Goal:** Users install Vina with one command on macOS, Linux, WSL, and Windows; a tag push produces a downloadable release.

Full design lives in `docs/installer.md`. The model is GitHub Release tarball + one-line installer (ADR-020), not npm.

**Tasks.**

- `scripts/install.sh` — bash installer per `docs/installer.md` §3 (Node bootstrap, pnpm via Corepack, tarball download, `pnpm install --prod --frozen-lockfile`, Playwright Chromium, wrapper into `~/.local/bin`, atomic `current` symlink, PATH housekeeping, native-build-tools retry on better-sqlite3 failure, `--dry-run`, `--version`, `--no-onboard`, `--no-playwright`, `--force`)
- `scripts/install.ps1` — PowerShell installer per `docs/installer.md` §4 (winget/choco/scoop bootstrap, same flow on Windows, junction instead of symlink for `current`, `vina.cmd` wrapper)
- `.github/workflows/release.yml` — on `push: tags: ['v*']`, builds the monorepo, packs `vina-<X.Y.Z>.tar.gz` (prebuilt `dist/` per workspace + lockfile + migrations, no `node_modules` / source / tests), publishes the tarball plus the two installer scripts as GitHub Release assets
- Hosting: `vina.ai/install.sh` and `vina.ai/install.ps1` served as plain text, TLS 1.2+, `Cache-Control: max-age=300`, backed by a static host we control. Both scripts honour the `VINA_REPO` env var as an escape hatch for testing forks
- `vina doctor` prints `INSTALLER_VERSION` so bug reports identify which installer the user ran
- Cross-distro smoke tests in Docker (Ubuntu, Alpine, Fedora) and a fresh Windows Sandbox session per `docs/installer.md` §8 — run before every release

**Done when:**

- A clean Ubuntu container, a clean Alpine container, a clean Fedora container, a clean macOS machine, and a fresh Windows VM each go from zero to `vina --version` returning the released tag with the documented one-liner
- Re-running the installer is a no-op (prints "already at vX.Y.Z"); `--force` reinstalls cleanly; `--version v<older>` downgrades cleanly
- `--dry-run` exits 0 with no filesystem changes; `--no-playwright` finishes without Chromium and `vina doctor` flags the missing browser with an actionable hint
- Tag push to `main` produces exactly one tarball + two installer-script assets, with the asset filename matching `vina-<X.Y.Z>.tar.gz`
- README's install section is the one-liner — `npm`, `npx`, and `pnpm` are absent from user-facing copy outside the explicit dev-setup section

## Milestone 25 — Managed CDP, snapshot/act, prompts → MD, skill system

**Goal:** Replace the selector-based automation transport with a managed CDP transport + snapshot/ref primitive (ADR-022); add opt-in stealth masking (ADR-021); move every prompt out of TypeScript into editable `.md` files; ship the on-demand skill system with seven starter skills and a chatbot authoring flow.

Five connected workstreams, shipped as separate green-before-the-next changes:

1. **ADRs + settings schema.** Apply ADR-013 status change and append ADR-021 + ADR-022 to `docs/decisions.md` (done). In `packages/shared`: add `browser_stealth: boolean` (default `false`) to the `Settings` zod schema and inferred type, with a round-trip fixture test. Update `docs/database-schema.md` settings notes and `docs/api-spec.md` if settings are exposed there. Done when: schemas compile, fixture test passes, no behaviour change yet.

2. **Managed CDP transport (no interaction-model change yet).** Replace `launchPersistentContext` with launch-Chromium-with-loopback-debug-port + `chromium.connectOverCDP`, keeping the same persistent `userDataDir`. Bind `--remote-debugging-address=127.0.0.1`; never `0.0.0.0`. Add `browser/cdp.ts`; keep `BrowserManager`'s public interface unchanged. Implement `browser/stealth.ts` as a no-op when `browser_stealth=false`, returning masking args/hooks only when `true`. Load any stealth dependency lazily/conditionally so the default install is unaffected. Update `browser-automation.md` §2 and §10. Done when: existing E2E fixtures pass unchanged through the CDP transport; `stealth.ts` unit tests cover both states; loopback binding asserted.

3. **Snapshot/ref primitive.** Add `snapshot/snapshot.ts` (accessibility tree → `UiTree`) and `snapshot/refs.ts` (ref allocation + label-based re-resolution). Types per `browser-automation.md` §3. Extend `SiteAdapter` with `snapshot()` and ref-based `act()`; add `ref` to `FormField` with `selector?` retained as fallback. Done when: snapshot/ref unit tests pass against fixture pages; adapters compile with the new interface.

4. **Deterministic-first walker + stale-ref recovery.** Rework `forms/form-walker.ts` to enumerate via snapshot, resolve values deterministically (profile → profile_answers → CV), mark `unknown` otherwise, re-snapshot after each step, and recover a stale ref exactly once before failing. Keep the LLM strictly as the fallback for `unknown` fields / unexpected states, one decision per call, within the apply token budget. Done when: fixture E2E covers a full Easy Apply (zero LLM calls), a missing-field pause/alert/resume, a multi-step form, and a one-shot stale-ref recovery.

5. **Prompts → Markdown.** Full design in `docs/prompt-system.md`. Migration order:
   1. Create `prompts/*.md` defaults (verbatim copies).
   2. Add loader + frontmatter schema + tests proving byte-identical render.
   3. Switch each graph to the loader, one at a time, running the identity test.
   4. Add server REST + ToolKit methods + validation.
   5. Wire chatbot tools + the `prompt-editing` skill + guardrails.
   6. Add the Settings → Prompts UI last.
   Mark `apply` and `system-base` `editable_by_user: false`. Keep the no-fabrication sentinel check. Done when: all graphs render from `.md`; identity tests pass; prompt CRUD + ToolKit methods + validation in place; Settings → Prompts UI works.

6. **Skill system + `browser-apply`.** Full design in `docs/skill-system.md`. Build order:
   1. Registry + frontmatter schema + loader, with the seven starter skills as read-only defaults. Inject `index()` into graphs.
   2. `loadSkill` tool + pre-load `browser-apply` in the apply graph.
   3. Server REST + ToolKit methods + guardrails.
   4. Chatbot authoring procedure + Settings → Skills UI.
   Wire chatbot prompt/skill tools with the guarded propose-then-confirm flow and the server-enforced guardrails (editable flags, capability allowlist clamp, safety-skill protection). Done when: registry tests pass (override-wins, lazy body, capability clamp); apply graph loads the skill; a chatbot preference produces a *proposed* edit and writes only after confirmation.

**Cross-cutting rules.**

- Keep ADR-007 (manual CAPTCHA only) intact — do not add any solver.
- Keep ADR-002 (local-first) intact — CDP port loopback-only; nothing leaves the machine.
- Respect token budgets in `langgraph-orchestrator.md` §8 — the LLM fallback and any prompt/skill bodies must not blow the apply cap.
- Update every spec touched in the same change; code that disagrees with a spec is a bug.
- Real-Chrome attach is out of scope (ADR-022) — do not implement it.

**Acceptance (end state).** A standard LinkedIn Easy Apply runs end to end with no LLM calls in the fill loop, surviving DOM/class-name churn via refs; unknown fields fall back to a single LLM decision; CAPTCHA/session/missing-field escalate as before; prompts and skills are editable markdown the chatbot can update on request with confirmation; and stealth masking is available but off unless the user enables `browser_stealth`.

---

## Cross-cutting concerns

These are not their own milestones but are expected to be tended to throughout:

- **Tests.** Every milestone lands with tests. No milestone is "done" without them
- **Logging.** Every new module logs at appropriate levels with the shared `pino` logger; sensitive values redacted (LLM keys, SerpAPI keys, browser cookies)
- **Docs.** If a milestone changes a behaviour described in `SPEC.md` or `docs/*`, update those files in the same change
- **Schema migrations.** Never edit a previous migration; always add a new one
- **No leaks.** API keys, browser cookies, and storage state never appear in logs, screenshots (without redaction), or error messages
