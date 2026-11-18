# OpenCode Orchestration

Design for the orchestration layer accepted in ADR-024. Replaces the LangGraph
graphs and the bespoke chat loop. Read with `docs/decisions.md` (ADR-022,
ADR-023, ADR-024) and `docs/skill-system.md`.

The rule in one line: **OpenCode decides, Vina acts.** The agent reasons over
snapshots and job text; every fact it reads and every effect it causes goes
through a typed Vina tool.

## 1. Why the split falls here

| Concern                                               | Owner           | Reason                                 |
| ----------------------------------------------------- | --------------- | -------------------------------------- |
| Sessions, compaction, tool dispatch, provider auth    | OpenCode        | Bought, not built                      |
| Job text, scores, application state, rate limits      | Vina            | SQLite is the audit record             |
| Form fill on LinkedIn Easy Apply                      | Vina            | Zero-token, tested, gate-enforced      |
| Form fill on external ATS                             | Playwright MCP  | Three modes: manual / assisted / autonomous (ADR-024) |
| Rendered PDFs, file hashes                            | Vina            | Deterministic output                   |
| Deciding whether to apply, tailoring prose, reviewing | OpenCode agents | Needs judgement                        |

The seam is the `vina` tool namespace. If a behaviour cannot be expressed as a
tool call plus a skill instruction, it does not belong in the agent.

## 2. Process model

```
Vina server (Node)
├── Fastify + WS + SQLite + scheduler + queue      (unchanged)
├── browser manager (CDP, stealth, profiles)       (unchanged)
├── OpenCode host                                  (new)
│   ├── location: <dataDir>/workspace
│   ├── plugin: @vina/opencode-plugin  → vina_* tools
│   ├── MCP: playwright → --cdp-endpoint <loopback>
│   └── agents: vina-sweep, vina-materials,
│               vina-review, vina-apply, vina-manual,
│               vina-chat
└── deterministic walker (runApply)                (unchanged)
```

Two hosting modes, chosen in the stage-0 spike:

- **Embedded** — `OpenCode.create()` from `@opencode/sdk`: no listener, host
  assembled inside the Vina process.
- **Service** — `Service.ensure()` from `@opencode/client/service`, then a
  client against the registered endpoint. Needed if the SDK does not run on the
  pinned Node LTS.

Either way Vina calls the same generated client shape: `session.create`,
`session.prompt`, `session.wait`, `session.interrupt`, `event.subscribe`.

## 3. Workspace

```
<dataDir>/workspace/
├── opencode.jsonc            generated at boot; not user-edited
├── AGENTS.md                 candidate facts + harness conventions
├── skills/                   vendored harness skills (pinned)
│   ├── job-sweep/ job-materials/ job-review/ job-apply/ ...
│   └── browser-rules.md
└── runs/<taskId>/            per-task scratch: notes, intermediate HTML
```

`opencode.jsonc` is written from settings on every boot so the model, provider,
MCP entry, and plugin path cannot drift from what the UI shows. Users never edit
it. Skills are vendored, not linked: a Vina release states which harness version
it carries.

Two details the stage-0 probe forced:

- The config lists skills explicitly under `skills[]`. Implicit
  `.opencode/skills` discovery did **not** register workspace skills in the
  embedded host, while an explicit entry did.
- The host runs with an isolated config home. Without it, the user's personal
  OpenCode skills and agents leak into Vina's workspace, which is both confusing
  and a privacy leak.

## 4. Plugin and tool contract

The plugin is a first-party workspace package (`packages/opencode-plugin`). It
receives the server's service container by injection at activation; it opens no
second database handle.

```ts
Plugin.define({
  id: 'vina',
  setup(ctx) {
    ctx.tool.transform((editor) => {
      editor.namespace({ name: 'vina', description: 'Vina job-search facts and actions' });
      for (const tool of buildVinaTools(services)) editor.add(tool);
    });
    ctx.mcp.transform((editor) => {
      editor.set('playwright', {
        type: 'local',
        command: [
          'npx',
          '-y',
          '@playwright/mcp@<pinned>',
          '--cdp-endpoint',
          browserManager.cdpEndpoint(),
          '--browser',
          'chrome',
          '--headless',
        ],
        codemode: false,
      });
    });
    ctx.session.hook('context', (event) => {
      // defence in depth: the active agent's allowlist also trims the tool set
      event.options.maxTokens = budgetFor(event.agent);
    });
  },
});
```

### Tools

