# LangGraph Orchestrator — `packages/orchestrator`

This package contains the AI workflows. It is a pure library — it does no I/O of its own beyond calling the tools the server passes in. This keeps it deterministic to test and easy to swap.

## 1. Why LangGraph

The application workflow is a state machine: search → score → tailor → apply (or hand-off for manual) → handle blocker → submitted. LangGraph models exactly this, with explicit states, conditional edges, and a typed shared state object. The chatbot is a different graph (a tool-using ReAct loop with persistent memory) but uses the same provider abstraction.

## 2. Folder Layout

```
packages/orchestrator/
├── src/
│   ├── index.ts                # public exports
│   ├── providers/
│   │   ├── registry.ts         # buildModel(provider): ChatModel
│   │   ├── anthropic.ts        # ChatAnthropic factory
│   │   ├── openai.ts           # ChatOpenAI factory
│   │   └── ollama.ts           # ChatOllama factory
│   ├── graphs/
│   │   ├── score-job.ts        # job-vs-profile scoring graph
│   │   ├── tailor-cv.ts        # CV tailoring graph (used by both auto and manual flows)
│   │   ├── tailor-cover-letter.ts # cover-letter tailoring graph
│   │   ├── apply.ts            # the big one — apply a tailored CV to a job (auto-apply only)
│   │   ├── prepare-manual-apply.ts # tailoring + cover letter for manual-apply jobs
│   │   └── chat.ts             # chatbot graph
│   ├── tools/
│   │   ├── types.ts            # ToolKit interface (passed in by server)
│   │   ├── browser-tools.ts    # tool wrappers around automation
│   │   ├── data-tools.ts       # tool wrappers around DB reads/writes
│   │   └── alert-tools.ts      # tool wrappers around alert creation/resolution
│   ├── prompts/
│   │   ├── system-base.ts      # shared system prompt elements
│   │   ├── score.ts
│   │   ├── tailor.ts
│   │   ├── tailor-cover-letter.ts
│   │   ├── apply.ts
│   │   └── chat.ts
│   └── memory/
│       ├── chat-memory.ts      # sliding window + answer book retrieval
│       └── summarisation.ts    # rolling summary when window overflows
└── package.json
```

## 3. Provider Abstraction

`buildModel(provider)` returns a LangChain `BaseChatModel` instance. The server passes the active provider's config (kind, model, base URL, decrypted API key) into the graphs. The graphs never know which provider is in use.

```ts
type ProviderConfig =
  | { kind: 'anthropic'; model: string; apiKey: string }
  | { kind: 'openai'; model: string; apiKey: string }
  | { kind: 'ollama'; model: string; baseUrl: string };

function buildModel(cfg: ProviderConfig): BaseChatModel;
```

All graphs accept a `model` parameter. The server is responsible for invalidating any in-flight graphs when the user changes the active provider.

## 4. Tool Kit

The orchestrator does not import the automation or server packages. Instead, the server constructs a `ToolKit` and passes it in. This is the only way the LLM can affect the world.

```ts
interface ToolKit {
  // Read-only data tools (deterministic, cheap)
  getProfile(): Promise<Profile>;
  getCv(id: string): Promise<Cv>;
  getCoverLetter(id: string): Promise<CoverLetter | null>;
  getProfileAnswer(key: string): Promise<string | null>;
  getJob(id: string): Promise<Job>;

  // Write tools (audit-logged)
  saveTailoredCv(applicationId: string, docxBuffer: Buffer): Promise<{ path: string }>;
  saveTailoredCoverLetter(applicationId: string, docxBuffer: Buffer): Promise<{ path: string }>;
  markReadyForManualApply(applicationId: string): Promise<void>;

  // Browser tools (delegated to automation; never used in the manual-apply flow)
  openJobApplication(jobId: string): Promise<{ formId: string }>;
  fillField(formId: string, fieldKey: string, value: string): Promise<void>;
  uploadCv(formId: string, path: string): Promise<void>;
  uploadCoverLetter(formId: string, path: string): Promise<void>;
  inspectFormFields(formId: string): Promise<FormField[]>;
  submitForm(
    formId: string,
  ): Promise<
    { ok: true } | { ok: false; reason: 'captcha' | 'session_expired' | 'other'; detail?: string }
  >;
  takeScreenshot(formId: string): Promise<{ path: string }>;

  // Alert tools
  createAlert(input: NewAlert): Promise<{ id: string }>;
  resolveAlert(id: string, value?: string): Promise<void>;

  // Chat helpers
  recordChatMessage(role: ChatRole, content: string, metadata?: object): Promise<void>;
}
```

