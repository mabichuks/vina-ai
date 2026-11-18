# AGENTS.md

MetaSkills version: 1.1.0

This file is the entry point for every coding agent working on this repository. Read it
first, then read the docs in the order listed below.

## Project Overview

Vina is an AI-powered job application assistant. It is distributed as a single GitHub
Release tarball installed via a one-line installer (`curl … | bash` on Unix, `iwr … | iex`
on Windows), runs as a local background service, and exposes a web UI in the user's
browser. See `docs/installer.md` and ADR-020 for the distribution model. Vina is **not**
on the npm registry and is not an `npx` target.

Vina supports three job sources and two application workflows:

- **LinkedIn** and **Indeed** — driven via Playwright using the user's saved session.
  Listings that support direct submission (Easy Apply / Quick Apply) flow through the
  **auto-apply pipeline**: Vina tailors the CV, fills the form, and submits. Listings that
  redirect externally (most non-Easy-Apply jobs) flow through the **manual-apply pipeline**
  instead.
- **Google Jobs** — discovered via [SerpAPI](https://serpapi.com)'s Google Jobs endpoint (no
  Playwright). Every Google Jobs listing is manual-apply, since they all redirect to
  external ATS systems.

The manual-apply pipeline tailors the CV and cover letter, marks the application
`ready_for_manual_apply`, surfaces it in a "Ready to Apply" UI, and waits for the user to
apply externally and click "Mark as applied". This avoids the unbounded scope of automating
arbitrary external ATS systems while still giving the user the highest-value automation —
tailored materials matched to each role.

CV tailoring uses a configurable LLM (Anthropic, OpenAI, or local Ollama). The user can run
fully autonomously (Vina picks jobs to apply to or prepare) or supervised (user picks).
Independently, an "approval" setting controls whether tailored CVs are submitted directly or
shown for review first.

### Reading Order

Read these documents in this order before making non-trivial changes:

1. `SPEC.md` — product spec, scope, user stories
2. `docs/decisions.md` — architectural decisions and the reasoning behind them (read this
   before questioning a choice). Note ADR-015 (SerpAPI for Google Jobs), ADR-016
   (manual-apply pipeline) for the source-routing logic, ADR-020 (GitHub-Release tarball
   distribution, not npm), ADR-021 (opt-in stealth masking, supersedes ADR-013), ADR-022
   (managed CDP + snapshot/act interaction model), and ADR-024 (hybrid orchestration)
3. `docs/architecture.md` — system architecture and component boundaries
4. `docs/database-schema.md` — data model
5. `docs/backend-designer.md` — backend service design
6. `docs/opencode-orchestration.md` — OpenCode sessions, the `vina` tool contract, agents
   and skills
7. `docs/prompt-system.md` — prompt loader, frontmatter contract, override and CRUD model
8. `docs/skill-system.md` — capability-vs-procedure split, skill registry, chatbot authoring
9. `docs/browser-automation.md` — Playwright and site-adapter design (managed CDP +
   snapshot/act per ADR-022; opt-in stealth per ADR-021)
10. `docs/api-spec.md` — REST and WebSocket contract
11. `docs/frontend-designer.md` — UI structure and components
12. `docs/theme.md` — visual design system (tokens, typography, motion)
13. `docs/cli-spec.md` — CLI commands and process management
14. `docs/installer.md` — `install.sh` / `install.ps1` design, GitHub-Release tarball model,
    release pipeline
15. `docs/build-order.md` — recommended implementation sequence

`docs/langgraph-orchestrator.md` documents the orchestration layer ADR-024 retires. Read it
only when touching legacy code; do not extend it.

If a change touches multiple areas, re-read the relevant specs and keep them in sync. Specs
are the source of truth — code that disagrees with the spec is a bug. If a spec is wrong,
update the spec first, in the same change, with reasoning.

If you're starting from an empty repo, follow `docs/build-order.md`. The milestones are
sized to land cleanly with tests.

## Code Layout & Tech Stack

### Stack (locked)

- **Language**: TypeScript everywhere (backend, frontend, CLI, shared types)
- **Runtime**: Node.js >= 20 LTS
- **Package manager**: pnpm (monorepo with workspaces)
- **Backend HTTP**: Fastify + `@fastify/websocket`
- **Frontend**: React 18 + Vite + TailwindCSS + shadcn/ui
- **Frontend state**: TanStack Query for server state, Zustand for UI state
- **Database**: SQLite via `better-sqlite3`; forward-only hand-rolled SQL migration files in
  `packages/server/migrations/`