| Tool                      | Input                                                           | Effect                         | Notes                                                                 |
| ------------------------- | --------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| `vina_profile_read`       | `{}`                                                            | none                           | Profile, CV list, saved answers. Never the whole DB                   |
| `vina_search_jobs`        | `sources, query, location, limit`                               | writes `jobs`, dedupes         | SerpAPI and LinkedIn search; no browser for Google Jobs               |
| `vina_jobs_list`          | `status?, limit?`                                               | none                           | Pipeline view for dedupe and triage                                   |
| `vina_job_get`            | `jobId`                                                         | none                           | Description, score, eligibility, application state                    |
| `vina_score_job`          | `jobId`                                                         | writes `applications.score`    | Runs the existing scoring prompt; keeps scores comparable across runs |
| `vina_materials_save`     | `applicationId, cvMarkdown, coverLetterMarkdown?, formAnswers?` | renders PDF/DOCX, sets `ready` | Rendering stays deterministic; the agent writes prose only            |
| `vina_review_record`      | `applicationId, round, verdict, findings[]`                     | writes event + review row      | Review agent's only write                                             |
| `vina_application_status` | `applicationId, status, reason?`                                | validated transition           | Rejects illegal transitions; the agent cannot invent states           |
| `vina_easy_apply`         | `applicationId`                                                 | submits                        | Runs `runApply` + `checkEasyApplyGate`; the only Easy Apply submit path |
| `vina_external_submit`    | `applicationId`                                                 | submits                        | External ATS only; gated, `autonomous` mode; records every field + confirmation |
| `vina_ask_user`           | `questions[]`                                                   | alert + park                   | Returns `pending`; the queue resumes the session when answered        |

Rules:

- Every tool validates with zod and returns a compact JSON result. No tool
  returns a full table dump; agents get slices.
- Every mutating tool writes `application_events` in the same transaction. The
  DB stays the audit record even though the transcript is the narrative.
- Tools are idempotent on `(applicationId, contentHash)` where replay is
  possible, so a retried session cannot double-submit or duplicate materials.
- `vina_easy_apply` and `vina_external_submit` are the only tools permitted to
  click submit anywhere in the system, each bound to its own site kind, and
  neither uses the agent's browser.

## 5. Agents

| Agent            | Allowed                                                          | Denied                      | Model      |
| ---------------- | ---------------------------------------------------------------- | --------------------------- | ---------- |
| `vina-sweep`     | search, jobs list/get, score, playwright                         | materials_save, easy_apply  | cheap/fast |
| `vina-materials` | profile_read, job_get, materials_save, ask_user, workspace write | playwright, easy_apply      | strong     |
| `vina-review`    | job_get, materials read, review_record                           | any write outside review    | strong     |
| `vina-apply`     | easy_apply, job_get, ask_user                                    | playwright, materials write | cheap      |
| `vina-manual`    | playwright, job_get, materials read, status, external_submit     | easy_apply                  | cheap      |
| `vina-chat`      | profile_read, jobs, status, search, ask_user                     | easy_apply, playwright      | strong     |

Agent definitions live in the workspace as markdown, generated from a typed
table in the plugin so the UI can show them. The harness's capability-vs-
procedure split is preserved: an agent is a capability set, a skill is a
procedure.

The reviewer is dispatched in a **fresh session** that never sees the writer's
transcript — the harness rule, now enforced by session creation rather than by
prompt discipline.

## 6. Session lifecycle

1. Queue handler claims a task row (unchanged `task_queue` semantics).
2. It creates a session, writes task facts as instruction entries
   (`session.instructions.entry.put`), selects the agent, and prompts with the
   skill name plus the task id.
3. Vina subscribes to events and mirrors `tool` and `message` events onto the
   existing bus so the UI streams as it does today.
4. On idle, the handler verifies the DB reached a legal terminal state for that
   task kind. No terminal state → task failed with the transcript id attached.
5. `session.interrupt` on user pause, shutdown, or the existing per-task timeout.
6. Sessions are removed after the verification window; the DB keeps the
   summary and the events.

A session is never the source of truth. Killing Vina mid-run loses the
reasoning, not the application state.

## 7. Approval and the gate

ADR-023's single gate is untouched and stays in `checkEasyApplyGate`.

- **UI-initiated apply** (user clicks Apply): server calls `vina_easy_apply`
  directly. No permission prompt; the click was the approval.
- **Agent-initiated apply**: the tool calls `ctx.permission.assert({ action:
"vina.easy_apply", resources: [applicationId] })` first. In `manual` mode the
  agent's rules deny it outright; in `autonomous` mode the gate still applies.
- **External ATS**: three modes under `external_apply_mode`.
  - `manual` (default): materials only; the user applies on the external site
    (ADR-016).
  - `assisted`: the agent fills the form in Vina's managed Chromium and stops
    before submit; the user reviews and clicks.
  - `autonomous`: the agent fills and submits through `vina_external_submit`,
    which runs the gate and `ctx.permission.assert`; a raw browser click never
    submits. Every step is written to `application_events`.
