# Vina

> An AI-powered job application assistant that runs on your machine.

Vina searches LinkedIn, Indeed, and Google Jobs on a schedule, tailors your CV to each role, and applies on your behalf. For listings that support direct submission (LinkedIn Easy Apply, Indeed Quick Apply) it submits the application end-to-end. For listings that bounce out to a company's own ATS (most Google Jobs results, plus any LinkedIn or Indeed listing that redirects externally), Vina prepares a tailored CV and cover letter, hands you the link, and you do the final click — then mark it as applied to keep your pipeline tracked in one place.

It pauses and asks you only when it genuinely needs you — a CAPTCHA, a missing answer, an approval gate, or a job that's ready for you to apply manually.

Everything runs locally. No Vina-hosted server. No telemetry. Your CV, cover letters, API keys, and application history live in a single SQLite database under your OS user-data directory.

---

## Install

```bash
npm install -g vina
```

Requires Node.js 20 or later.

## Use

```bash
vina start     # boots the background service and opens the UI
vina stop      # shuts the service down
vina status    # shows whether it's running, the URL, and current activity
vina logs -f   # tails the log
vina reset     # wipes all local data (with confirmation)
vina doctor    # runs diagnostics
```

`vina start` opens `http://localhost:7341` in your default browser. First run walks you through:

1. Add an LLM provider — Anthropic, OpenAI, or local Ollama
2. Upload your CV (and optionally a cover letter)
3. Describe the kind of role you want
4. Toggle the job sources to use:
   - **LinkedIn** and **Indeed** — log into each once via a browser window Vina opens for you
   - **Google Jobs** (optional) — paste a SerpAPI key. The free tier (250 searches/month) is enough for typical use
5. Pick a schedule and a mode

## Modes

- **Autonomous** — Vina searches, ranks, tailors, and applies (or prepares for manual application) on its own
- **Supervised** — Vina searches and ranks; you pick which jobs it acts on

Independently, you choose **auto-apply** (submit auto-applicable jobs without review) or **review-first** (preview each tailored CV before it's submitted or handed to you for manual application).

## How it works

Vina supports three application workflows depending on the job source and listing type:

**Auto-apply (LinkedIn Easy Apply, Indeed Quick Apply)**
Vina drives a real headless browser via Playwright using your saved login session. For each job above your match threshold, it tailors your CV to the role, fills the application form using values from your profile and previous answers, and submits. When it hits something it can't handle — a CAPTCHA, a missing field, a session expiry — it creates an alert, pauses just that application, and moves on. You return later, answer the question or solve the CAPTCHA, and the application resumes.

**Manual-apply (Google Jobs, plus external-redirect LinkedIn / Indeed listings)**
Many listings — every Google Jobs result, plus a fair share of LinkedIn and Indeed jobs — bounce you out to a company's own application site (Workday, Greenhouse, Lever, the company's careers page). Vina detects this during discovery and routes those jobs through a manual-apply pipeline instead: it scores them, tailors the CV (and cover letter, if you have one), and surfaces them in a "Ready to Apply" view with the tailored materials and the external link. You click through, apply on the external site, then click "Mark as applied" in Vina to keep your pipeline tracked.

For Google Jobs discovery, Vina uses [SerpAPI](https://serpapi.com)'s Google Jobs endpoint — clean structured results, no scraping. You supply your own SerpAPI key.

A chatbot is the conversational front-end to all of this. You can ask "what have you applied to today?" or "what's ready for me to apply to manually?", answer pending questions, or pause everything from chat. The same alerts also live in a dedicated Alerts tab.

## Privacy posture

Vina runs entirely on your machine. The only outbound traffic is:

1. Calls to the LLM provider you configured (Anthropic, OpenAI, or your local Ollama instance)
2. Visits to the job sites you opted into (LinkedIn, Indeed)
3. Calls to SerpAPI — only if you enabled Google Jobs and supplied a SerpAPI key

API keys (LLM provider and SerpAPI) are encrypted at rest using your OS keychain (or a permissions-restricted key file as a fallback). Browser sessions are stored in your user-data directory and never leave it.

## Project status

Pre-MVP. See `SPEC.md` for the full product spec and `docs/` for the design.

## Documentation

- [`SPEC.md`](./SPEC.md) — product spec, scope, user stories
- [`CLAUDE.md`](./CLAUDE.md) — guide for AI assistants (Claude Code) working on this repo
- [`docs/architecture.md`](./docs/architecture.md) — system architecture
- [`docs/database-schema.md`](./docs/database-schema.md) — data model
- [`docs/backend-designer.md`](./docs/backend-designer.md) — backend service design
- [`docs/langgraph-orchestrator.md`](./docs/langgraph-orchestrator.md) — AI workflow and tool definitions
- [`docs/browser-automation.md`](./docs/browser-automation.md) — Playwright and site-adapter design
- [`docs/api-spec.md`](./docs/api-spec.md) — REST and WebSocket contract
- [`docs/frontend-designer.md`](./docs/frontend-designer.md) — UI structure and components
- [`docs/theme.md`](./docs/theme.md) — visual design system
- [`docs/cli-spec.md`](./docs/cli-spec.md) — CLI commands and process management
- [`docs/decisions.md`](./docs/decisions.md) — design decisions and rationale
- [`docs/build-order.md`](./docs/build-order.md) — recommended implementation sequence

## License

TBD.