- **Browser automation**: Playwright (Chromium, persistent context for session reuse) —
  used for LinkedIn and Indeed only
- **Job discovery (Google Jobs)**: SerpAPI's Google Jobs endpoint — HTTP only, no browser.
  Lives in `packages/server/src/services/serpapi-service.ts` (not in the automation package)
- **AI orchestration**: OpenCode SDK (`@opencode/sdk`, or `@opencode/client` against a pinned
  binary) hosting agent sessions, plus a first-party plugin exposing Vina's `vina_*` tools.
  See ADR-024. LangGraph is frozen and removed in stage 3 — do not add graphs, nodes, or
  LangChain provider code
- **Scheduling**: `node-cron` for recurring searches; in-process queue for application work
- **Process management**: A small custom daemon spawned as a detached child process; see
  `docs/cli-spec.md` (we explicitly do not use PM2)
- **Logging**: `pino` with pretty printing in dev
- **Validation**: `zod` for runtime schemas; share types between front and back via a
  `packages/shared` workspace
- **Testing**: Vitest for unit, Playwright Test for end-to-end against fixture sites

Do not introduce alternative tools without updating this file and the relevant spec.

### Repository layout

```
vina/
├── AGENTS.md
├── SPEC.md
├── README.md
├── package.json                # workspace root
├── pnpm-workspace.yaml
├── docs/                       # all design specs
├── packages/
│   ├── cli/                    # `vina` binary, process management
│   ├── server/                 # Fastify app, services (incl. SerpAPI), scheduler, DB
│   ├── orchestrator/           # LangGraph graphs, tools, prompts (removed in stage 3)
│   ├── opencode-plugin/        # `vina_*` tools, agents, skills, MCP wiring (ADR-024)
│   ├── automation/             # Playwright adapters per browser-kind site
│   ├── web/                    # React frontend
│   └── shared/                 # zod schemas, shared types, constants
└── tests/
    ├── e2e/
    └── fixtures/
        └── sites/              # fixture HTML for LinkedIn / Indeed; fixture HTTP for SerpAPI
```

### Source kinds

The architecture has two clean source kinds: **browser-kind** sites (LinkedIn, Indeed) and
**api-kind** sources (Google Jobs via SerpAPI). New sources should fit one of these two
patterns. Adding Google Jobs is a good reference for adding future api-kind sources; adding
a new browser-kind site means writing a new `SiteAdapter` per `docs/browser-automation.md`.

### Coding standards

- **Strict TypeScript**: `"strict": true`, no `any` without a `// reason:` comment
- **No default exports** except for React page components and Vite entrypoints
- **File naming**: `kebab-case.ts` for modules, `PascalCase.tsx` for React components
- **Imports**: absolute imports via `tsconfig` paths (e.g. `@vina/shared`). Do **not** set
  `baseUrl` — TypeScript 6 deprecates it. Declare `paths` standalone with entries relative to
  the tsconfig file (e.g. `"@/*": ["./src/*"]`). When adding a path alias to a package, mirror
  it in that package's bundler config (Vite `resolve.alias`, etc.) so runtime resolution
  matches
- **Formatting**: Prettier; lint with ESLint (`@typescript-eslint`, `eslint-plugin-react`)
- **Errors**: Throw typed errors that extend a base `VinaError` class. Never throw bare
  strings
- **Async**: Always use async/await. No floating promises — enable the lint rule
- **Logging**: Use the shared `logger` from `@vina/shared`. Never `console.log` in committed
  code. Redact LLM keys, SerpAPI keys, and browser cookies in log output
- **Comments**: Comment _why_, not _what_. Keep them sparse and current

## Build & Validation

```bash
pnpm install
pnpm dev        # runs server + web in parallel via concurrently
pnpm test
pnpm lint
pnpm build
```

The `vina` CLI is linked locally during development:

```bash
pnpm --filter @vina/cli link --global
vina start
```

**DB tripwire files** — changes here require live-database integration tests before a PR is
opened or merged:

- `packages/server/migrations/**`
- `packages/server/src/db/client.ts`
- `packages/server/src/db/repositories/**`

**Commit message convention**: Conventional Commits, scoped by package
(`feat(server):`, `fix(automation):`, `docs(spec):`). Imperative subject, 72 characters or
fewer.

## Project Board

`none`.

Issues carry a label and milestone; there is no GitHub Project. Per `issue-plan`, `board:
none` still requires one `<!-- plan-ledger -->` comment and the claim/resume rules — it only
skips board reads and transitions. Do not add a GitHub Project without recording the change
here first.

