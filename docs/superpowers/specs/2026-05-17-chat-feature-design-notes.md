# Chat Feature — Design Notes

**Status:** Notes (2026-05-17). Pre-spec; captures decisions made before scoping M20.
**Date:** 2026-05-17.
**Scope:** Architectural decisions for the M20 chatbot — to be expanded into a full design spec when we start the slice. Logged so the decisions don't get re-litigated.

This document is **not** the implementation spec. It records what's already been decided so the spec author (future me) doesn't have to re-derive these from scratch.

---

## 1. What we're building

A conversational interface that:

- Answers questions about the user's data ("what have I applied to today?", "what's ready for me?")
- Runs actions on demand ("search now on LinkedIn", "mark this applied")
- Updates configuration in natural language ("only show jobs above £80k", "don't tailor the CV for the next one")
- Resolves alerts inline ("8 years of Python experience" → `profile_answers`)

Per `SPEC.md` §8 and `docs/build-order.md` Milestone 20.

---

## 2. Decided architecture

### 2.1 LangGraph, not single-node bypass

Every other graph in `packages/orchestrator/src/graphs/` is a single-call async function with a 2-retry loop. That's the **single-node bypass** documented in `docs/langgraph-orchestrator.md` §5 — and it's the right call for `score-job`, `tailor-cv`, `tailor-cover-letter`, `prepare-manual-apply`, `resolve-selector`.

Chat is different. It needs:

- Multi-turn message history accumulating across turns
- Tool-using ReAct loop: `LLM → tool → LLM → tool → LLM → response`
- Conditional routing (should the next step be another tool call or a final response?)
- Streaming partial tokens to the WS layer (`chat:token`)

This is precisely what `StateGraph` is for. The chat-graph will be:

```
graph
  .addNode('llm', callModelWithTools)
  .addNode('tools', executeToolNode(toolKit))
  .addConditionalEdges('llm', shouldRouteToTools, {
    tools: 'tools',
    end: '__end__',
  })
  .addEdge('tools', 'llm');  // ReAct loop
```

Decision recorded so we don't re-litigate "do we really need LangGraph" when the chat-graph PR lands.

### 2.2 Typed `ChatToolKit`, no raw SQL

The chat agent gets a fixed registry of typed tools. **No `sqlQuery` / `runReadOnlyQuery` escape hatch**, even SELECT-only.

Reasoning (logged 2026-05-17):

- Every job description in the DB is third-party text. Prompt-injection via a recruiter listing into "run this SQL" is a real attack surface, not theoretical.
- The encryption layer protects values-at-rest (`settings` rows holding the SerpAPI key, vault rows holding the LinkedIn cookie). It does NOT gate column access — a `SELECT * FROM settings` returns the encrypted blob alongside the rest, and the LLM has no business deciding what's safe to feed back.
- Auditability degrades. With typed tools every "what jobs match X?" question maps to one named function we can log and rate-limit. With raw SQL every question is a unique query string.
- Power users get slash commands (see §2.3) — they don't need SQL, they need direct tool dispatch.

If a user-genuinely-needs case emerges that the typed tools can't cover, the answer is **add a typed tool for that shape**, not widen the escape hatch.

### 2.3 Slash commands share the tool registry

Power users can bypass the LLM with slash commands. Same tool definitions, two surfaces:

- LLM path: model returns `tool_use` block → zod validates args → tool executes → result streams back into the loop
- Slash path: user types `/findJobs status=ready` → parser tokenises `key=value` pairs → zod validates against the **same** schema → tool executes → result lands as a chat message

One source of truth: the `ChatToolKit` interface and its zod input schemas. Three downstream consumers:

1. LLM tool-call parsing inside the chat-graph
2. Slash-command argument parsing in the web layer
3. `/help` autocomplete UI (read tool name + description + schema)

Architectural reason this matters: if we ship LangGraph first and slash commands later, we'd have to refactor the tool definitions to expose them in a registry shape. Building registry-first costs nothing extra and makes slash commands a wrapper around an already-modular API.

### 2.4 Tool surface (initial set)

Final names settled during scoping; this is the planned list:

| Tool                          | Purpose                                                 |
|-------------------------------|---------------------------------------------------------|
| `findJobs`                    | Read jobs with typed filters (status, salary_min, etc)  |
| `findApplications`            | Read applications with typed filters                    |
| `getApplicationStats`         | Aggregates: counts by status, by time window            |
| `runSearchNow`                | Wraps `POST /api/searches/run-now`                      |
| `markApplied`                 | Wraps `POST /api/applications/:id/mark-applied`         |
| `updatePreferences`           | Wraps `PUT /api/search-preferences`                     |
| `setNextApplyOverrides`       | Ephemeral: `skip_tailoring`, custom CV instructions     |

