# Design Decisions

This file records the choices we made during design and the reasoning behind them. Decisions here should be respected by implementations. If a decision needs to be revisited, update this file (and the relevant spec) in the same change as the code.

Format: short ADRs. Each has a status, a context, the decision, and consequences.

---

## ADR-001: Distribute as an NPM package, not a desktop app

**Status:** Accepted.

**Context.** The target user is comfortable with a CLI. Building a desktop app (Electron, Tauri) means signing, notarising, auto-updates, and per-OS installers. An NPM package skips all of that. The user runs `npm install -g vina && vina start`, the daemon boots, the UI opens in their existing browser.

**Decision.** Ship as an NPM package. The CLI manages a Node.js daemon. The UI is served by that daemon to the user's default browser.

**Consequences.**

- Users need Node.js 20+ installed
- We don't bundle a browser runtime — Playwright handles its own
- Cross-platform support comes for free as long as Node and Playwright support the platform
- We commit to good CLI ergonomics (status, doctor, logs)

---

## ADR-002: Local-first, no Vina-hosted services

**Status:** Accepted.

**Context.** Job applications contain personally identifying data, login sessions, and access tokens for LLM providers. Storing any of that on a server we run creates liability we don't need.

**Decision.** Everything lives on the user's machine. No accounts. No telemetry. No sync. The only outbound network calls are to the LLM provider the user configured, to the job sites the user opted into, and to SerpAPI if Google Jobs is enabled.

**Consequences.**

- We do not need to support multi-tenancy, billing, or auth for a hosted service
- Users back up their own data via `vina export`
- Updates are user-driven (`npm i -g vina@latest`) — no remote rollout
- Privacy posture is easy to communicate

---

## ADR-003: Playwright over Puppeteer

**Status:** Accepted.

**Context.** We need to drive a real browser to interact with LinkedIn and Indeed. The two main options are Puppeteer (Chrome-only, mature) and Playwright (multi-browser, slightly newer API).

**Decision.** Use Playwright.

**Reasons.**

- First-class persistent contexts, which we need for session reuse
- Multi-browser support gives us future flexibility (some sites may behave better on Firefox or WebKit)
- Better cross-platform binary management
- Better trace and screenshot tooling for failure diagnostics

**Consequences.**

- Slightly larger install footprint
- We commit to the Playwright API surface — adapters are written against it directly

---

## ADR-004: SQLite over a containerised database

**Status:** Accepted.

**Context.** We need persistent storage for jobs, applications, alerts, settings, and a chat transcript. Options considered: SQLite (`better-sqlite3`), JSON files, Postgres in Docker, embedded LMDB.

**Decision.** SQLite via `better-sqlite3`. A single file under the user-data directory, WAL mode, hand-rolled SQL migrations.

**Reasons.**

- Zero install. No Docker dependency, no daemon to manage
- Strong query power for filters, scores, joins
- WAL mode handles our concurrency profile (one writer, many readers)
- Migrations are forward-only SQL files — easy to read, easy to test

**Consequences.**

- We forgo network-accessible storage; that aligns with ADR-002 anyway
- We must be careful with schema changes — write migrations, never edit existing ones
- All cross-table reads go through repository functions; no ORM

---

## ADR-005: LangGraph for orchestration

**Status:** Accepted.

**Context.** The application workflow is a state machine: search → score → tailor → review → apply → handle blocker → submitted. We considered:

1. Building tool-calling on top of the Anthropic SDK directly
2. LangChain agents
3. LangGraph state graphs
4. A bespoke FSM in TypeScript

**Decision.** LangGraph (`@langchain/langgraph`).

**Reasons.**

- Explicit nodes and edges map directly onto our flow
- Typed shared state per graph
- Provider-agnostic — switching between Anthropic, OpenAI, and Ollama is a config change
- Tool kit injection means the orchestrator package stays pure (no DB or browser imports)

**Consequences.**

- We accept the LangChain dependency surface
- Graphs are testable with a fake `BaseChatModel`
- Adding new tools means a single registration point

---

## ADR-006: One LLM provider for everything

**Status:** Accepted.

**Context.** We could let the user configure different providers for different jobs (e.g. fast cheap model for scoring, expensive model for tailoring, local model for chat). That's flexible and complicated. We could also force a single model across all uses.