- **Activity log**: every agent step and tool call streams to the UI, which
  renders a live per-application timeline — mandatory for `autonomous` Easy
  Apply and external apply. The per-field source audit from ADR-023 is part of
  it.
- Non-technical users see no permission dialogs in autonomous mode. Pending
  requests only appear for actions a human must decide (a missing fact, an
  unfamiliar legal attestation), surfaced through the existing alerts UI.

## 8. Context and cost

- **Easy Apply on a standard form: 0 tokens.** The walker fills known fields and
  only escalates an unclassifiable field to the existing single-step decider,
  which stays in Vina code inside the tool.
- No agent runs for a search where SerpAPI already returns structured listings.
- `vina_score_job` uses the cheap model; tailoring and review use the strong one.
- The context hook trims the tool list per agent and sets a token ceiling.
- A session step cap plus the queue timeout bound the worst case; the existing
  circuit breaker still flips `easy_apply_mode` to manual after repeated
  failures.
- Token and cost per session come from OpenCode's own message accounting and are
  written to `application_events` so the UI can show spend per application.

## 9. Credentials

One source of truth: the Vina vault.

- The vault decrypts the LLM key at boot and injects it into the OpenCode host
  environment, and the plugin registers the provider with an explicit
  `baseURL`. No `opencode auth login`, no second `auth.json`.
- Changing provider in Settings rewrites the generated config and reloads the
  location; in-flight sessions are interrupted rather than migrating
  mid-application.
- SerpAPI stays server-side; no agent ever sees that key.
- Log redaction covers tool inputs. `vina_profile_read` is the only tool that
  returns PII, and its output is logged as field names only.

## 10. Failure handling

| Failure                      | Behaviour                                                         |
| ---------------------------- | ----------------------------------------------------------------- |
| OpenCode host fails to start | Boot degrades to manual mode; dashboard alert with the reason     |
| Session errors or times out  | Task failed, transcript id attached, queue retries per policy     |
| MCP browser disconnected     | Tool returns `browser_unavailable`; agent asks the user to reopen |
| Session expired on a site    | Existing `session_expired` path; agent stops, alerts              |
| Model provider unreachable   | 3 retries at the host, then task failed + alert                   |
| Tool throws                  | Typed `VinaError` surfaces as tool error; agent sees the reason   |
| Illegal state transition     | Tool rejects; the agent cannot paper over it                      |

## 11. Security

- Agent tools cannot read outside `<dataDir>/workspace` and the DB slice the
  tool returns.
- The CDP port stays loopback-only (ADR-022).
- Page text, popups, and job descriptions are data, never instructions. The
  harness § Browser Rules are carried into `browser-rules.md` and referenced by
  every browser-using skill.
- A skill may instruct; a tool may refuse. Anything irreversible is a tool with
  a gate, not a sentence in a prompt.

## 12. Testing

| Layer               | Approach                                                                                    | Target                           |
| ------------------- | ------------------------------------------------------------------------------------------- | -------------------------------- |
| Tool executors      | Vitest, fake DB, assert rows + events                                                       | every tool, every rejection path |
| Gate + walker       | Existing 863-test suite, unchanged                                                          | no regression                    |
| Agents/skills       | Recorded transcripts replayed against a fake model; assert tool sequence and terminal state | one per skill path               |
| Plugin registration | Boot a host, assert tool/skill/MCP names and deny rules                                     | smoke                            |
| Live                | One Easy Apply against a fixture site, one sweep against a fixture SerpAPI                  | nightly                          |

Agent output is never asserted as prose. It is asserted as: which tools were
called, with which arguments, and what state the DB reached.

## 13. Packaging

- Pin the runtime version; upgrade in a dedicated PR with an eval run.
- Prefer the embedded SDK. If it cannot run on the pinned Node LTS, ship the
  `opencode` binary under `vendor/` per platform and use `Service.ensure()` with
  an explicit `command` and `file` so it never collides with a user's own
  OpenCode install.
- Release-size budget: record tarball size per platform in the release job and
  fail the job above the agreed ceiling.
- `vina doctor` gains checks: runtime present, version pinned, workspace
  writable, MCP browser reachable, provider key valid.

## 14. Staged migration

