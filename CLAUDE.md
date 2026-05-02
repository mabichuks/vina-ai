# CLAUDE.md

This file is the entry point for Claude Code working on this repository. Read it first, then read the docs in the order listed below.

## Project: Vina

Vina is an AI-powered job application assistant. It is distributed as an NPM package, runs as a local background service, and exposes a web UI in the user's browser.

Vina supports three job sources and two application workflows:

- **LinkedIn** and **Indeed** — driven via Playwright using the user's saved session. Listings that support direct submission (Easy Apply / Quick Apply) flow through the **auto-apply pipeline**: Vina tailors the CV, fills the form, and submits. Listings that redirect externally (most non-Easy-Apply jobs) flow through the **manual-apply pipeline** instead.
- **Google Jobs** — discovered via [SerpAPI](https://serpapi.com)'s Google Jobs endpoint (no Playwright). Every Google Jobs listing is manual-apply, since they all redirect to external ATS systems.

The manual-apply pipeline tailors the CV and cover letter, marks the application `ready_for_manual_apply`, surfaces it in a "Ready to Apply" UI, and waits for the user to apply externally and click "Mark as applied". This avoids the unbounded scope of automating arbitrary external ATS systems while still giving the user the highest-value automation — tailored materials matched to each role.

CV tailoring uses a configurable LLM (Anthropic, OpenAI, or local Ollama). The user can run fully autonomously (Vina picks jobs to apply to or prepare) or supervised (user picks). Independently, an "approval" setting controls whether tailored CVs are submitted directly or shown for review first.

## Reading Order

Read these documents in this order before making non-trivial changes:

1. `SPEC.md` — product spec, scope, user stories
2. `docs/decisions.md` — architectural decisions and the reasoning behind them (read this before questioning a choice). Note ADR-015 (SerpAPI for Google Jobs) and ADR-016 (manual-apply pipeline) for the source-routing logic
3. `docs/architecture.md` — system architecture and component boundaries
4. `docs/database-schema.md` — data model
5. `docs/backend-designer.md` — backend service design
6. `docs/langgraph-orchestrator.md` — AI workflow and tool definitions
7. `docs/browser-automation.md` — Playwright and site-adapter design
8. `docs/api-spec.md` — REST and WebSocket contract
9. `docs/frontend-designer.md` — UI structure and components
10. `docs/theme.md` — visual design system (tokens, typography, motion)
11. `docs/cli-spec.md` — CLI commands and process management
12. `docs/build-order.md` — recommended implementation sequence

If a change touches multiple areas, re-read the relevant specs and keep them in sync. Specs are the source of truth — code that disagrees with the spec is a bug. If a spec is wrong, update the spec first, in the same change, with reasoning.

If you're starting from an empty repo, follow `docs/build-order.md`. The milestones are sized to land cleanly with tests.

## Tech Stack (Locked)

- **Language**: TypeScript everywhere (backend, frontend, CLI, shared types)
- **Runtime**: Node.js >= 20 LTS
- **Package manager**: pnpm (monorepo with workspaces)
- **Backend HTTP**: Fastify + `@fastify/websocket`
- **Frontend**: React 18 + Vite + TailwindCSS + shadcn/ui
- **Frontend state**: TanStack Query for server state, Zustand for UI state
- **Database**: SQLite via `better-sqlite3`; forward-only hand-rolled SQL migration files in `packages/server/migrations/`
- **Browser automation**: Playwright (Chromium, persistent context for session reuse) — used for LinkedIn and Indeed only
- **Job discovery (Google Jobs)**: SerpAPI's Google Jobs endpoint — HTTP only, no browser. Lives in `packages/server/src/services/serpapi-service.ts` (not in the automation package)
- **AI orchestration**: LangGraph (`@langchain/langgraph`) + LangChain provider packages for Anthropic, OpenAI, Ollama
- **Scheduling**: `node-cron` for recurring searches; in-process queue for application work
- **Process management**: A small custom daemon spawned as a detached child process; see `docs/cli-spec.md` (we explicitly do not use PM2)
- **Logging**: `pino` with pretty printing in dev
- **Validation**: `zod` for runtime schemas; share types between front and back via a `packages/shared` workspace
- **Testing**: Vitest for unit, Playwright Test for end-to-end against fixture sites

Do not introduce alternative tools without updating this file and the relevant spec.

The architecture has two clean source kinds: **browser-kind** sites (LinkedIn, Indeed) and **api-kind** sources (Google Jobs via SerpAPI). New sources should fit one of these two patterns. Adding Google Jobs is a good reference for adding future api-kind sources; adding a new browser-kind site means writing a new `SiteAdapter` per `docs/browser-automation.md`.

## Repository Layout

```
vina/
├── CLAUDE.md
├── SPEC.md
├── README.md
├── package.json                # workspace root
├── pnpm-workspace.yaml
├── docs/                       # all design specs
├── packages/
│   ├── cli/                    # `vina` binary, process management
│   ├── server/                 # Fastify app, services (incl. SerpAPI), scheduler, DB
│   ├── orchestrator/           # LangGraph graphs, tools, prompts
│   ├── automation/             # Playwright adapters per browser-kind site
│   ├── web/                    # React frontend
│   └── shared/                 # zod schemas, shared types, constants
└── tests/
    ├── e2e/
    └── fixtures/
        └── sites/              # fixture HTML for LinkedIn / Indeed; fixture HTTP for SerpAPI
```

## Coding Standards

- **Strict TypeScript**: `"strict": true`, no `any` without a `// reason:` comment
- **No default exports** except for React page components and Vite entrypoints
- **File naming**: `kebab-case.ts` for modules, `PascalCase.tsx` for React components
- **Imports**: absolute imports via `tsconfig` paths (e.g. `@vina/shared`)
- **Formatting**: Prettier; lint with ESLint (`@typescript-eslint`, `eslint-plugin-react`)
- **Errors**: Throw typed errors that extend a base `VinaError` class. Never throw bare strings
- **Async**: Always use async/await. No floating promises — enable the lint rule
- **Logging**: Use the shared `logger` from `@vina/shared`. Never `console.log` in committed code. Redact LLM keys, SerpAPI keys, and browser cookies in log output
- **Comments**: Comment _why_, not _what_. Keep them sparse and current

## Commit Conventions

Conventional Commits. Scope by package:

- `feat(server): add /jobs endpoint`
- `feat(server): wire SerpAPI Google Jobs source`
- `fix(automation): handle expired LinkedIn session`
- `docs(spec): clarify chatbot memory scope`

## Local Development

```bash
pnpm install
pnpm dev        # runs server + web in parallel via turbo or concurrently
pnpm test
pnpm build
```

The `vina` CLI is linked locally during development:

```bash
pnpm --filter @vina/cli link --global
vina start
```

## What Claude Code Should and Should Not Do

**Should:**

- Keep changes scoped. Touch one package at a time when possible
- Update or add specs when behaviour changes
- Add or update tests for any new logic
- Run `pnpm test` and `pnpm lint` before declaring work done

**Should not:**

- Add a new dependency without justifying it in the PR description
- Bypass the orchestrator to call LLMs directly from `server` or `web`
- Hard-code site-specific selectors anywhere outside `packages/automation`
- Put the SerpAPI client in `packages/automation` — it's HTTP-only and belongs in `packages/server/src/services/`
- Try to automate external ATS systems (Workday, Greenhouse, etc.) — those route through the manual-apply pipeline by design (see `docs/decisions.md` ADR-016)
- Store API keys, cookies, or other secrets in plaintext logs
- Push to remotes or open PRs without being asked

## Security and Privacy Posture

Vina runs entirely on the user's machine. The user's CV, cover letter, API keys (LLM and SerpAPI), browser cookies, and application history live in a single SQLite database under the OS user-data directory (see `docs/backend-designer.md` for paths). Nothing is sent anywhere except:

1. The configured LLM provider (when invoked)
2. The job sites the user has opted into (LinkedIn, Indeed)
3. SerpAPI (only if the user enabled Google Jobs and supplied a SerpAPI key)

Treat the database as containing PII at all times.