**Decision.** A single active provider configured by the user. All graphs (score, tailor, apply, chat) use it. The user can switch the active provider at any time.

**Reasons.**

- Onboarding is simpler — one config screen, one validation call
- Costs are easier to reason about
- Quality is consistent across features
- Per-graph tuning is still possible via temperature and token-budget config without changing providers

**Consequences.**

- Users on a slow local Ollama feel it everywhere, not just in chat
- We can revisit per-graph providers later if telemetry-free signals tell us users want it

---

## ADR-007: Manual CAPTCHA solving only

**Status:** Accepted.

**Context.** LinkedIn and Indeed deploy CAPTCHAs. Options: ignore them and let the application fail, integrate a third-party solver (2Captcha, Anti-Captcha), or surface them to the user.

**Decision.** Detect CAPTCHAs, switch the browser to headful, bring the page to the front, create an alert ("CAPTCHA detected — please solve in the open browser window"), and pause that one application. The user solves it manually. Other applications continue.

**Reasons.**

- Third-party solvers violate the terms of service of the sites we're acting on
- They cost money and add a remote dependency
- Manual solving aligns with the principle that Vina acts on the user's behalf, not in spite of the sites it visits
- Most users hit CAPTCHAs rarely if they're using their real, established session

**Consequences.**

- We must reliably detect CAPTCHAs (false negatives are silent application failures)
- We need a clean "I solved it, continue" affordance in the UI
- Bot-detection avoidance becomes important — fewer triggered CAPTCHAs is the best mitigation

---

## ADR-008: Skip-and-resume, never block

**Status:** Accepted.

**Context.** When Vina hits a missing field, an unanswerable form question, a CAPTCHA, or a session expiry on application N, it has two choices: stop and wait for the user, or set N aside and try N+1.

**Decision.** Always set the blocked application aside, create an alert, and continue with the queue. The user resolves the alert later, which re-enqueues the application from the saved form state.

**Reasons.**

- A user running Vina overnight should wake to a queue of resolved-and-applied roles plus a smaller queue of "needs your input" — not a single stalled application that blocked everything
- It matches the user's mental model: Vina is a tireless assistant, not a single-threaded worker
- Throughput is higher

**Consequences.**

- Every blocking step in the apply graph must save enough state to resume
- The form-walker re-runs field enumeration on resume — it does not assume the page is the same
- The Alerts tab and chatbot need to be the obvious places the user goes to unblock things

---

## ADR-009: Operating mode and approval mode are orthogonal

**Status:** Accepted.

**Context.** The user can be in `autonomous` (Vina picks jobs to apply to) or `supervised` (user picks). Independently, each application can be `auto-apply` (submit without showing the tailored CV) or `review-first` (show the CV, wait for approval).

**Decision.** Treat these as two separate settings. Any combination is valid:

- Autonomous + auto-apply: full hands-off
- Autonomous + review-first: Vina picks; you approve each tailored CV
- Supervised + auto-apply: you pick; Vina submits without showing
- Supervised + review-first: you pick and you approve each CV

For manual-apply jobs (Google Jobs and external redirects), the approval setting is implicit — the user always sees the tailored CV before applying because they are the one applying.

**Reasons.**

- Real users want different combinations as their trust in the tool grows
- Forcing one knob to imply the other is the kind of design that bites you in the second week of use

**Consequences.**

- Two settings keys, two UI controls
- Tests must cover all four combinations for the auto-apply flow

---

## ADR-010: In-process worker for MVP

**Status:** Accepted.

**Context.** The application worker could be a separate Node process, communicating with the server via IPC, or it could be a `p-queue` inside the same process.

**Decision.** Keep it in-process for MVP.

**Reasons.**

- Installation and process management stay simple — one daemon, one PID, one log file
- Latency from HTTP requests is not a concern for a single-user local tool
- We can split it out later if scheduling work measurably blocks API responses

**Consequences.**

- A crash takes everything with it (offset by the queue being persisted to SQLite — work resumes on restart)
- Concurrency limits live in `p-queue` config, not in OS-level supervision

---

## ADR-011: Chatbot persists across sessions; profile answers are extracted