Each tool is exposed to LangChain as a `Tool` with a zod schema for arguments. The graphs decide which subset of tools to bind based on what they need (the score graph doesn't get browser tools, the prepare-manual-apply graph doesn't either, etc.).

## 5. Graphs

### 5.1 Score Job (`graphs/score-job.ts`)

Inputs: `{ job, profile, searchPreferences }`. Output: `{ score: 0–100, justification: string }`.

A single LLM call. No tools. The prompt (`prompts/score.ts`) instructs the model to:

- Compare the job description to the profile bio, default CV's extracted text, and search preferences
- Return JSON `{ score, justification }`. Scores reflect: title fit (40%), skills overlap (30%), seniority (15%), location/work-model fit (15%)
- Use `withStructuredOutput` (zod) so the result is parsed and validated

Used identically for both auto and manual-apply jobs.

### 5.2 Tailor CV (`graphs/tailor-cv.ts`)

Inputs: `{ jobId, cvId, applicationId }`. Output: `{ tailoredCvPath }`.

The graph:

1. Fetches the source CV's extracted text and the job description
2. Calls the LLM with a structured prompt that returns a tailored CV as a structured object — sections (`summary`, `experience[]`, `skills[]`, `education[]`, `extras[]`)
3. Renders that structured object to a DOCX using `docx-js` (the orchestrator owns the rendering — keeps the LLM focused on content, not formatting)
4. Calls `saveTailoredCv` with the buffer

Contract on the LLM: must not invent employment, education, or skills the user does not have. Must rephrase, reorder, and emphasise. The system prompt says so explicitly and gives examples of what's allowed and what isn't.

Used identically for both auto and manual-apply jobs.

### 5.3 Tailor Cover Letter (`graphs/tailor-cover-letter.ts`)

Inputs: `{ jobId, coverLetterId, applicationId }`. Output: `{ tailoredCoverLetterPath }`.

Mirror of the CV tailoring graph, but for cover letters. Only invoked when:

- The user has a default cover letter configured
- For manual-apply: always (since the user is going to need it externally)
- For auto-apply: only if the target site's form has a cover letter field (decided by the apply graph based on `inspectFormFields`)

### 5.4 Apply (`graphs/apply.ts`) — auto-apply only

The most complex graph. Modelled as a LangGraph `StateGraph` with explicit states. **Only invoked for jobs with `apply_method='auto'`.** The server's task dispatcher routes manual-apply jobs to `prepare-manual-apply` instead.

**State shape:**

```ts
type ApplyState = {
  applicationId: string;
  jobId: string;
  cvId: string;
  formId?: string;
  fields?: FormField[];
  unknownFieldKey?: string;
  outcome?: 'submitted' | 'awaiting_user' | 'awaiting_approval' | 'failed';
  failureReason?: string;
  errors: string[];
};
```

**Nodes:**

```
load_inputs      → loads profile, job, settings; verifies job.apply_method === 'auto'
        ↓
ensure_tailored  → if no tailored CV yet, runs tailor-cv graph; otherwise skip
        ↓
review_gate      → if approval = 'review-first' and not yet approved:
                     create alert(awaiting_approval), set outcome, END
        ↓
open_form        → calls openJobApplication
        ↓
inspect_fields   → calls inspectFormFields
        ↓
fill_loop        → for each field:
                     if known (profile or profile_answers) → fillField
                     if unknown                            → set unknownFieldKey, jump to alert_unknown
                     if file (CV/cover letter)            → upload
        ↓
submit           → calls submitForm
                     ok               → outcome = 'submitted'
                     captcha          → alert + outcome = 'awaiting_user'
                     session_expired  → alert + outcome = 'awaiting_user'
                     other            → outcome = 'failed'

alert_unknown    → createAlert(missing_field, payload={ key, prompt })
                   set outcome = 'awaiting_user'
                   END
```

If `load_inputs` finds `job.apply_method !== 'auto'`, the graph throws — the server should never have routed it here. This is a defensive check, not a routing decision.

### 5.5 Prepare Manual Apply (`graphs/prepare-manual-apply.ts`)

A small graph used for manual-apply jobs. It is much simpler than the apply graph because no browser is involved.

**State shape:**

```ts
type PrepareManualApplyState = {
  applicationId: string;
  jobId: string;
  cvId: string;
  coverLetterId?: string;
  outcome?: 'ready' | 'awaiting_approval' | 'failed';
  errors: string[];
};
```