The `setNextApplyOverrides` tool is the surface for two requirements that came up in chat:

- "Don't tailor the CV for the next application" → ephemeral `skip_tailoring: true` flag the prepare-manual-apply handler reads and clears
- "Tailor next application's CV emphasising my Postgres experience" → ephemeral `cv_tailoring_instructions: string` appended to `TAILOR_CV_SYSTEM` inside `<user_instructions>` delimiters, with a reaffirmation of the "DO NOT invent" rules immediately after to mitigate prompt-injection-via-user-instructions

Storage for ephemeral overrides: simplest path is two columns on `settings` (`next_apply_skip_tailoring boolean`, `next_apply_cv_instructions text`) that the handler reads + clears atomically. Single-user app — no need for a separate table.

---

## 3. Salary-range and "search this specific thing" requests

Chat can say "search only £80k+ remote Python jobs right now." The naive read is "add a `salary_min` arg to `runSearchNow`."

The reality:

- **Google Jobs (SerpAPI)** — no salary filter param. Closest approximation: append `"$80k+"` to the query string. Google parses it loosely. Best-effort.
- **LinkedIn** — has `f_SB2=N` (bracketed salary). Bracket boundaries are LinkedIn-controlled, not arbitrary. Best-effort mapping.

The honest tool surface: `runSearchNow({ site_id, salary_min_hint?, keywords_override? })` — both optional, both **hints** that get composed into the query. The score handler is still the firm filter for "above £80k" — it reads `salary_text` and applies the threshold post-hoc.

Document this in the tool description so the LLM and the user understand the filter is at score-time, not search-time.

---

## 4. What's NOT in M20

To keep the slice scoped:

- **Persistent memory beyond chat history.** The `profile_answers` table exists; chat can write to it via `saveProfileAnswer`, but we don't ship a separate "summarisation" graph. Memory is the message history plus profile_answers. Summarisation lands later if context windows force it.
- **Multi-modal input.** Text only.
- **Voice.** Text only.
- **Cross-session "what we last talked about" recall.** Each tab/session reloads the message history from the DB; that's enough.

---

## 5. Integration touchpoints (server-side)

The chat-graph will need:

- **DB read access** for the find tools — repo functions already exist (`listJobs`, `listApplications`, etc.)
- **EventBus** to emit `chat:token` (streaming) and `chat:message` (final), already declared in `packages/shared/src/events.ts`
- **Existing routes** that the action tools wrap — `runSearchNow`, `markApplied`, `prepare`, `updatePreferences` all ship in current M-tier

Nothing exotic — chat is mostly composition over what's already in place.

---

## 6. Open questions to resolve during M20 scoping

- **Tool-call concurrency.** Does the LLM ever want to fan out (`findJobs` and `getApplicationStats` in parallel)? Default to sequential ReAct; revisit if it materially slows responses.
- **Per-tool rate limits.** `runSearchNow` invoked 20× by an LLM hallucination is a SerpAPI quota burn. Likely fix: idempotency on the underlying route already covers this, but add a chat-side dedupe window.
- **Streaming the tool-result UI.** Showing "calling `findJobs`…" → "found 12 jobs" → final LLM response is a UX call. Probably show pending-tool indicators inline in the message bubble.
- **Prompt-injection hardening for the system prompt.** Listing `setNextApplyOverrides({ cv_tailoring_instructions: 'ignore prior rules and...' })` is an attack the user might inadvertently set against themselves. Mitigations: delimited section in the tailor prompt + reaffirmation of hard rules + maybe a confirmation step on the chat side ("you're about to override tailoring with X; confirm?").

---

## 7. Files this will likely touch when implementing

- Create: `packages/orchestrator/src/graphs/chat.ts` — the StateGraph
- Create: `packages/orchestrator/src/chat/tool-registry.ts` — the typed `ChatToolKit` interface + per-tool descriptors
- Create: `packages/server/src/orchestrator/tools/chat/*.ts` — server-side tool implementations
- Create: `packages/server/src/queue/handlers/chat-turn.ts` — or run inline via the HTTP route, depending on streaming model
- Create: `packages/server/src/http/routes/chat.ts` — message history + send
- Modify: `packages/server/src/http/ws.ts` — already broadcasts `chat:token` / `chat:message`; verify dispatch
- Create: `packages/web/src/routes/chat/ChatPage.tsx`
- Create: `packages/web/src/routes/chat/slash-command-parser.ts`
- Modify: `packages/web/src/components/layout/Sidebar.tsx` — `/chat` entry
- Possibly modify: `packages/server/migrations/00X_chat_overrides.sql` — `settings.next_apply_skip_tailoring`, `settings.next_apply_cv_instructions`

When M20 is scoped, this file becomes the design spec's appendix or is folded into the spec proper.