**Status:** Accepted.

**Context.** When the user answers "I have 8 years of Python experience" in the chatbot, that answer should not have to be re-supplied for the next application that asks the same question.

**Decision.** Two layers of memory.

1. The chatbot keeps a sliding window of the last 30 messages plus a rolling summary of older ones
2. When the user resolves a missing-field alert, the answer is also saved to `profile_answers` keyed by a canonical field key (e.g. `years_of_experience`). The form-walker checks this table before raising a new alert

**Reasons.**

- Users hate being asked the same thing twice
- Canonical keys make the answers structured and retrievable, not just a chat transcript

**Consequences.**

- The orchestrator must produce canonical keys when raising missing-field alerts (the `inspect_fields` LLM call does this)
- A "Saved answers" UI in Profile lets the user audit and edit these

---

## ADR-012: Headless by default, headful when needed

**Status:** Accepted.

**Context.** Headless browsers are faster and don't disrupt the user's screen. Headful browsers are necessary for CAPTCHA solving and interactive login.

**Decision.**

- Default: headless
- Switch to headful automatically for: interactive login, CAPTCHA solving
- Setting (`browser_headful`) forces headful for the entire session — useful for debugging

**Reasons.**

- The user shouldn't have a window pop up every time the scheduler ticks
- When the user _does_ need to interact, the window must be visible — not buried as a system-tray icon

**Consequences.**

- The browser manager must support switching modes mid-session (in practice we close and reopen the context)
- Headful runs leak the saved storage state via screenshots — we must redact carefully in failure logs

---

## ADR-013: No fingerprint masking, no anti-detection beyond legitimate session

**Status:** Accepted.

**Context.** There's a spectrum of bot-detection avoidance, from "none" to "full stealth-plugin masking". We have to pick a posture.

**Decision.** Use only legitimate techniques:

- Persistent contexts so we use the user's real session
- Realistic timing and humanised interactions
- The user's real timezone and locale
- Daily per-site application caps

We do **not**:

- Override `navigator.webdriver` or other fingerprinting hooks
- Use a stealth plugin
- Spoof user agents to misrepresent the browser

**Reasons.**

- Vina is acting on the user's behalf with their consent and their session — that's the legitimate frame, and it's what we keep
- Fingerprint masking is an arms race we don't want to be in
- Excessive masking is more likely to break things than help

**Consequences.**

- Some users will hit bot-detection more often than they would with a stealth setup
- Per-site caps are a feature, not a workaround

---

## ADR-014: TypeScript everywhere, monorepo via pnpm workspaces

**Status:** Accepted.

**Context.** We have a CLI, a server, an orchestrator, an automation layer, a React frontend, and a shared types package. They need to share zod schemas and types tightly.

**Decision.** TypeScript across all packages. pnpm workspaces with `packages/{cli,server,orchestrator,automation,web,shared}`.

**Reasons.**

- Shared zod schemas mean the server and frontend agree on request and response shapes by construction
- pnpm is fast and disk-efficient
- One install, one build pipeline, one place to bump versions

**Consequences.**

- We must keep the shared package small and stable
- The build order is important — `shared` first, then everything else

---

## ADR-015: Use SerpAPI for Google Jobs discovery

**Status:** Accepted.

**Context.** Google Jobs is a major job aggregator that pulls listings from many sources (company career pages, Greenhouse, Lever, Workday, Dice, niche boards, etc.). For users, it's often the broadest discovery surface available. The problem is direct scraping: Google deploys aggressive anti-bot measures, the DOM changes frequently, and listings link out to wildly heterogeneous external sites — automating submission across them is intractable.

We considered:

1. Roll our own Playwright-based Google Jobs scraper
2. Use SerpAPI's purpose-built Google Jobs endpoint
3. Use a third-party scraping service like Bright Data or Serply
4. Skip Google Jobs entirely

**Decision.** Use SerpAPI's Google Jobs endpoint. The user supplies their own SerpAPI key (free tier: 250 searches/month, paid tiers from there). Listings are discovery-only — Vina prepares tailored CVs and cover letters, then routes them through the manual-apply pipeline (ADR-016) so the user submits externally.

**Reasons.**