**Nodes:**

```
load_inputs      → loads profile, job, settings; verifies job.apply_method === 'manual'
        ↓
tailor_cv        → runs the tailor-cv graph
        ↓
tailor_cover     → if user has a default cover letter, runs the tailor-cover-letter graph; otherwise skip
        ↓
review_gate      → if approval = 'review-first' and not yet approved:
                     create alert(awaiting_approval), set outcome = 'awaiting_approval', END
        ↓
mark_ready       → calls markReadyForManualApply
                   creates alert(ready_for_manual_apply, payload={ external_apply_url, tailored_cv_path })
                   outcome = 'ready'
                   END
```

The graph has no browser-tool calls and no LLM in the inner loop after tailoring — the tailor sub-graphs are the only LLM calls. Determinism is high.

### 5.6 Chat (`graphs/chat.ts`)

A standard LangChain ReAct loop with the full `ToolKit` bound. Memory:

- Sliding window of the last 30 messages from `chat_messages`
- A condensed running summary of older messages (computed every K messages by an inexpensive call)
- The user's profile and `profile_answers` injected into the system prompt as context
- A list of currently-open alerts (including `ready_for_manual_apply` alerts) injected at the top of every turn

The chatbot can resolve alerts by calling `resolveAlert` — when it does, the corresponding application is re-enqueued by the server (server reacts to the alert resolution, not to the chat turn directly).

For `ready_for_manual_apply` alerts specifically, the chatbot can answer questions like "what's ready for me to apply to manually?" and surface the list with their external URLs. The user marks them applied through the UI button, not through chat (to avoid accidental "I applied" claims that don't match reality).

## 6. Prompts

Prompts live in code (TypeScript template literals exporting strings) so they can be unit-tested. Each prompt file exports:

- `systemPrompt: string`
- `userTemplate(input): string`
- `responseSchema: ZodSchema` (for structured output)

All system prompts share the base:

```
You are Vina, a job-application assistant running on the user's machine.
You have access to the user's profile, CVs, cover letters, prior answers, and the
ability to drive a browser. Never fabricate facts about the user. If you do not
know something, say so or call the appropriate tool.
```

## 7. Determinism and Temperature

- Score graph: temperature 0
- Tailor graph: temperature 0.3 (some creative rephrasing)
- Tailor cover letter graph: temperature 0.4 (more voice-y)
- Apply graph LLM calls (label mapping, value derivation): temperature 0
- Prepare manual apply: no LLM calls beyond what the tailor sub-graphs make
- Chat graph: temperature 0.4

These are defaults; settings exposes a hidden override for power users.

## 8. Token Budgets

Each graph has a hard cap on total tokens it will spend per invocation, enforced by counting input + estimated output. Caps:

- Score: 4k tokens total
- Tailor CV: 12k tokens total
- Tailor cover letter: 6k tokens total
- Apply (per call within the graph): 2k tokens
- Prepare manual apply: inherits the tailor-cv and tailor-cover-letter budgets
- Chat: 16k tokens total per turn

Exceeding a cap throws `ProviderError('budget_exceeded')` and the application is failed/retried.

## 9. Testing

- Each graph has unit tests using a fake `BaseChatModel` that returns canned messages, asserting state transitions
- Each tool call is mocked via a fake `ToolKit`
- Integration tests run against a local Ollama with a small model; these are tagged `@slow` and skipped in CI by default
- Prompt regression tests assert structure of structured-output responses against fixtures
- The prepare-manual-apply graph has tests that assert no browser tools are bound and no browser tool calls are made

## 10. Failure Modes

- LLM returns invalid JSON → retry once with a "fix-up" turn ("the previous response was not valid JSON, return the same content as valid JSON only"); if still invalid, fail
- LLM returns refusal → log, fail the task with `ProviderError('refused')`
- Tool throws → propagate to the graph, mark current state error, advance to a terminal `failed` outcome
- Provider 429 or 5xx → exponential backoff, up to 3 retries

## 11. Public Exports

```ts
// packages/orchestrator/src/index.ts
export { buildModel } from './providers/registry';
export { runScoreJob } from './graphs/score-job';
export { runTailorCv } from './graphs/tailor-cv';
export { runTailorCoverLetter } from './graphs/tailor-cover-letter';
export { runApply } from './graphs/apply';
export { runPrepareManualApply } from './graphs/prepare-manual-apply';
export { runChat } from './graphs/chat';
export type { ToolKit } from './tools/types';
```

The server imports these and nothing else from the orchestrator package.