## Repositories

- **App repo**: `mabichuks/vina-ai`
- **Issue template**: `.github/ISSUE_TEMPLATE/issue.md`
- **Deployment repo**: none. Releases are tarballs published from the app repo; see
  `docs/installer.md`.

## Environments

`none`. Vina is a local desktop-class application with no staging or production deployment.

- **QA target**: the locally running app (`pnpm dev`, or `vina start` once linked), on the
  port the process reports. Use `127.0.0.1`, never `localhost`, when a container is involved.
- **Fixtures**: `tests/fixtures/sites/` for browser flows and fixture HTTP for SerpAPI.

Never invent an environment URL. If a task needs one, stop and ask.

## Branch Map

| Fact                    | Value                                                                        |
| ----------------------- | ---------------------------------------------------------------------------- |
| Base branch             | `main` (never assume anything else; see the current history)                 |
| Work branches           | `issue-<number>-<short-slug>`, created by `issue-implement` in `.worktrees/` |
| CI workflow             | `.github/workflows/ci.yml`, on pushes and pull requests to `main`, Node 20   |
| Integration auto-deploy | No. Nothing deploys; releases are tagged manually                            |

## Agent Login

There is no hosted instance to sign in to, so `qa` runs against the local dev server.

- LinkedIn and Indeed sessions belong to the **user**, in a managed Playwright profile at
  `<dataDir>/sessions/<siteId>/` (see `docs/backend-designer.md`). Agents never drive those
  profiles for QA, copy cookies between browsers, or handle passwords.
- Local QA starts from a clean profile and fixture sites. If a flow needs a real signed-in
  session, stop and ask the user to sign in.
- Never create an account, accept terms, or check an attestation.
- Forbidden in issues, comments, transcripts, and logs: cookies, session tokens, API keys,
  profile contents.

## Review Notes

Layer Vina-specific checks from `docs/agents/review-checklist.md` over the shared
`code-review/checklist.md`. The shared file is stack-neutral; the Vina file carries the
idioms, boundaries, and extra checks.

**Critical flows** — a bug in any of these always counts as Impact for `issue-diagnose`:

- The Easy Apply submit path and `checkEasyApplyGate` (ADR-023)
- Credential storage, decryption, and redaction in logs
- Browser session and profile isolation between sites and users
- The manual-apply status transition that ends at `ready_for_manual_apply`

**Precedence between docs and the ledger.** An ADR or spec is the durable design. The plan
ledger is this issue's execution plan. If a ledger and an ADR disagree, the ADR wins and the
ledger is wrong. A decision that changes an ADR is a `## Blockers` item until the ADR edit
ships in the same PR.

**Paths.** Agent-facing detail lives in `docs/agents/`, lowercase, so macOS and Linux agree.

## Agent Guardrails

**Should:**

- Keep changes scoped. Touch one package at a time when possible
- Update or add specs when behaviour changes
- Add or update tests for any new logic
- Run `pnpm test` and `pnpm lint` before declaring work done

**Should not:**

- Add a new dependency without justifying it in the PR description
- Bypass the orchestrator to call LLMs directly from `server` or `web`
- Add a LangGraph graph, node, prompt module, or LangChain provider — the layer is frozen
  (ADR-024). New behaviour is a `vina_*` tool plus a skill
- Click submit anywhere except `vina_easy_apply`, or let an agent type into a LinkedIn Easy
  Apply form
- Hard-code site-specific selectors anywhere outside `packages/automation`
- Put the SerpAPI client in `packages/automation` — it's HTTP-only and belongs in
  `packages/server/src/services/`
- Try to automate external ATS systems (Workday, Greenhouse, etc.) — those route through the
  manual-apply pipeline by design (see `docs/decisions.md` ADR-016)
- Store API keys, cookies, or other secrets in plaintext logs
- Push to remotes or open PRs without being asked

## Security and Privacy Posture

Vina runs entirely on the user's machine. The user's CV, cover letter, API keys (LLM and
SerpAPI), browser cookies, and application history live in a single SQLite database under
the OS user-data directory (see `docs/backend-designer.md` for paths). Nothing is sent
anywhere except:

1. The configured LLM provider (when invoked)
2. The job sites the user has opted into (LinkedIn, Indeed)
3. SerpAPI (only if the user enabled Google Jobs and supplied a SerpAPI key)

Treat the database as containing PII at all times.
