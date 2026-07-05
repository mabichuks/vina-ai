# Skill System

A loadable, on-demand skill system (modelled on OpenClaw's capability-vs-procedure
split). Behavioural procedures live in editable markdown skills rather than in
code; the relevant skill is injected only when needed (to respect token budgets);
and new skills can be added later — including by the chatbot on the user's
request.

## 1. Principle: capability vs procedure

- A **capability** is code the agent can call: a `ToolKit` method, a graph, a
  browser action. Capabilities stay in TypeScript.
- A **skill** is a markdown document that teaches the agent *how to use*
  capabilities to accomplish a task: the operating loop, the order of steps, when
  to escalate, what "good" looks like.

This mirrors OpenClaw: the `browser` tool is the capability; the
`browser-automation` skill is the procedure, loaded on demand so routine turns
don't pay its full token cost.

## 2. Layout

```
packages/orchestrator/skills/        # packaged default skills (read-only)
  browser-apply/SKILL.md
  cv-tailoring/SKILL.md
  cover-letter/SKILL.md
  answer-questions/SKILL.md
  job-scoring/SKILL.md
  manual-apply-prep/SKILL.md
  prompt-editing/SKILL.md

<data-dir>/skills/                   # user / chatbot-added skills (writable)
  <skill-id>/SKILL.md
```

Override semantics match prompts (see `prompt-system.md`): a user skill with the
same `id` shadows the packaged one.

## 3. SKILL.md format

```markdown
---
id: browser-apply
name: Browser Apply Loop
description: >
  How to fill and submit an application form reliably: snapshot first, act on
  refs, re-snapshot after UI changes, recover stale refs once, escalate
  login/2FA/CAPTCHA as manual blockers.
applies_to: [apply]          # which graphs may load this skill
capabilities: [snapshot, fillField, uploadCv, submitForm, takeScreenshot, createAlert]
editable_by_user: false      # safety-critical
version: 1
---

## When to use
...procedure body in markdown...
```

`description` is what the agent sees in its always-available skill index (cheap).
The full body is loaded **only** when the agent decides the skill is relevant,
or when a graph explicitly requests it. This is the token-budget protection.

## 4. Skill registry + loader

`packages/orchestrator/src/skills/registry.ts`:

```ts
export interface Skill {
  id: string;
  name: string;
  description: string;
  appliesTo: string[];
  capabilities: string[];
  editableByUser: boolean;
  version: number;
  body: string;            // loaded lazily
}

export interface SkillRegistry {
  index(graph?: string): Promise<Array<Pick<Skill,'id'|'name'|'description'>>>;
  load(id: string): Promise<Skill>;        // full body
  list(): Promise<Skill[]>;
}

export function createSkillRegistry(opts: {
  defaultsDir: string;
  overridesDir: string;
}): SkillRegistry { /* override-wins, frontmatter-validated, cached */ }
```

Integration:

- At graph start, inject `index(graphName)` (descriptions only) into context.
- Provide a `loadSkill(id)` tool so the agent can pull the full body when needed.
- For deterministic graphs (apply), the graph code can pre-load `browser-apply`
  rather than leaving it to the model.

## 5. Starter skills

| id | editable_by_user | purpose |
|---|---|---|
| `browser-apply` | false | form-fill operating loop (see `packages/orchestrator/skills/browser-apply/SKILL.md`) |
| `cv-tailoring` | true | rephrase/reorder/emphasise, never invent; allowed vs disallowed examples |
| `cover-letter` | true | voice/tone for cover letters |
| `answer-questions` | true | answer screening Qs from profile_answers + CV; raise missing-field alert vs infer; confidence threshold |
| `job-scoring` | true | scoring rubric (title 40 / skills 30 / seniority 15 / location 15) |
| `manual-apply-prep` | true | what a good manual-apply handoff package contains |
| `prompt-editing` | false | the guarded procedure for chatbot prompt edits (see `prompt-system.md` §6) |

`cv-tailoring` and `job-scoring` overlap with prompts. Rule of thumb: the
**prompt** carries the role framing + output schema instruction; the **skill**
carries the longer "how to think about it" procedure and examples. Keep the
no-fabrication safety clause in the *prompt* (validated), not only the skill.

## 6. Adding skills later (including via chatbot)

### Server REST (Settings → "Skills")

- `GET /api/skills`, `GET /api/skills/:id`
- `PUT /api/skills/:id` (writes `<data-dir>/skills/:id/SKILL.md`)
- `DELETE /api/skills/:id` (removes override / user skill)
- `POST /api/skills` (create new user skill)

### ToolKit additions

```ts
listSkills(): Promise<Array<{ id: string; name: string; editableByUser: boolean }>>;
getSkill(id: string): Promise<Skill>;
createSkill(input: { id: string; name: string; description: string; body: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
updateSkill(id: string, body: string): Promise<{ ok: true } | { ok: false; reason: string }>;
removeSkill(id: string): Promise<void>;
```

### Chatbot procedure

Lives in `prompt-editing` (and may be split into a dedicated `skill-authoring`
skill):

1. User asks for a new behaviour that isn't a one-off ("always mention my
   security clearance in cover letters for defence roles").
2. Chatbot decides: prompt edit, existing-skill edit, or new skill.
3. For a new skill it drafts frontmatter + body, shows it to the user in chat,
   and only calls `createSkill` after confirmation.
4. New user skills are **never** `editable_by_user:false` and **never** granted
   `capabilities` beyond those the requesting graph already exposes — the server
   strips disallowed capability names on write.
5. Safety-critical packaged skills (`browser-apply`, `prompt-editing`) cannot be
   overwritten; the chatbot explains and offers an additive alternative.

### Guardrails (server-enforced)

- Validate frontmatter; reject unknown/`false`-editable overwrites.
- `capabilities` must be a subset of a server allowlist; unknown names rejected.
- A user skill cannot redefine a packaged safety skill's `id`.
- Cap total user-skill body size (e.g. 16k chars) to protect token budgets.

## 7. Testing

- Registry: override-wins, lazy body load, index excludes body.
- Capability allowlist stripping on write.
- Cannot overwrite `editable_by_user:false` skills.
- Chatbot test: a durable preference yields a *proposed* new skill, no write
  before confirmation, capability list correctly clamped.
