# Vina — Product Specification

## 1. Vision

Job hunting at scale is mechanical, time-consuming, and emotionally draining. Vina is a local-first AI assistant that turns the bulk of the application process into something the user supervises rather than performs. The user installs Vina, points it at their CV and the kind of role they want, and Vina searches job boards on a schedule, tailors a CV per role, and submits applications — pausing only when it genuinely needs the user (a CAPTCHA, a question it can't answer, an approval gate).

For job sources where direct submission isn't possible (Google Jobs aggregates, off-site applications), Vina does the heavy lifting up to the point of submission — the tailored CV, the tailored cover letter, a one-click external link — and hands off to the user for the final manual click.

## 2. Target User

A working professional or job seeker who:

- Is comfortable installing a CLI tool via NPM
- Wants to apply to many roles without doing each by hand
- Already has a LinkedIn account
- Has access to an LLM (Anthropic / OpenAI / local Ollama) or is willing to set one up
- Optionally has a SerpAPI key for Google Jobs discovery

Non-goals: visual no-code users, mobile-only users, recruiters posting jobs.

## 3. Distribution and Runtime

- Distributed as an NPM package: `npm install -g vina` (or `npx vina`)
- All state lives locally. No Vina-hosted server, no telemetry, no account
- A single `vina` binary controls a background service. The web UI is served by that service and opens in the user's default browser

## 4. Core Concepts

| Concept               | Description                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Profile**           | The user's identity: name, contact details, CVs, cover letters, default answers to common application questions                                                                                              |
| **Search Preference** | A saved description of "what kind of jobs I want" — keywords, locations, seniority, salary range, work model, custom prose                                                                                   |
| **Schedule**          | How often Vina searches for new jobs (e.g. every 12 hours, daily)                                                                                                                                            |
| **Source**            | A place Vina discovers jobs from. MVP supports two: LinkedIn (via Playwright session) and Google Jobs (via SerpAPI). LinkedIn supports auto-apply for Easy Apply listings; Google Jobs is discovery-only. See ADR-019 for the rationale on skipping Indeed |
| **Job**               | A discovered listing on a supported source, with metadata, description, source URL, and match score. Each job has an `apply_method`: `auto` (Vina submits) or `manual` (user submits externally)             |
| **Application**       | An attempt to apply to a job. Has a status (queued / applying / awaiting_user / submitted / failed / skipped / ready_for_manual_apply / applied_manually) and links to the tailored CV used                  |
| **Alert**             | A notification surfaced both in the chatbot and the alerts tab — e.g. "needs CAPTCHA solved", "missing salary expectation", "tailored CV ready for manual application"                                       |
| **Session**           | A persisted Playwright browser context for LinkedIn, so the user logs in once. Not needed for Google Jobs (SerpAPI handles auth)                                                                             |

## 5. Operating Modes

The user selects, and can change at any time, one of two modes:

1. **Autonomous** — Vina searches, ranks, tailors, and applies without asking. It still pauses on blockers
2. **Supervised** — Vina searches and ranks. The user picks which jobs to apply to. Vina then proceeds as in autonomous mode for the picked jobs

Independently, an **approval setting** controls per-application behaviour:

- `auto-apply` — Tailored CV is submitted without review
- `review-first` — Tailored CV is shown in the UI; user clicks "Approve" before Vina submits

These are orthogonal: a user can be in supervised mode with auto-apply, or autonomous mode with review-first, etc.

For **manual-apply jobs** (Google Jobs results, plus any LinkedIn listing that redirects externally), the approval mode is implicit — the user always reviews before they apply, because they're the one doing the submission.

## 6. The Two Application Workflows

Vina supports two distinct workflows depending on the job source and listing type:

### 6.1 LinkedIn Easy Apply (Auto-Apply)

End-to-end automation. Vina opens the listing, fills the form, uploads the tailored CV, and submits — pausing only on blockers (missing fields, CAPTCHAs, session expiry).

### 6.2 LinkedIn external redirects + Google Jobs (Manual-Apply)

Two paths converge here:

- **LinkedIn external redirects.** When a LinkedIn listing redirects to a company ATS or career page, Vina detects this during discovery, marks the job as `apply_method = 'manual'`, captures the external apply URL, and routes it through the manual-apply pipeline rather than trying to automate the unknown ATS.
- **Google Jobs.** Every Google Jobs listing redirects externally. Vina uses SerpAPI's Google Jobs endpoint to fetch listings (no Playwright needed) and routes them through the same manual-apply pipeline.

In both manual-apply paths, Vina scores the listing, tailors the CV and cover letter, and presents everything in a "Ready to Apply" view. The user clicks through to the external site and submits manually, then clicks "Mark as applied" in Vina.

The same scoring, CV tailoring, and cover-letter generation logic is reused across both workflows — only the final submission step differs.

## 7. End-to-End Flow

```
Install ─▶ vina start ─▶ Browser opens UI
                              │
                              ▼
                    First-run onboarding:
                    - Choose mode
                    - Add LLM provider + key
                    - Optionally add SerpAPI key (for Google Jobs)
                    - Upload CV / cover letter
                    - Describe target jobs
                    - Pick sources (LinkedIn, Google Jobs)
                    - Log in to LinkedIn (Playwright window opens, user logs in, session saved)
                    - Set schedule
                              │
                              ▼
                    Scheduler tick (e.g. every 12h)
                              │
                              ▼
                    For each enabled source:
                       LinkedIn:    Playwright search ─┐
                       Google Jobs: SerpAPI fetch     ─┼─▶ Rank against profile ─▶ Insert into jobs table
                                                       ┘
                              │
                              ▼
                    Detect apply_method per job:
                       Easy Apply / Quick Apply  ─▶ apply_method = 'auto'
                       External redirect / Google ─▶ apply_method = 'manual'
                              │
                              ▼
                    [supervised] User selects ─┐
                    [autonomous] AI selects ───┤
                                               ▼
                                    For each selected job:
                                       Tailor CV
                                       │
                                       ├─ apply_method = 'auto':
                                       │     [review-first] Wait for approval
                                       │     Apply via Playwright
                                       │        ├─ success ─▶ submitted
                                       │        ├─ blocker ─▶ alert, awaiting_user, move on
                                       │        └─ failure ─▶ failed
                                       │
                                       └─ apply_method = 'manual':
                                             Tailor cover letter (if applicable)
                                             Mark application ready_for_manual_apply
                                             Surface in "Ready to Apply" UI + alert
                                             User clicks external link, applies manually
                                             User clicks "Mark as applied" ─▶ applied_manually
                              │
                              ▼
                    User returns, sees alerts:
                       Provides missing data ─▶ application resumes
                       Solves CAPTCHA       ─▶ application resumes
                       Approves CV          ─▶ application proceeds
                       Reviews ready-to-apply ─▶ applies externally, marks as done
```

## 8. Feature List (MVP)

### CLI

- `vina start` — start background service, open UI
- `vina stop` — stop background service
- `vina status` — show whether the service is running, port, current activity
- `vina logs [--follow]` — tail logs
- `vina reset` — wipe the database (with confirmation)
- `vina doctor` — diagnostics (Node version, Playwright binaries, disk space, optional SerpAPI key check)

### Web UI

- **Dashboard** — at-a-glance stats: jobs found this week, applications submitted (auto), applications applied manually, applications awaiting user, success/failure counts
- **Profile** — manage CVs (multiple), cover letters, default answers
- **Search Preferences** — describe target jobs, sources, schedule, mode, approval setting
- **Jobs** — list of discovered jobs with match scores, source, and apply method; in supervised mode the user picks here
- **Applications** — list of all applications with status, ability to drill into the tailored CV used and a per-application timeline. Includes a "Ready to Apply" tab/filter for manual-apply jobs
- **Ready to Apply** — dedicated section showing tailored CV preview, cover letter preview, download buttons, external apply link, and "Mark as applied" button
- **Alerts** — list of items needing user input. Each alert has a primary action (approve, provide info, solve CAPTCHA, retry, dismiss, view ready-to-apply)
- **Chatbot** — conversational interface to the same alerts plus general queries
- **Settings** — LLM provider and key, SerpAPI key, schedule, mode, approval setting, browser visibility, data export, reset

### AI / Orchestration

- LLM-agnostic: works with Anthropic, OpenAI, or local Ollama via a provider abstraction
- Job–profile match scoring with a justification string per job
- CV tailoring per job (preserves user's structure; rewrites bullets/summary to match the job)
- Cover letter tailoring (optional, only if user uploaded one)
- Tool-using agent for runtime decisions (e.g. "this form has a 'years of experience' field — do I have a value?")
- Chatbot with persistent memory across sessions (remembers values the user has supplied)

### Browser Automation

- Playwright with one persistent context per site, stored on disk
- Site adapter for LinkedIn (interface designed for more sites later)
- Early detection of Easy Apply vs external — non-Easy Apply listings route to manual-apply pipeline
- CAPTCHA detection — never solved automatically; surface as alert and pause
- Anti-detection: realistic timing, human-like scrolling, no fingerprint masking that violates ToS
- Headful fallback: if the user prefers, the browser window is visible

### External Integrations

- **SerpAPI** for Google Jobs discovery — user supplies their own API key, free tier available
- **LLM providers**: Anthropic, OpenAI, Ollama

### Data

- All data in SQLite at a stable OS-specific path
- Tailored CVs stored as files plus a row referencing them
- Application timeline preserved (events, errors, screenshots on failure)

## 9. Out of Scope (MVP)

- Mobile UI
- Multi-user / multi-tenant
- Cloud-hosted variant
- Job sources beyond LinkedIn and Google Jobs (architecture supports adding more later — see ADR-019 on Indeed)
- Automating arbitrary external ATS systems (Workday, Greenhouse, Lever, etc.) — these route through manual-apply
- Automated CAPTCHA solving via third-party services
- Resume/CV creation from scratch (Vina tailors existing CVs; it does not generate from nothing)
- Interview scheduling, follow-ups, or post-application correspondence

## 10. User Stories

The following user stories drive acceptance for MVP. Each is testable.

### Onboarding

- **US-01** As a new user, I install via `npm i -g vina` and run `vina start`; my browser opens to a welcome screen
- **US-02** I can choose autonomous or supervised mode, and change it later in Settings
- **US-03** I can add an Anthropic, OpenAI, or Ollama provider with the relevant config, and Vina validates the connection before saving
- **US-04** I can upload one or more CVs (PDF and DOCX) and label them
- **US-05** I can upload one or more cover letters
- **US-06** I can describe the kind of role I want in plain prose, and add structured fields (locations, salary, work model, seniority)
- **US-07** I can enable LinkedIn, Google Jobs, or both. For LinkedIn, Vina opens a browser for me to log in, then saves the session. For Google Jobs, I provide a SerpAPI key
- **US-08** I can set a schedule (every N hours or a specific time daily)

### Discovery

- **US-09** Vina searches enabled sources on schedule and stores matching jobs locally
- **US-10** Each job has a match score (0–100) and a one-line justification
- **US-11** I can see all discovered jobs in a list, filter by source / score / status / apply method, and sort
- **US-11a** Google Jobs results are clearly labelled with their original source (e.g. "via Dice", "via Greenhouse")

### Application — Auto

- **US-12** In autonomous mode, Vina applies to auto-apply jobs above a configurable score threshold
- **US-13** In supervised mode, I select which jobs to apply to from the Jobs list
- **US-14** For each application, Vina tailors my CV (and cover letter, if provided) to the job
- **US-15** With review-first on, I see the tailored CV in the UI before submission and can approve, reject, regenerate, or edit
- **US-16** With auto-apply on, the tailored CV is submitted without review, but is still available afterwards in the application detail view
- **US-17** Vina fills application forms with values it knows from my profile and prior answers
- **US-18** When Vina hits a field it has no value for, it pauses the application and creates an alert. Other applications continue
- **US-19** When a CAPTCHA appears, Vina pauses the application and creates an alert asking me to solve it manually
- **US-20** When my site session expires, Vina creates an alert prompting re-login

### Application — Manual

- **US-30** Google Jobs listings appear in my jobs list with a "manual" apply method indicator
- **US-31** When a LinkedIn listing redirects externally, Vina marks it as manual-apply rather than trying to automate the external site
- **US-32** For manual-apply jobs Vina selects (autonomous) or I select (supervised), Vina tailors the CV and cover letter the same way it does for auto-apply jobs
- **US-33** Once tailored, the application appears in the "Ready to Apply" section with the tailored CV, cover letter, external apply URL, and download buttons
- **US-34** I can download the tailored CV and cover letter, click through to the external site, complete the application there, and click "Mark as applied" in Vina to track it
- **US-35** Manually-applied jobs show in my application history alongside auto-applied ones, with their state and the source they came from

### Resuming

- **US-21** I see all paused items and ready-to-apply items in the Alerts tab and in the chatbot
- **US-22** I can answer a missing-field question via the chatbot or the alert's inline form, and the application resumes automatically
- **US-23** I can solve a CAPTCHA in the open Playwright window, and Vina detects success and continues

### Visibility

- **US-24** I can see a dashboard with weekly counts and current activity, including separate counts for auto-applied vs manually-applied
- **US-25** I can see per-application history including each event, timestamp, and (on failure) a screenshot
- **US-26** I can ask the chatbot "what have you applied to today?" and get an accurate answer
- **US-27** I can ask the chatbot "what's ready for me to apply to manually?" and see the list

### Control

- **US-28** I can pause the scheduler with one click
- **US-29** I can stop everything with `vina stop`
- **US-36** I can wipe all my data with `vina reset` after confirming
- **US-37** I can change my LLM provider at any time without reconfiguring anything else
- **US-38** I can add or remove my SerpAPI key without affecting LinkedIn configuration

## 11. Success Criteria for MVP

- A user can go from `npm install` to a first submitted application (auto) or first ready-to-apply (manual) in under 30 minutes
- Vina applies to at least 80% of auto-apply jobs it has all required data for, without user intervention beyond the initial site logins
- Paused applications resume successfully once the user provides the missing data
- Manual-apply jobs reliably reach the "Ready to Apply" state with tailored CV and cover letter, and the external link works
- All persistent state survives a `vina stop` / `vina start` cycle

## 12. Future Considerations (Not MVP)

- Additional sources: Indeed (skipped per ADR-019), Glassdoor, Otta, Welcome to the Jungle, company career pages
- Limited automation for popular ATS systems (Workday, Greenhouse) on the manual-apply path
- Automated cover-letter generation when none is uploaded
- Interview tracking
- Browser extension companion (for one-off applications outside the schedule)
- Multi-profile support (e.g. applying as different personas for contracting vs full-time)