- Returns clean structured JSON (title, company, location, description, posting source, apply URL) — no DOM parsing
- Bypasses Google's anti-bot machinery entirely
- Free tier is enough for typical individual usage
- The user already has to provide credentials for an LLM provider; one more API key is a small marginal cost
- Avoids us being on the wrong side of an arms race with Google
- Keeps the architecture clean: Playwright is for sites we have a session on; SerpAPI is for discovery-only sources

**Consequences.**

- An additional outbound dependency (acknowledged in ADR-002 and the privacy posture)
- Users at high volume will exceed the free tier and need to pay SerpAPI
- We commit to SerpAPI's API stability; if they materially change pricing or shut down, we'd need to replace them
- The `automation` package does not own this source — it lives in `server/services/` because it's an HTTP integration, not browser automation

---

## ADR-016: Manual-apply pipeline for non-Easy Apply and Google Jobs listings

**Status:** Accepted.

**Context.** Many jobs cannot be auto-applied:

- Every Google Jobs listing redirects to an external site (the original poster's ATS or career page)
- A significant fraction of LinkedIn jobs are not Easy Apply — they bounce out to company career pages or third-party ATS systems
- Indeed has the same split between in-Indeed apply and external redirect

We have three options for these listings:

1. Skip them entirely
2. Try to automate the external ATS systems (Workday, Greenhouse, Lever, etc.)
3. Treat the tailored CV and cover letter as the deliverable, hand the user the external link, and let them apply manually

**Decision.** Option 3 — manual-apply pipeline.

For any job marked `apply_method = 'manual'`:

- Vina runs scoring as normal
- If selected (autonomous threshold or supervised user pick), Vina runs the tailor-cv graph
- The application is created in `ready_for_manual_apply` status with the tailored CV path, the optional tailored cover letter, and the captured `external_apply_url`
- The application surfaces in the "Ready to Apply" UI section and an alert is created
- The user clicks through the external link, applies on the external site, then clicks "Mark as applied" in Vina — status transitions to `applied_manually`

**Reasons.**

- The user still gets the highest-value automation: tailored CV matched to the role, ready to download
- Avoids the unbounded scope of automating arbitrary external ATS systems
- Mirrors how a competent recruiter assistant would work — they prepare materials, you submit
- The "mark as applied" step lets the user track their full pipeline (auto + manual) in one place
- Tailoring runs always reuse the same orchestrator graph; no per-source forks

**Consequences.**

- New application states (`ready_for_manual_apply`, `applied_manually`) and new UI surface
- LinkedIn and Indeed adapters must detect Easy Apply vs external during discovery — this routing decision is captured at the time the job is inserted
- The apply graph has an early exit for manual jobs — it runs `tailor-cv` and stops, never invoking browser tools
- The user is responsible for the final click; analytics about what they actually submitted are limited to whether they clicked "mark as applied"

## ADR-017: shadcn/ui for component primitives, themed against Vina tokens

**Status:** Accepted.

**Context.** The frontend needs a coherent component system covering buttons, cards, dialogs, dropdowns, toasts, tabs, and the dozens of other primitives implied by the M14–M22 milestones (Alerts UI, Ready-to-Apply cards, Application detail tabs, Settings forms, the chat slide-over, etc.). The realistic options:

1. **Hand-roll every primitive** — maximum control, but reinvents accessibility (focus trap, keyboard nav, ARIA roles) for every component
2. **Pick a styled component library** (MUI, Chakra, Mantine) — fastest, but their visual language fights the editorial Vina theme (warm neutrals, electric lime, Fraunces) and re-theming them is an uphill battle
3. **shadcn/ui** — copy-in components built on Radix primitives + Tailwind. Each component lands as source in `src/components/ui/` and is owned by us; the CLI just bootstraps it

**Decision.** Option 3, but variants are themed against Vina's existing design tokens (`--color-accent`, `--color-surface-*`, etc.) rather than shadcn's stock theme.

This means:

- `npx shadcn add <component>` works (config in `packages/web/components.json`)
- The `cn()` helper from `@/lib/utils` is the canonical class-name combinator
- Each generated component is **edited after generation** to swap shadcn's default colour names (`bg-primary`, `text-destructive`, etc.) for Vina tokens (`bg-accent`, `text-danger`, etc.). The first such component, `Button`, sets the pattern
- We do not adopt shadcn's HSL-channel CSS variable convention; Vina tokens stay as hex in `tokens.css` and Tailwind classes resolve them via `var(--color-*)`

**Reasons.**

- Radix gets us correct accessibility for free
- Tailwind composability matches the rest of our styling pipeline
- Source-in-repo means no surprise upgrades and no library version sprawl — components evolve with the codebase
- Theming via tokens means the editorial Vina look is preserved; shadcn is a primitive layer, not a visual layer

**Consequences.**

- Every shadcn component added must be re-themed against Vina tokens before merge — the default `bg-primary` is a stock indigo, not our electric lime. The `Button` in [src/components/ui/button.tsx](packages/web/src/components/ui/button.tsx) is the reference
- The web package gains five runtime deps (`class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `@radix-ui/react-slot`) and one dev dep (`tailwindcss-animate`); per-component Radix primitives (e.g. `@radix-ui/react-dialog`) get added as components are pulled in
- Future docs (especially `docs/frontend-designer.md`) should reference `components/ui/*` as the source for primitives rather than describing them inline

## ADR-018: Playwright stack pinning

**Status:** Accepted.

**Context.** M11 introduces real browser automation for the LinkedIn and Indeed adapters. Before writing any adapter code, five interlocking decisions need to be locked because almost every line of `packages/automation/` references one of them, and changing any later means revisiting selectors, fixture HTML, and detection-evasion behaviour.

The five decisions: (1) Playwright version pin, (2) browser channel (bundled Chromium vs. installed Chrome vs. exotic), (3) browser binary install location, (4) install UX (postinstall hook vs. lazy install vs. explicit step), (5) persistent context model (`launchPersistentContext` vs. `launch().newContext({ storageState })`).

**Decision.**

| Decision | Locked value | Rationale |
|---|---|---|
| Playwright version | `^1.x.0` (caret on minor) | Get patch-level fixes automatically; trust their semver. Run an integration test on every dependabot bump |
| Browser channel | `'chrome'` in production, with bundled-Chromium fallback when Chrome is missing | Real Chrome has fewer detection signals than Playwright's bundled headless-shell — LinkedIn flags the bundled build heavily. Tests pass `channel: undefined` explicitly to use bundled |
| Browser binary install location | Playwright default cache (`~/Library/Caches/ms-playwright/` on macOS, `~/.cache/ms-playwright/` on Linux, `%LOCALAPPDATA%\ms-playwright\` on Windows) | Shared with other Playwright projects on the user's machine; saves ~150 MB per project |
| Install UX | Lazy install on first `vina start`, with a `vina doctor` informational check | Default postinstall hooks fight corporate proxies and surprise users with 150 MB downloads during `npm i -g`. An explicit step adds friction. Lazy install matches modern CLI conventions (Vercel, Supabase) |
| Persistent context model | `chromium.launchPersistentContext(<dataDir>/sessions/<siteId>/, opts)` per site | Cookies + localStorage + IndexedDB + cache all persist together — matters for "still logged in tomorrow" UX. The `storageState.json` form is more fragile and doesn't capture everything |

**Reasons.**

- Channel `'chrome'` is the single biggest detection-quality lever and costs nothing at the code site (one option key)
- Default cache location keeps install-size tractable; per-app cache override is a one-line change in `launchSiteContext` if we ever need it for `vina reset` hygiene
- Lazy install means `npm i -g vina` followed by `vina start` works without an extra command, while CI environments that pre-install Chromium pay no overhead
- Persistent context per site mirrors how a human's browser actually works — one profile per site, never shared across services

**Consequences.**

- `packages/automation/src/browser/launch.ts` exposes a single `launchSiteContext({ siteId, dataDir, headless?, channel? })` helper; every M11 adapter and the `BrowserManager` go through it. No direct `chromium.launch*` calls anywhere else
- M11 Task 10 (`vina doctor`) checks for installed Chrome (channel preference) and bundled Chromium (fallback). Missing-binary remediation prints `pnpm exec playwright install chromium` for the bundled fallback path
- `tests/queue/handlers/search.test.ts` and adapter unit tests drive Playwright via the bundled Chromium (no Chrome dependency in CI). Production users without Chrome get a one-line warning and the bundled fallback
- M11 Task 7 (`/api/sites/linkedin/login`) launches headful by default for the interactive login. Production headless/headful is wired from `settings.browser_headful`
- This ADR locks the M10 deferred item from `docs/cli-spec.md` §14 ("Playwright browser binaries" check). Doctor's actual implementation lands in M11 Task 10 — the decision is captured here so the implementation is mechanical
- The `@playwright/test` package is a dev dep used only by the e2e harness (M11 Task 6) against the LinkedIn fixture site; unit tests stay on Vitest with `playwright` directly

## ADR-019: Skip Indeed as a source

**Status:** Accepted (2026-05-13).

**Context.** Original scope (`SPEC.md` §4 pre-ADR-019, `build-order.md` M12 + M17) included Indeed alongside LinkedIn as a second browser-kind source. As the LinkedIn end-to-end slice landed (2026-05-10), three things became clear:

1. **Indeed's anti-bot posture is more hostile to Playwright than LinkedIn's.** Repeat visits from the same persistent context trigger CAPTCHA gates and 403s faster than they do on LinkedIn. Maintaining a second browser-kind adapter against a more adversarial target was an open-ended cost.
2. **Coverage overlap with Google Jobs is high.** SerpAPI's Google Jobs endpoint aggregates listings posted to Indeed (Indeed is a major Google-Jobs feeder), so most Indeed listings reach the user via the Google Jobs path anyway — without a second browser session, without per-search CAPTCHA risk, and without a second selector-drift surface to babysit.
3. **The marginal Indeed-only listings aren't worth a second adapter's weight.** Two adapters means two selectors files, two fixture sites, two session-recovery flows, two doctor checks, two "Coming soon" tiles to keep current. The pattern is fine for browser-kind sources we genuinely need; it's not justified for a source that overlaps with one we already pay for.

We considered: (1) keep Indeed as planned, (2) cloud-browser the Indeed flow via Steel.dev or similar, (3) skip Indeed entirely. Option 2 doesn't fix the architectural cost (still a second adapter to maintain); it just trades local detection for cloud detection.

**Decision.** Skip Indeed entirely. Indeed is removed from the source list in `SPEC.md`. The two MVP sources are LinkedIn (browser-kind via Playwright) and Google Jobs (api-kind via SerpAPI). Coverage of Indeed-originated listings comes through the Google Jobs feeder, not through a dedicated adapter.

**Reasons.**

- Eliminates a second adapter's perpetual maintenance cost (selector drift, fixture upkeep, session recovery, doctor checks)
- Removes a CAPTCHA-prone path that would have been a recurring source of user-visible failures
- Concentrates browser-kind investment on LinkedIn, where Easy Apply (a future M15) gives the auto-apply pipeline its highest-value site
- Keeps the architectural pattern clean: two clearly distinct source kinds (browser, api), one source per kind in MVP
- Frees the next slice's effort for Google Jobs + the manual-apply pipeline (the two manual-apply paths now share the same UI surface)

**Consequences.**

- `packages/automation/src/adapters/indeed.ts` is **not built**. Build-order M12 and M17 are removed; downstream milestones renumber.
- The `sites` table still seeds an `indeed` row from migration 001 (removing it requires a forward-only migration that no caller needs). The row is dormant — no schedule references it, no UI surfaces it. A future migration can drop it if convenient; it's harmless to leave.
- The Settings → Sites tile lists LinkedIn and Google Jobs only. Indeed does **not** appear as "Coming soon" — it's not planned.
- Existing references to Indeed in `docs/architecture.md`, `docs/api-spec.md`, `docs/browser-automation.md`, `docs/frontend-designer.md`, and `docs/database-schema.md` are stale; they document historical scope. This ADR supersedes them. Per-doc sweeps to remove Indeed verbiage land in the Google Jobs slice (next phase A).
- If the cost calculus changes later (e.g. SerpAPI prices out, or a critical user segment is Indeed-heavy), reversing this ADR means writing the Indeed adapter and the Indeed fixture site. The `SiteAdapter` interface is already designed to accommodate it — the decision is operational, not architectural.
