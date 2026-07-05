# Prompt System

How Vina stores, loads, edits, and overrides the natural-language prompts that
drive its graphs. Every system/user prompt lives in a versioned `.md` file on
disk, is loaded at runtime, can be hot-edited, and can be updated by the chatbot
on the user's behalf — without touching code or redeploying.

## 1. Two-layer model

Two layers:

1. **Default prompts as markdown**, shipped with the package, read-only at runtime:
   `packages/orchestrator/prompts/<name>.md`
2. **User overrides as markdown**, writable, stored in the Vina data dir:
   `<data-dir>/prompts/<name>.md`

At load time the override wins if present, else the default is used. The
`userTemplate` interpolation and `responseSchema` **stay in code** — only the
natural-language prompt text moves to markdown. Schemas are validation logic, not
prose, and must not be user-editable.

## 2. Frontmatter contract

Every prompt `.md` file begins with YAML frontmatter:

```markdown
---
id: tailor-cv
title: CV Tailoring System Prompt
graph: tailor-cv
editable_by_user: true        # false for safety-critical prompts
variables: [jobDescription, cvText, profileName]   # names available to userTemplate
version: 1
---

You are Vina, a job-application assistant running on the user's machine.
...
```

`{{variableName}}` placeholders inside the body are substituted by the loader
from the `userTemplate` input. Only names listed in `variables` are allowed; an
unknown placeholder is a load-time error.

## 3. Default prompts shipped

| File | editable_by_user |
|---|---|
| `system-base.md` | `false` |
| `score.md` | `true` |
| `tailor-cv.md` | `true` |
| `tailor-cover-letter.md` | `true` |
| `apply.md` | `false`  ← safety-critical (drives the browser) |
| `chat.md` | `true` |

`system-base.md` body:

```
You are Vina, a job-application assistant running on the user's machine.
You have access to the user's profile, CVs, cover letters, prior answers, and the
ability to drive a browser. Never fabricate facts about the user. If you do not
know something, say so or call the appropriate tool.
```

The `apply` and `system-base` prompts are `editable_by_user: false` because they
govern actions that touch the browser and the "never fabricate" guarantee. User
customisation of those is a safety regression. The chatbot may *read* and
*explain* them but must refuse to overwrite them (see §6).

## 4. Loader

`packages/orchestrator/src/prompts/loader.ts`:

```ts
import { z } from 'zod';

export interface PromptDoc {
  id: string;
  title: string;
  graph: string;
  editableByUser: boolean;
  variables: string[];
  version: number;
  body: string;        // raw markdown body, placeholders intact
}

export interface PromptLoader {
  // Resolves override dir first, then packaged defaults.
  load(id: string): Promise<PromptDoc>;
  // Interpolates {{vars}} using only the declared `variables`.
  render(id: string, vars: Record<string, string>): Promise<string>;
  list(): Promise<PromptDoc[]>;
}

export function createPromptLoader(opts: {
  defaultsDir: string;          // packaged prompts/ dir
  overridesDir: string;         // <data-dir>/prompts/
}): PromptLoader { /* ... */ }
```

Loader rules:

- Parse frontmatter (use `gray-matter` or a tiny hand-rolled parser).
- Validate frontmatter against a Zod schema; reject on missing fields.
- `render` throws if a `{{placeholder}}` is not in `variables`, or if a declared
  variable is missing from `vars`.
- Cache parsed docs in memory; invalidate the cache entry when the override file
  changes (watch the overrides dir, or invalidate on write via §5).

Each graph calls `await loader.render('tailor-cv', { ... })`. `responseSchema`
imports stay in code.

## 5. Server: prompt CRUD + ToolKit additions

### REST (web UI Settings → "Prompts")

- `GET /api/prompts` → list (id, title, editableByUser, version, isOverridden)
- `GET /api/prompts/:id` → `{ default: body, override: body | null, meta }`
- `PUT /api/prompts/:id` → writes `<data-dir>/prompts/:id.md` (rejects if
  `editableByUser=false`); bumps version; invalidates loader cache
- `DELETE /api/prompts/:id` → removes the override, reverting to default

### Validation on write

1. Reject if `editableByUser=false`.
2. Re-parse the submitted markdown; frontmatter `id` must match the path.
3. Placeholder check: the override may only use `{{variables}}` declared in the
   **default's** frontmatter. New variables are rejected (prevents the user
   referencing data the graph won't supply).
4. Run a dry `render` with a fixture var set; reject if it throws.
5. Keep the previous override as `:id.md.bak` (one level of undo).

### ToolKit additions

Add to the `ToolKit` interface in `packages/orchestrator/src/tools/types.ts`:

```ts
listPrompts(): Promise<Array<{ id: string; title: string; editableByUser: boolean }>>;
getPrompt(id: string): Promise<{ body: string; editableByUser: boolean; variables: string[] }>;
updatePrompt(id: string, body: string): Promise<{ ok: true } | { ok: false; reason: string }>;
revertPrompt(id: string): Promise<void>;
```

Implement these in the server's ToolKit construction, wrapping the REST logic
above.

## 6. Chatbot: updating prompts from user preference

The chat graph (`graphs/chat.ts`) runs a ReAct loop with the full ToolKit.
Expose the four prompt tools above to it, with a guarded operating procedure
(this procedure lives in the `prompt-editing` skill — see `skill-system.md`):

1. When the user expresses a durable preference about Vina's behaviour
   ("stop writing such formal cover letters", "score remote jobs higher"),
   the chatbot identifies the relevant prompt via `listPrompts`.
2. It reads the current body via `getPrompt`.
3. If `editableByUser=false`, it explains it can't change that one and why,
   and offers the nearest editable alternative.
4. Otherwise it proposes a concrete diff to the user **in chat**, and only calls
   `updatePrompt` after the user confirms. Never silent-writes.
5. It preserves all `{{variables}}` and the frontmatter; it edits prose only.
6. It tells the user they can revert (`revertPrompt`) and that the change affects
   future runs, not past applications.

Guardrails (enforce in the tool wrapper, not just the prompt):

- `updatePrompt` server-side re-runs the §5 validation; a malformed edit is
  rejected and the chatbot reports the failure rather than retrying blindly.
- The chatbot must not move safety language out of `tailor-cv` (the "do not
  invent employment/education/skills" clause). The default keeps a sentinel
  marker comment `<!-- vina:no-fabrication -->`; a server-side check rejects an
  `updatePrompt` body for `tailor-cv` that drops the sentinel.

## 7. Testing

- Loader unit tests: frontmatter parse, override-wins, placeholder validation,
  unknown-variable rejection.
- A test that every graph's render output is byte-identical to the old in-code
  prompt for a fixed fixture (guarantees the migration changed nothing).
- Prompt-CRUD tests: `editable_by_user:false` rejects writes; safety-sentinel
  check rejects fabrication-clause removal; revert restores default.
- Chatbot tests with a fake model: a preference message leads to a *proposed*
  diff and no write until confirmation.