| Stage        | Work                                                                                                                             | Exit criteria                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 0. Spike     | Host on Node 24; one session; one custom tool; Playwright MCP over `--cdp-endpoint` against a fixture site; measure install size | All four work, or the service+binary fallback is proven    |
| 1. Skeleton  | Plugin, tool contract, generated workspace, agents, skills vendored; chat moves to sessions                                      | Chat parity; `chat-service` and `chat.ts` deleted          |
| 2. Reasoning | Sweep, score, materials, review move to sessions                                                                                 | Tailor + score + prepare graphs and prompt modules deleted |
| 3. Hands     | `vina_easy_apply` wraps `runApply`; manual-apply uses Playwright MCP                                                             | LangGraph dependency removed; apply suite green            |
| 4. Ship      | Installer, doctor, size budget, docs, onboarding copy                                                                            | Fresh install on a clean machine completes one application |

LangGraph is frozen from now until stage 3: no new graph, no new node. Work that
would have added one arrives as a tool plus a skill.

### Stage 0 probe — 2026-11-18

Run against `@opencode/sdk@2.3.1` on Node 24.21.0, no Bun, macOS arm64.

| Check                                                 | Result                                                   |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `import { OpenCode }` on Node                         | Works                                                    |
| `OpenCode.create()` + `sessions.create()` + `close()` | Works                                                    |
| `Plugin.define` → `setup(ctx)` per location           | Works, correct `ctx.location`                            |
| Explicit `skills[]` in generated config               | Works                                                    |
| Implicit `.opencode/skills` discovery                 | Did **not** register in the embedded host                |
| Global user skills excluded                           | No — host inherited them without an isolated config home |
| Installed size                                        | 388 MB `node_modules` for the SDK and its deps           |
| `session.prompt` against a real provider             | Works — `ollama-cloud` provider via `openai-compatible`; reply `spike-ok`; streaming fields + `outcome: succeeded` |
| `permission.assert` → request → `permission.reply`    | Works — `ask` rule raises a pending request; `reply` `once` completes the tool; `reply` `reject` refuses it        |
| Playwright MCP over `--cdp-endpoint`                  | Works — `@playwright/mcp@0.0.85` attached to loopback CDP; `browser_snapshot` returned the fixture marker         |

All four stage-0 exit criteria are now exercised and pass. The hosting question is
settled in favour of the embedded SDK; the service-plus-binary fallback stays
documented but is no longer the expected path.

**Check 2 — permission round trip** (2026-11-18, no model; the tool executor was
driven directly with a synthetic `ToolContext` against a live session). A plugin
registered one tool whose `execute` called
`ctx.permission.assert({ sessionID, action: 'spike.submit', resources: ['job-1'] })`,
and the session was created with
`permissions: [{ action: 'spike.submit', resource: 'job-1', effect: 'ask' }]`.
The assert raised a pending request, observed via
`oc.permission.list({ sessionID })` as `{ id, sessionID, action, resources }`.
`oc.permission.reply({ sessionID, requestID, decision: 'once' })` resolved it and the
tool completed with `{ content: 'spike-perm-ok' }`; a second round with
`decision: 'reject'` + `message` refused the tool with a `Tool.Error` carrying the
message. Exact shapes: `ctx.permission.assert` → `Promise<void>` (resolves on allow,
rejects `Tool.Error` on a rejection with feedback); `oc.permission.reply` takes
`decision ∈ "once" | "always" | "reject"` (`Permission.Reply`); session rules are
`Permission.Ruleset` (`{ action, resource, effect: "allow" | "deny" | "ask" }[]`,
last matching rule wins, no match → `ask`); events are `permission.asked` /
`permission.replied`.

**Check 3 — Playwright MCP over CDP** (2026-11-18). A throwaway Chromium was launched
loopback-only — `chrome-headless-shell --remote-debugging-port=9333
--remote-debugging-address=127.0.0.1 --user-data-dir=<profile> --no-first-run
about:blank` (HeadlessChrome/147.0.7727.15) — then
`npx -y @playwright/mcp@0.0.85 --cdp-endpoint http://127.0.0.1:9333 --browser chrome
--headless`. The MCP listed 25 tools; `browser_navigate` to a marker page and
`browser_snapshot` round-tripped the marker (`heading "spike-cdp-ok"`). Two caveats:
`--cdp-endpoint` takes the `http://` loopback endpoint (Playwright resolves
`/json/version` to the browser ws URL) — a bare `ws://127.0.0.1:9333` 404s on `/`;
and in this environment the full `Google Chrome for Testing` 147 binary did **not**
open the debug port (crashpad `mach_port_request_notification` FATAL, empty log, no
`DevToolsActivePort`), while the Playwright headless shell did — a launch detail to
verify against the real `packages/automation` manager in stage 1.

## 15. Related documents

- `docs/decisions.md` — ADR-005 (superseded), ADR-022, ADR-023, ADR-024
- `docs/skill-system.md` — capability vs procedure, skill registry
- `docs/browser-automation.md` — CDP, snapshot/ref, adapters
- `docs/langgraph-orchestrator.md` — historical; do not extend
