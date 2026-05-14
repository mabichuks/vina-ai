# Manual-Apply Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wake the dormant `cv-service` / `cover-letter-service` shells and the dormant `applications` table to deliver a working manual-apply pipeline per `docs/superpowers/specs/2026-05-13-manual-apply-pipeline-design.md`. For every job marked `apply_method='manual'` (LinkedIn external + every Google Jobs listing), Vina tailors materials (CV + optional cover letter) and surfaces them in a Ready-to-Apply UI with download buttons, an external Apply link, and Mark-applied / Skip actions that auto-resolve the alert.

**Architecture:** Three new LangGraph entry points (`tailor-cv`, `tailor-cover-letter`, `prepare-manual-apply`) — the first two are single-call structured-output graphs that produce structured content; deterministic renderers laid out via `docx` produce the actual DOCX files. The `prepare-manual-apply` graph wires the two as nodes and returns final state; the queue handler in `packages/server/src/queue/handlers/prepare-manual-apply.ts` invokes it, persists outputs, transitions the application, inserts an alert, and emits events. The orchestrator gains a new `tools/` directory housing **interface-only** `saveTailoredCv` / `saveTailoredCoverLetter` tools; the server provides implementations under `packages/server/src/orchestrator/tools/` and injects them at task-handler invocation per ADR-016 and `docs/langgraph-orchestrator.md` §4. Seven new HTTP routes ship under `/api/jobs/:id/prepare` and `/api/applications/*`. Autonomy lives entirely in the score handler — `settings.mode='autonomous'` + `match_score >= score_threshold` + `apply_method='manual'` enqueues `prepare_manual_apply` via the same internal helper as the manual `POST /jobs/:id/prepare`. Frontend gets a re-activated `/ready` route with a card list, a `Ready to apply` sidebar nav with action-required badge, "Prepare materials" actions on the Jobs page, a Dashboard tile, and an inline Alerts card for `ready_for_manual_apply`.

**Tech Stack:** TypeScript, Node ≥20, pnpm workspaces, Fastify + `@fastify/websocket`, better-sqlite3, LangGraph orchestrator (already wired through the score handler), `docx` npm package for deterministic DOCX rendering (new dependency, justified below), React 18 + Vite + Tailwind + TanStack Query + Zustand, Vitest, Playwright Test for live-update smoke checks.

**Status notes from the codebase audit:**

- `packages/orchestrator/src/tools/` does **not** exist yet — Phase 2 creates it. `packages/server/src/orchestrator/` does **not** exist yet either — Phase 2 creates that too (it houses server-side tool implementations).
- `packages/server/src/db/repositories/applications.ts` **already exists** with `listApplications`, `findApplicationById`, `insertApplication`, `updateApplicationStatus`, `updateApplicationFormState`, `markApplicationApplied`. Phase 7 extends it with `setTailoredPaths`, `transitionApplicationStatus` (a thin wrapper over `updateApplicationStatus` that emits the right side-effects), `findActiveApplicationForJob`, and `markApplicationSkipped`. **No churn to the existing exports.**
- The `applications` table in `001_init.sql` already has every column the spec assumes: `tailored_cv_path`, `tailored_cover_letter_path`, `applied_manually_at`, `applied_manually_notes`. The schema does **not** carry a `tailored_at` column today, and the spec §1.2 lists it in the orchestration update payload — Phase 1 either adds the column via a small `004_manual_apply_pipeline.sql` migration or stores it implicitly inside the `submitted_at` semantics. **Decision:** add `tailored_at TEXT` in migration 004 — it's the cheapest way to support the Ready-to-Apply card's "Tailored 12s ago" line and is a write-once column with no CHECK constraint rewrite needed.
- `applications.status` already enforces the full enum including `ready_for_manual_apply`, `applied_manually`, `skipped`, `failed`. No CHECK rewrite needed. `application_events.kind` already includes `ready_for_manual_apply` and `applied_manually`.
- `task_queue.kind` already accepts `prepare_manual_apply` (declared in `packages/shared/src/enums.ts:67-75`). The worker registers handlers per kind from a sparse map — Phase 6 adds the handler entry; no enum churn.
- `alerts.kind` already includes `ready_for_manual_apply` (LinkedIn slice migration 002 widened it). Phase 1 does **not** need to widen the alert kind set.
- `EVENTS.APPLICATION_READY_FOR_MANUAL_APPLY` and `EVENTS.APPLICATION_APPLIED_MANUALLY` are already declared in `packages/shared/src/events.ts:12-13` with their payload schemas. Phase 1 adds **one** new event: `application:skipped`. The two existing events keep their current shape; we may widen `ApplicationReadyForManualApplyPayload` if a field is missing.
- `docx` (npm) is **not** currently a dependency of `@vina/orchestrator`. Phase 3 installs it. Justification: the LLM produces structured content; the deterministic renderer needs a maintained library that emits valid `.docx`. `docx` is the most-downloaded option, ESM-friendly, and zero-native — fine for a pure-library package.
- The Phase A (Google Jobs) slice introduced migration **003**. Phase B uses **004**.
- The score handler (`packages/server/src/queue/handlers/score.ts`) does **not** currently consult `settings.mode` or `score_threshold` post-scoring. Phase 8 adds the autonomy branch.
- `packages/web/src/router.tsx:107-109` currently has `{ path: '/ready', element: <Navigate to="/jobs" replace /> }`. Phase 9 swaps this for a real lazy-loaded `ReadyToApplyPage`.
- `packages/web/src/components/layout/Sidebar.tsx:8-15` does **not** include a Ready-to-Apply entry. Phase 9 re-adds it with an action-required badge counting open `ready_for_manual_apply` alerts.
- `packages/web/src/routes/jobs/JobCard.tsx` hard-codes "Apply on LinkedIn" as the primary action. Phase 10 adds a `manual` branch ("Prepare materials") in front of the existing button row.
- The Dashboard (`packages/web/src/routes/pages.tsx`) does not yet have a Ready-to-Apply tile. Phase 10 adds one.
- The Alerts page (`packages/web/src/routes/alerts/AlertsPage.tsx`) does not handle the `ready_for_manual_apply` kind specially today. Phase 11 adds the inline card.

**Coding conventions reminder (from CLAUDE.md):**

- Strict TypeScript; `kebab-case.ts` for modules, `PascalCase.tsx` for components.
- No default exports except React pages and Vite entrypoints.
- Comment _why_, not _what_; prefer no comments.
- Conventional Commits scoped by package: `feat(server): …`, `feat(orchestrator): …`, `feat(web): …`.
- One commit per task; **never** include "Claude" or "Co-Authored-By Claude" in commit messages.
- Strict `pnpm test` and `pnpm lint` pass before declaring work done.

---

## Phase 1 — Schema confirmation, shared types, events

### Task 1: Forward-only migration `004_manual_apply_pipeline.sql`

**Files:**
- Create: `packages/server/migrations/004_manual_apply_pipeline.sql`
- Test: `packages/server/tests/db/migrations.test.ts` (extend)

The only schema gap surfaced by the audit is the `applications.tailored_at` column the spec references in §1.2. Everything else (status enum, event kinds, task kinds, alert kinds, the rest of the applications columns) already exists. This migration is intentionally tiny.

- [ ] **Step 1: Read existing migrations test to understand conventions**

Run: `cat packages/server/tests/db/migrations.test.ts | head -120`

Expected: see the `freshTestDb()` helper and the per-migration `describe` blocks added for `002_linkedin_e2e_schema` and `003_google_jobs_source`. Mirror the pattern.

- [ ] **Step 2: Write the failing test** — append a new `describe` block to `packages/server/tests/db/migrations.test.ts`:

```ts
describe('004_manual_apply_pipeline', () => {
  it('adds tailored_at column to applications', () => {
    const db = freshTestDb();
    const cols = db.prepare(`PRAGMA table_info(applications)`).all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('tailored_at')).toBe(true);
    db.close();
  });

  it('preserves all existing application rows during the migration', () => {
    // freshTestDb runs every migration in order; we just need to verify a
    // representative row can be inserted *after* migration 004 has run.
    const db = freshTestDb();
    seedJobAndCv(db);
    db.prepare(
      `INSERT INTO applications
         (id, job_id, cv_id, apply_method, status, started_at)
       VALUES ('a1', 'j1', 'cv1', 'manual', 'queued', ?)`,
    ).run(new Date().toISOString());
    const row = db.prepare(`SELECT tailored_at FROM applications WHERE id='a1'`).get() as
      | { tailored_at: string | null }
      | undefined;
    expect(row?.tailored_at).toBeNull();
    db.close();
  });
});
```

(`seedJobAndCv` is the same fixture helper introduced by earlier migration tests — extend `tests/db/helpers.ts` if it doesn't yet expose enough columns.)

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- migrations`
Expected: FAIL — `tailored_at` column missing.

- [ ] **Step 4: Write the migration SQL**

Create `packages/server/migrations/004_manual_apply_pipeline.sql`:

```sql
-- 004_manual_apply_pipeline.sql
-- Adds tailored_at to applications so the Ready-to-Apply UI can render
-- "Tailored N seconds ago" and the prepare_manual_apply handler can stamp
-- the transition timestamp. Forward-only. No CHECK changes; the
-- applications.status enum already covers the new flow.

ALTER TABLE applications ADD COLUMN tailored_at TEXT;
```

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm --filter @vina/server test -- migrations`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/migrations/004_manual_apply_pipeline.sql packages/server/tests/db/migrations.test.ts
git commit -m "feat(server): add migration 004 for applications.tailored_at"
```

---

### Task 2: Add `application:skipped` event + widen ready_for_manual_apply payload

**Files:**
- Modify: `packages/shared/src/events.ts`
- Test: `packages/shared/tests/events.test.ts` (extend)

The two existing manual-apply events (`application:ready_for_manual_apply`, `application:applied_manually`) already live in `events.ts`. Phase B adds one new event for the skip transition and widens the ready-payload to include `job_id` and the optional `tailored_cover_letter_path` per spec §6.1.

- [ ] **Step 1: Write the failing test** — append to `packages/shared/tests/events.test.ts`:

```ts
import { EVENTS, EVENT_PAYLOADS } from '../src/events.js';

describe('EVENTS — manual-apply slice additions', () => {
  it('declares application:skipped', () => {
    expect(EVENTS.APPLICATION_SKIPPED).toBe('application:skipped');
  });

  it('application:skipped payload accepts an optional reason', () => {
    const schema = EVENT_PAYLOADS['application:skipped'];
    expect(() =>
      schema.parse({ application_id: 'a1', skipped_at: new Date().toISOString() }),
    ).not.toThrow();
    expect(() =>
      schema.parse({
        application_id: 'a1',
        skipped_at: new Date().toISOString(),
        reason: 'role mismatch',
      }),
    ).not.toThrow();
  });

  it('application:ready_for_manual_apply payload exposes job_id and an optional cover_letter_path', () => {
    const schema = EVENT_PAYLOADS['application:ready_for_manual_apply'];
    expect(() =>
      schema.parse({
        application_id: 'a1',
        job_id: 'j1',
        external_apply_url: 'https://example.com/apply',
        tailored_cv_path: '/tmp/cv.docx',
        tailored_cover_letter_path: null,
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @vina/shared test -- events`
Expected: FAIL.

- [ ] **Step 3: Update events.ts**

In `packages/shared/src/events.ts`, add the new event entry:

```ts
export const EVENTS = {
  // …existing entries…
  APPLICATION_SKIPPED: 'application:skipped',
  // …
} as const;
```

Update the `ApplicationReadyForManualApplyPayload` schema:

```ts
const ApplicationReadyForManualApplyPayload = z.object({
  application_id: z.string(),
  job_id: z.string(),
  external_apply_url: z.url(),
  tailored_cv_path: z.string(),
  tailored_cover_letter_path: z.string().nullable(),
});
```

Add the new payload schema and register it:

```ts
const ApplicationSkippedPayload = z.object({
  application_id: z.string(),
  skipped_at: isoDate,
  reason: z.string().optional(),
});

// …inside EVENT_PAYLOADS…
[EVENTS.APPLICATION_SKIPPED]: ApplicationSkippedPayload,
```

- [ ] **Step 4: Run the test, expect pass + clean build**

Run: `pnpm --filter @vina/shared test -- events && pnpm --filter @vina/shared build`
Expected: PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/events.ts packages/shared/tests/events.test.ts
git commit -m "feat(shared): add application:skipped event and widen ready payload"
```

---

## Phase 2 — Orchestrator: tool kit boundary

### Task 3: `packages/orchestrator/src/tools/` — interface-only Tool definitions

**Files:**
- Create: `packages/orchestrator/src/tools/types.ts`
- Create: `packages/orchestrator/src/tools/save-tailored-cv.ts`
- Create: `packages/orchestrator/src/tools/save-tailored-cover-letter.ts`
- Modify: `packages/orchestrator/src/index.ts` (export new types)
- Test: `packages/orchestrator/tests/tools/tool-kit.test.ts`

These three files declare the `ManualApplyToolKit` interface and its two zod-typed Tool descriptors. They never touch the filesystem — server-side implementations (Task 4) wire to disk.

- [ ] **Step 1: Read existing orchestrator surface to mirror conventions**

Run: `cat packages/orchestrator/src/index.ts packages/orchestrator/src/graphs/resolve-selector.ts | head -60`

Expected: notice that resolve-selector takes the model and input only — no I/O. Tools that need to write the world are passed by the caller. Mirror that pattern.

- [ ] **Step 2: Write the failing test** — create `packages/orchestrator/tests/tools/tool-kit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  SaveTailoredCvInputSchema,
  SaveTailoredCoverLetterInputSchema,
  type ManualApplyToolKit,
} from '../../src/tools/types.js';

describe('manual-apply tool kit schemas', () => {
  it('SaveTailoredCvInputSchema accepts an application_id and a Buffer', () => {
    const buf = Buffer.from('docx-bytes', 'utf8');
    const parsed = SaveTailoredCvInputSchema.parse({ application_id: 'a1', docx: buf });
    expect(parsed.application_id).toBe('a1');
    expect(Buffer.isBuffer(parsed.docx)).toBe(true);
  });

  it('SaveTailoredCoverLetterInputSchema requires application_id and Buffer', () => {
    expect(() => SaveTailoredCoverLetterInputSchema.parse({ application_id: 'a1' })).toThrow();
  });

  it('ManualApplyToolKit is interface-only — callers supply the implementation', () => {
    const fake: ManualApplyToolKit = {
      saveTailoredCv: async () => ({ path: '/tmp/a.docx' }),
      saveTailoredCoverLetter: async () => ({ path: '/tmp/a-cover.docx' }),
    };
    expect(typeof fake.saveTailoredCv).toBe('function');
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/orchestrator test -- tool-kit`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the tool-kit module**

Create `packages/orchestrator/src/tools/types.ts`:

```ts
import { z } from 'zod';

/**
 * Buffer is not a built-in zod type. We use a refinement so the schema works
 * in browsers (Buffer is undefined there) and Node alike — the orchestrator
 * runs in Node, but typecheck happens against the shared bundle.
 */
const BufferSchema = z.custom<Buffer>(
  (v) => typeof Buffer !== 'undefined' && Buffer.isBuffer(v),
  { message: 'expected Node Buffer' },
);

export const SaveTailoredCvInputSchema = z.object({
  application_id: z.string().min(1),
  docx: BufferSchema,
});
export type SaveTailoredCvInput = z.infer<typeof SaveTailoredCvInputSchema>;

export const SaveTailoredCoverLetterInputSchema = z.object({
  application_id: z.string().min(1),
  docx: BufferSchema,
});
export type SaveTailoredCoverLetterInput = z.infer<typeof SaveTailoredCoverLetterInputSchema>;

export interface SaveTailoredFileResult {
  /** Absolute on-disk path. The server resolves relative paths against dataDir. */
  path: string;
}

/**
 * Tool kit passed into the prepare-manual-apply graph at invocation time.
 * The orchestrator never imports the server or automation packages; the
 * caller supplies the implementations (see packages/server/src/orchestrator/
 * tools/). This mirrors the selectorResolver DI in resolve-selector.ts.
 */
export interface ManualApplyToolKit {
  saveTailoredCv(input: SaveTailoredCvInput): Promise<SaveTailoredFileResult>;
  saveTailoredCoverLetter(input: SaveTailoredCoverLetterInput): Promise<SaveTailoredFileResult>;
}
```

Create `packages/orchestrator/src/tools/save-tailored-cv.ts`:

```ts
/**
 * Re-export of the schema + types for the saveTailoredCv tool. Kept in its
 * own file so callers (server tool factories, future LangChain Tool wrappers)
 * can import a single narrow surface.
 */
export {
  SaveTailoredCvInputSchema,
  type SaveTailoredCvInput,
  type SaveTailoredFileResult,
} from './types.js';
```

Create `packages/orchestrator/src/tools/save-tailored-cover-letter.ts`:

```ts
export {
  SaveTailoredCoverLetterInputSchema,
  type SaveTailoredCoverLetterInput,
  type SaveTailoredFileResult,
} from './types.js';
```

Add the public exports in `packages/orchestrator/src/index.ts`:

```ts
export {
  type ManualApplyToolKit,
  type SaveTailoredCvInput,
  type SaveTailoredCoverLetterInput,
  type SaveTailoredFileResult,
  SaveTailoredCvInputSchema,
  SaveTailoredCoverLetterInputSchema,
} from './tools/types.js';
```

- [ ] **Step 5: Run the test, expect pass + clean build**

Run: `pnpm --filter @vina/orchestrator test -- tool-kit && pnpm --filter @vina/orchestrator build`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/tools/ packages/orchestrator/src/index.ts packages/orchestrator/tests/tools/
git commit -m "feat(orchestrator): add ManualApplyToolKit interface and tool schemas"
```

---

### Task 4: Server-side tool implementations

**Files:**
- Create: `packages/server/src/orchestrator/tools/index.ts`
- Create: `packages/server/src/orchestrator/tools/save-tailored-cv.ts`
- Create: `packages/server/src/orchestrator/tools/save-tailored-cover-letter.ts`
- Test: `packages/server/tests/orchestrator/tools/save-tailored.test.ts`

The server provides the actual filesystem writes. The factory takes `dataDir` and returns a `ManualApplyToolKit`. Files land in `<dataDir>/files/tailored/<application_id>.docx` and `<dataDir>/files/tailored-cover-letters/<application_id>.docx` with 0600 permissions per spec §4.2.

- [ ] **Step 1: Write the failing test** — create `packages/server/tests/orchestrator/tools/save-tailored.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createManualApplyToolKit } from '../../../src/orchestrator/tools/index.js';

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-tk-'));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('manual-apply tool kit (server impl)', () => {
  it('saveTailoredCv writes to <dataDir>/files/tailored/<app_id>.docx with 0600 perms', async () => {
    const kit = createManualApplyToolKit({ dataDir });
    const buf = Buffer.from('docx-bytes', 'utf8');
    const result = await kit.saveTailoredCv({ application_id: 'a1', docx: buf });
    expect(result.path).toBe(path.join(dataDir, 'files', 'tailored', 'a1.docx'));
    expect(fs.readFileSync(result.path).toString()).toBe('docx-bytes');
    const stat = fs.statSync(result.path);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('saveTailoredCoverLetter writes under files/tailored-cover-letters/', async () => {
    const kit = createManualApplyToolKit({ dataDir });
    const result = await kit.saveTailoredCoverLetter({
      application_id: 'a2',
      docx: Buffer.from('cl', 'utf8'),
    });
    expect(result.path).toBe(
      path.join(dataDir, 'files', 'tailored-cover-letters', 'a2.docx'),
    );
  });

  it('creates the target directory on demand', async () => {
    const kit = createManualApplyToolKit({ dataDir });
    await kit.saveTailoredCv({ application_id: 'a3', docx: Buffer.from('x') });
    expect(fs.existsSync(path.join(dataDir, 'files', 'tailored'))).toBe(true);
  });

  it('rejects application_ids containing path separators', async () => {
    const kit = createManualApplyToolKit({ dataDir });
    await expect(
      kit.saveTailoredCv({ application_id: '../escape', docx: Buffer.from('x') }),
    ).rejects.toThrow(/invalid/i);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @vina/server test -- save-tailored`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the factory**

Create `packages/server/src/orchestrator/tools/save-tailored-cv.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from '@vina/shared';
import type {
  SaveTailoredCvInput,
  SaveTailoredFileResult,
} from '@vina/orchestrator';

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function saveTailoredCvImpl(
  dataDir: string,
): (input: SaveTailoredCvInput) => Promise<SaveTailoredFileResult> {
  return async ({ application_id, docx }) => {
    if (!SAFE_ID.test(application_id)) {
      throw new ValidationError(`invalid application_id: ${application_id}`);
    }
    const dir = path.join(dataDir, 'files', 'tailored');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${application_id}.docx`);
    fs.writeFileSync(target, docx, { mode: 0o600 });
    return { path: target };
  };
}
```

Create `packages/server/src/orchestrator/tools/save-tailored-cover-letter.ts` (same shape under `files/tailored-cover-letters/`).

Create `packages/server/src/orchestrator/tools/index.ts`:

```ts
import type { ManualApplyToolKit } from '@vina/orchestrator';
import { saveTailoredCvImpl } from './save-tailored-cv.js';
import { saveTailoredCoverLetterImpl } from './save-tailored-cover-letter.js';

export interface ToolKitOptions {
  dataDir: string;
}

export function createManualApplyToolKit(opts: ToolKitOptions): ManualApplyToolKit {
  return {
    saveTailoredCv: saveTailoredCvImpl(opts.dataDir),
    saveTailoredCoverLetter: saveTailoredCoverLetterImpl(opts.dataDir),
  };
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @vina/server test -- save-tailored`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/orchestrator/ packages/server/tests/orchestrator/
git commit -m "feat(server): add manual-apply tool kit with 0600 file persistence"
```

---

## Phase 3 — Orchestrator: tailor-cv graph

### Task 5: Install `docx` and add `tailor-cv` prompt

**Files:**
- Modify: `packages/orchestrator/package.json`
- Create: `packages/orchestrator/src/prompts/tailor-cv.ts`
- Test: `packages/orchestrator/tests/prompts/tailor-cv.test.ts`

- [ ] **Step 1: Read the existing score prompt to mirror conventions**

Run: `cat packages/orchestrator/src/prompts/score.ts`

Expected: a system constant with a rubric + a function building the user prompt from typed input. Mirror the structure and snapshot-test discipline (PRD-110).

- [ ] **Step 2: Write the failing test** — create `packages/orchestrator/tests/prompts/tailor-cv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  TAILOR_CV_SYSTEM,
  tailorCvUserPrompt,
  type TailorCvInput,
} from '../../src/prompts/tailor-cv.js';

const BASE: TailorCvInput = {
  job: {
    title: 'Senior TypeScript Engineer',
    company: 'Acme Corp',
    description: 'We build Postgres pipelines and TypeScript APIs.',
  },
  source_cv_text: 'Worked at FooCo 2020-2024 on Node services.',
  user_profile: { full_name: 'Pat Doe', bio: 'Generalist engineer.' },
};

describe('TAILOR_CV_SYSTEM', () => {
  it('forbids fact invention explicitly', () => {
    expect(TAILOR_CV_SYSTEM).toMatch(/do not (invent|fabricate|make up)/i);
  });

  it('shows a worked example of acceptable rephrasing', () => {
    expect(TAILOR_CV_SYSTEM).toMatch(/example/i);
    expect(TAILOR_CV_SYSTEM).toMatch(/rephrase/i);
  });
});

describe('tailorCvUserPrompt', () => {
  it('places the job listing before the source CV', () => {
    const out = tailorCvUserPrompt(BASE);
    expect(out.indexOf('## Job')).toBeLessThan(out.indexOf('## Source CV'));
  });

  it('includes the user profile', () => {
    const out = tailorCvUserPrompt(BASE);
    expect(out).toContain('Pat Doe');
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/orchestrator test -- tailor-cv`
Expected: FAIL.

- [ ] **Step 4: Install `docx` and add the prompt**

Run (from repo root):

```bash
pnpm --filter @vina/orchestrator add docx@^9
```

(`docx` is a maintained ESM-first library that emits valid `.docx`. Pin major-9 — its API has been stable since 8.x. Justification logged in `docs/decisions.md` if a follow-up ADR is desired; for this slice we add a one-line note in the spec instead.)

Create `packages/orchestrator/src/prompts/tailor-cv.ts`:

```ts
export interface TailorCvInput {
  job: {
    title: string;
    company: string;
    description: string;
  };
  source_cv_text: string;
  user_profile: {
    full_name: string;
    bio: string | null;
  };
}

export const TAILOR_CV_SYSTEM = `You are Vina, a CV tailor.

Given a job listing and a user's source CV, produce a structured rewrite that emphasises the bits of the user's experience most relevant to this job. You are not writing fiction — every claim in the output MUST trace back to the source CV.

## Hard rules

- DO NOT invent employers, dates, titles, technologies, certifications, or quantitative outcomes that are not in the source CV.
- DO NOT fabricate metrics ("scaled to 1M users") if the source CV does not state them.
- DO rephrase, re-order, and select what to surface. Promote skills that overlap with the job description; drop bullets that are irrelevant.
- DO keep all dates, employers, titles, and proper nouns verbatim from the source CV.
- DO write in the user's voice (first-person implicit, past tense for past roles).

## Example

Source CV says: "FooCo, 2020-2024 — built Postgres ingestion pipeline handling 50k events/min."
Job wants: "Postgres expertise, high-throughput data engineering."

GOOD rewrite: "FooCo, 2020-2024 — designed and ran a Postgres ingestion pipeline at 50k events/min, with Postgres tuning and partitioning as the operative bottleneck."
BAD rewrite: "FooCo, 2020-2024 — scaled Postgres pipeline to 5M events/min using citus and BigQuery." (invented numbers + invented tech)

## Output schema

Return JSON exactly matching:

{
  "summary": "<2-3 sentence top-of-CV summary tailored to the job>",
  "bullets": [{ "section": "<Section label, e.g. 'FooCo, 2020-2024'>", "bullet": "<single rewritten bullet>" }],
  "skills": ["<promoted skill>", "..."]
}

Sections in "bullets" should match the source CV's section headings as closely as possible. Bullets are single-sentence prose, not nested lists.`;

export function tailorCvUserPrompt(input: TailorCvInput): string {
  const { job, source_cv_text, user_profile } = input;
  const lines: string[] = [];

  lines.push('## Job');
  lines.push(`Title: ${job.title}`);
  lines.push(`Company: ${job.company}`);
  lines.push('Description:');
  lines.push(job.description);
  lines.push('');

  lines.push('## User profile');
  lines.push(`Name: ${user_profile.full_name}`);
  if (user_profile.bio) lines.push(`Bio: ${user_profile.bio}`);
  lines.push('');

  lines.push('## Source CV');
  lines.push(source_cv_text);

  return lines.join('\n');
}
```

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm --filter @vina/orchestrator test -- tailor-cv && pnpm --filter @vina/orchestrator build`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/package.json packages/orchestrator/src/prompts/tailor-cv.ts packages/orchestrator/tests/prompts/tailor-cv.test.ts pnpm-lock.yaml
git commit -m "feat(orchestrator): add tailor-cv prompt and install docx"
```

---

### Task 6: `tailor-cv` graph + deterministic DOCX renderer

**Files:**
- Create: `packages/orchestrator/src/graphs/tailor-cv.ts`
- Modify: `packages/orchestrator/src/index.ts` (export `runTailorCv`)
- Test: `packages/orchestrator/tests/graphs/tailor-cv.test.ts`

A single `withStructuredOutput` call (single-node bypass per `docs/langgraph-orchestrator.md` §5) with temperature 0.4, plus a pure deterministic renderer. Truncation per spec §3.4: CV at 3500 tokens (~14000 chars), job description at 1500 tokens (~6000 chars).

- [ ] **Step 1: Read score-job.ts to mirror the StructuredScorer interface and retry pattern**

Run: `cat packages/orchestrator/src/graphs/score-job.ts`

Expected: a structured-output runnable + a 2-attempt loop. Reuse the same pattern.

- [ ] **Step 2: Write the failing test** — create `packages/orchestrator/tests/graphs/tailor-cv.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runTailorCv, renderTailoredDocx } from '../../src/graphs/tailor-cv.js';
import type { TailorCvInput } from '../../src/prompts/tailor-cv.js';
import type { StructuredScorer } from '../../src/graphs/score-job.js';

const INPUT: TailorCvInput = {
  job: { title: 'Senior TS Engineer', company: 'Acme', description: 'TS APIs' },
  source_cv_text: 'FooCo 2020-2024 — Node services.',
  user_profile: { full_name: 'Pat Doe', bio: 'Engineer.' },
};

function fakeModel(output: unknown, throws?: number): StructuredScorer {
  let n = 0;
  return {
    withStructuredOutput: () => ({
      invoke: vi.fn(async () => {
        n += 1;
        if (throws && n <= throws) throw new Error('llm jitter');
        return output;
      }),
    }),
  } as unknown as StructuredScorer;
}

describe('runTailorCv', () => {
  it('returns a parsed structured TailorCvOutput on first success', async () => {
    const model = fakeModel({
      summary: 'Sr TS eng. 4yrs Node.',
      bullets: [{ section: 'FooCo', bullet: 'Built Node services.' }],
      skills: ['typescript', 'node'],
    });
    const out = await runTailorCv(INPUT, model);
    expect(out.summary).toContain('TS');
    expect(out.bullets).toHaveLength(1);
    expect(out.skills).toContain('typescript');
  });

  it('retries once on a thrown LLM error then succeeds', async () => {
    const model = fakeModel(
      { summary: 's', bullets: [], skills: [] },
      1,
    );
    const out = await runTailorCv(INPUT, model);
    expect(out.summary).toBe('s');
  });

  it('throws ProviderError after second failure', async () => {
    const model = fakeModel(null, 2);
    await expect(runTailorCv(INPUT, model)).rejects.toThrow(/tailor.*failed/i);
  });

  it('truncates source_cv_text over 14000 chars before sending', async () => {
    const long = 'a'.repeat(20000);
    let capturedMessages: Array<{ content: string }> = [];
    const model: StructuredScorer = {
      withStructuredOutput: () => ({
        invoke: vi.fn(async (msgs: Array<{ content: string }>) => {
          capturedMessages = msgs;
          return { summary: 's', bullets: [], skills: [] };
        }),
      }),
    } as unknown as StructuredScorer;
    await runTailorCv({ ...INPUT, source_cv_text: long }, model);
    const user = capturedMessages.find((m) => m.content.includes('## Source CV'))!;
    expect(user.content.length).toBeLessThan(20000);
  });
});

describe('renderTailoredDocx', () => {
  it('produces a non-empty Buffer that starts with the docx zip magic', () => {
    const buf = renderTailoredDocx(
      { summary: 'sum', bullets: [{ section: 'Acme', bullet: 'b1' }], skills: ['ts'] },
      { full_name: 'Pat Doe', email: 'p@x.com' },
    );
    expect(buf.length).toBeGreaterThan(200);
    // docx files are zips; PK\x03\x04 is the zip local-file-header signature.
    expect(buf.subarray(0, 2).toString()).toBe('PK');
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/orchestrator test -- tailor-cv`
Expected: FAIL — `runTailorCv`/`renderTailoredDocx` undefined.

- [ ] **Step 4: Implement the graph + renderer**

Create `packages/orchestrator/src/graphs/tailor-cv.ts`:

```ts
import { z } from 'zod';
import { ProviderError } from '@vina/shared';
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
} from 'docx';
import {
  TAILOR_CV_SYSTEM,
  tailorCvUserPrompt,
  type TailorCvInput,
} from '../prompts/tailor-cv.js';
import type { StructuredScorer, ScoreMessages } from './score-job.js';

export const TailorCvOutputSchema = z.object({
  summary: z.string().min(1),
  bullets: z.array(z.object({ section: z.string(), bullet: z.string() })),
  skills: z.array(z.string()),
});
export type TailorCvOutput = z.infer<typeof TailorCvOutputSchema>;

const MAX_ATTEMPTS = 2;
const MAX_CV_CHARS = 14_000;  // ~3500 tokens at 4 chars/token
const MAX_JOB_CHARS = 6_000;  // ~1500 tokens

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n[…truncated]`;
}

export async function runTailorCv(
  input: TailorCvInput,
  model: StructuredScorer,
): Promise<TailorCvOutput> {
  const trimmed: TailorCvInput = {
    ...input,
    source_cv_text: truncate(input.source_cv_text, MAX_CV_CHARS),
    job: { ...input.job, description: truncate(input.job.description, MAX_JOB_CHARS) },
  };

  const structured = model.withStructuredOutput(TailorCvOutputSchema);
  const messages: ScoreMessages = [
    { role: 'system', content: TAILOR_CV_SYSTEM },
    { role: 'user', content: tailorCvUserPrompt(trimmed) },
  ];

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await structured.invoke(messages);
    } catch (err) {
      lastError = err;
    }
  }
  throw new ProviderError('tailor-cv graph failed after retry', {
    cause: lastError instanceof Error ? lastError.message : String(lastError),
  });
}

export interface TailorCvHeader {
  full_name: string;
  email: string;
}

/**
 * Pure, deterministic — produces a single-section DOCX with header / summary /
 * grouped experience bullets / skills. No LLM involvement past this point so
 * the file is guaranteed to be valid. MVP single template per spec §3.1.
 */
export function renderTailoredDocx(out: TailorCvOutput, header: TailorCvHeader): Buffer {
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: header.full_name, bold: true })],
    }),
  );
  children.push(
    new Paragraph({ children: [new TextRun({ text: header.email })] }),
  );
  children.push(new Paragraph({ text: '' }));

  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: 'Summary' }));
  children.push(new Paragraph({ text: out.summary }));
  children.push(new Paragraph({ text: '' }));

  // Group bullets by section.
  const bySection = new Map<string, string[]>();
  for (const b of out.bullets) {
    const arr = bySection.get(b.section) ?? [];
    arr.push(b.bullet);
    bySection.set(b.section, arr);
  }

  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: 'Experience' }));
  for (const [section, bullets] of bySection) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: section }));
    for (const bullet of bullets) {
      children.push(new Paragraph({ text: bullet, bullet: { level: 0 } }));
    }
  }
  children.push(new Paragraph({ text: '' }));

  if (out.skills.length > 0) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: 'Skills' }));
    children.push(new Paragraph({ text: out.skills.join(' · ') }));
  }

  const doc = new Document({ sections: [{ children }] });
  // Packer.toBuffer is sync-returns-Promise; the renderer stays sync from the
  // caller's perspective by awaiting at the boundary in the graph wrapper.
  return Packer.toBuffer(doc) as unknown as Buffer;
}
```

Note: `Packer.toBuffer` returns `Promise<Buffer>` in newer `docx` versions. If the test fails because of the await boundary, change `renderTailoredDocx` to `async` and the caller (Task 8) to await it. Verify exact signature when implementing.

Append to `packages/orchestrator/src/index.ts`:

```ts
export {
  runTailorCv,
  renderTailoredDocx,
  TailorCvOutputSchema,
  type TailorCvOutput,
  type TailorCvHeader,
} from './graphs/tailor-cv.js';
export {
  TAILOR_CV_SYSTEM,
  tailorCvUserPrompt,
  type TailorCvInput,
} from './prompts/tailor-cv.js';
```

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm --filter @vina/orchestrator test -- tailor-cv && pnpm --filter @vina/orchestrator build`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/graphs/tailor-cv.ts packages/orchestrator/src/index.ts packages/orchestrator/tests/graphs/tailor-cv.test.ts
git commit -m "feat(orchestrator): add tailor-cv graph and deterministic DOCX renderer"
```

---

## Phase 4 — Orchestrator: tailor-cover-letter graph

### Task 7: `tailor-cover-letter` prompt, graph, and renderer

**Files:**
- Create: `packages/orchestrator/src/prompts/tailor-cover-letter.ts`
- Create: `packages/orchestrator/src/graphs/tailor-cover-letter.ts`
- Modify: `packages/orchestrator/src/index.ts` (export)
- Test: `packages/orchestrator/tests/graphs/tailor-cover-letter.test.ts`

Same shape as Task 5 + Task 6 fused — single LLM call, deterministic renderer.

- [ ] **Step 1: Read tailor-cv.ts as the template**

Run: `cat packages/orchestrator/src/graphs/tailor-cv.ts`

Expected: clear scaffold to mirror.

- [ ] **Step 2: Write the failing test** — create `packages/orchestrator/tests/graphs/tailor-cover-letter.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  runTailorCoverLetter,
  renderTailoredCoverLetterDocx,
} from '../../src/graphs/tailor-cover-letter.js';
import type { TailorCoverLetterInput } from '../../src/prompts/tailor-cover-letter.js';
import type { StructuredScorer } from '../../src/graphs/score-job.js';

const INPUT: TailorCoverLetterInput = {
  job: { title: 'Sr TS Eng', company: 'Acme', description: 'TS APIs' },
  source_template: 'Dear Hiring Manager, I am writing about your role.',
  user_profile: { full_name: 'Pat Doe', bio: 'Engineer.' },
};

function fakeModel(output: unknown): StructuredScorer {
  return {
    withStructuredOutput: () => ({
      invoke: vi.fn(async () => output),
    }),
  } as unknown as StructuredScorer;
}

describe('runTailorCoverLetter', () => {
  it('returns structured greeting, body, closing', async () => {
    const model = fakeModel({
      greeting: 'Dear Acme team,',
      body_paragraphs: ['I have 4 years of TS.', 'I lead small teams.'],
      closing: 'Sincerely, Pat Doe',
    });
    const out = await runTailorCoverLetter(INPUT, model);
    expect(out.greeting).toBe('Dear Acme team,');
    expect(out.body_paragraphs).toHaveLength(2);
    expect(out.closing).toContain('Pat Doe');
  });
});

describe('renderTailoredCoverLetterDocx', () => {
  it('produces a non-empty zip Buffer', () => {
    const buf = renderTailoredCoverLetterDocx(
      {
        greeting: 'Dear team,',
        body_paragraphs: ['Para one.', 'Para two.'],
        closing: 'Sincerely, P',
      },
      { full_name: 'Pat Doe', email: 'p@x.com' },
    );
    expect(buf.length).toBeGreaterThan(200);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/orchestrator test -- tailor-cover-letter`
Expected: FAIL.

- [ ] **Step 4: Implement prompt, graph, renderer**

Create `packages/orchestrator/src/prompts/tailor-cover-letter.ts`:

```ts
export interface TailorCoverLetterInput {
  job: { title: string; company: string; description: string };
  source_template: string;
  user_profile: { full_name: string; bio: string | null };
}

export const TAILOR_COVER_LETTER_SYSTEM = `You are Vina, a cover-letter tailor.

Take a user's cover-letter template (or general bio) and adapt it to a specific job. Same rules as the CV tailor: rephrase, don't invent. The template may be a generic skeleton — fill it with the user's bio + job-specific framing.

## Hard rules

- DO NOT invent employers, dates, or quantitative claims absent from the template/bio.
- DO match the company name and job title verbatim from the listing.
- DO keep the user's voice. If the template is formal, stay formal; if casual, stay casual.
- 3-4 short paragraphs total. No lists.

## Example

Template: "I'm a backend engineer looking for new opportunities."
Job: "Senior TS Engineer at Acme — Postgres pipelines."

GOOD: "I'm reaching out about the Senior TypeScript Engineer role at Acme. My recent work has centred on Postgres-backed pipelines, and the scope you've described maps closely to the systems I've shipped over the past four years."
BAD: "I led a 200-person team at Acme's competitor and would love to bring that to you." (invented role + invented past)

## Output schema

{
  "greeting": "<e.g. 'Dear Acme team,'>",
  "body_paragraphs": ["<para 1>", "<para 2>", "<para 3>"],
  "closing": "<e.g. 'Sincerely, Pat Doe'>"
}`;

export function tailorCoverLetterUserPrompt(input: TailorCoverLetterInput): string {
  const { job, source_template, user_profile } = input;
  return [
    '## Job',
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    'Description:',
    job.description,
    '',
    '## User profile',
    `Name: ${user_profile.full_name}`,
    user_profile.bio ? `Bio: ${user_profile.bio}` : '',
    '',
    '## Source template',
    source_template,
  ].join('\n');
}
```

Create `packages/orchestrator/src/graphs/tailor-cover-letter.ts` with the same structure as tailor-cv.ts:

```ts
import { z } from 'zod';
import { ProviderError } from '@vina/shared';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import {
  TAILOR_COVER_LETTER_SYSTEM,
  tailorCoverLetterUserPrompt,
  type TailorCoverLetterInput,
} from '../prompts/tailor-cover-letter.js';
import type { StructuredScorer, ScoreMessages } from './score-job.js';

export const TailorCoverLetterOutputSchema = z.object({
  greeting: z.string().min(1),
  body_paragraphs: z.array(z.string()).min(1),
  closing: z.string().min(1),
});
export type TailorCoverLetterOutput = z.infer<typeof TailorCoverLetterOutputSchema>;

const MAX_ATTEMPTS = 2;
const MAX_TEMPLATE_CHARS = 8_000;
const MAX_JOB_CHARS = 6_000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n[…truncated]`;
}

export async function runTailorCoverLetter(
  input: TailorCoverLetterInput,
  model: StructuredScorer,
): Promise<TailorCoverLetterOutput> {
  const trimmed: TailorCoverLetterInput = {
    ...input,
    source_template: truncate(input.source_template, MAX_TEMPLATE_CHARS),
    job: { ...input.job, description: truncate(input.job.description, MAX_JOB_CHARS) },
  };
  const structured = model.withStructuredOutput(TailorCoverLetterOutputSchema);
  const messages: ScoreMessages = [
    { role: 'system', content: TAILOR_COVER_LETTER_SYSTEM },
    { role: 'user', content: tailorCoverLetterUserPrompt(trimmed) },
  ];

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await structured.invoke(messages);
    } catch (err) {
      lastError = err;
    }
  }
  throw new ProviderError('tailor-cover-letter graph failed after retry', {
    cause: lastError instanceof Error ? lastError.message : String(lastError),
  });
}

export interface CoverLetterHeader {
  full_name: string;
  email: string;
}

export function renderTailoredCoverLetterDocx(
  out: TailorCoverLetterOutput,
  header: CoverLetterHeader,
): Buffer {
  const children: Paragraph[] = [];

  children.push(new Paragraph({ children: [new TextRun({ text: header.full_name, bold: true })] }));
  children.push(new Paragraph({ children: [new TextRun({ text: header.email })] }));
  children.push(new Paragraph({ text: '' }));

  children.push(new Paragraph({ text: out.greeting }));
  children.push(new Paragraph({ text: '' }));

  for (const para of out.body_paragraphs) {
    children.push(new Paragraph({ text: para }));
    children.push(new Paragraph({ text: '' }));
  }

  children.push(new Paragraph({ text: out.closing }));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc) as unknown as Buffer;
}
```

Append to `packages/orchestrator/src/index.ts`:

```ts
export {
  runTailorCoverLetter,
  renderTailoredCoverLetterDocx,
  TailorCoverLetterOutputSchema,
  type TailorCoverLetterOutput,
  type CoverLetterHeader,
} from './graphs/tailor-cover-letter.js';
export {
  TAILOR_COVER_LETTER_SYSTEM,
  tailorCoverLetterUserPrompt,
  type TailorCoverLetterInput,
} from './prompts/tailor-cover-letter.js';
```

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm --filter @vina/orchestrator test -- tailor-cover-letter && pnpm --filter @vina/orchestrator build`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/prompts/tailor-cover-letter.ts packages/orchestrator/src/graphs/tailor-cover-letter.ts packages/orchestrator/src/index.ts packages/orchestrator/tests/graphs/tailor-cover-letter.test.ts
git commit -m "feat(orchestrator): add tailor-cover-letter graph and renderer"
```

---

## Phase 5 — Orchestrator: prepare-manual-apply graph

### Task 8: `prepare-manual-apply` orchestrator graph

**Files:**
- Create: `packages/orchestrator/src/graphs/prepare-manual-apply.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Test: `packages/orchestrator/tests/graphs/prepare-manual-apply.test.ts`

Three logical nodes per spec §3.3: `tailor_cv` → optional `tailor_cover_letter` → `save_and_finish`. The graph never touches the DB — it only invokes the tailor graphs and the injected tool kit, returns final state. Implementation choice: a small async function with explicit branches is enough — wrapping in LangGraph's `StateGraph` adds ceremony for three linear nodes. The graph signature still mirrors a LangGraph node: take state, return state. (`docs/langgraph-orchestrator.md` §5 single-node bypass extends here because the only branching is a `cover_letter_template` null check.)

- [ ] **Step 1: Read prep notes** — re-read spec §3.3 + §3.4 and `docs/langgraph-orchestrator.md` §5.

- [ ] **Step 2: Write the failing test** — create `packages/orchestrator/tests/graphs/prepare-manual-apply.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  runPrepareManualApply,
  type PrepareManualApplyInput,
  type PrepareManualApplyResult,
} from '../../src/graphs/prepare-manual-apply.js';
import type { StructuredScorer } from '../../src/graphs/score-job.js';
import type { ManualApplyToolKit } from '../../src/tools/types.js';

const BASE_INPUT: PrepareManualApplyInput = {
  application_id: 'a1',
  job: { title: 'Sr TS Eng', company: 'Acme', description: 'TS APIs' },
  cv: { text: 'FooCo 2020-2024.' },
  cover_letter_template: null,
  user_profile: { full_name: 'Pat Doe', email: 'p@x.com', bio: 'Engineer.' },
};

function modelFor(outputs: unknown[]): StructuredScorer {
  let i = 0;
  return {
    withStructuredOutput: () => ({
      invoke: vi.fn(async () => outputs[i++]),
    }),
  } as unknown as StructuredScorer;
}

function fakeToolKit(): ManualApplyToolKit {
  return {
    saveTailoredCv: vi.fn(async ({ application_id }) => ({
      path: `/tmp/${application_id}.docx`,
    })),
    saveTailoredCoverLetter: vi.fn(async ({ application_id }) => ({
      path: `/tmp/${application_id}-cover.docx`,
    })),
  };
}

describe('runPrepareManualApply', () => {
  it('runs only tailor_cv when cover_letter_template is null', async () => {
    const tk = fakeToolKit();
    const model = modelFor([
      { summary: 's', bullets: [], skills: [] },
    ]);
    const out: PrepareManualApplyResult = await runPrepareManualApply(BASE_INPUT, model, tk);
    expect(out.tailored_cv_path).toBe('/tmp/a1.docx');
    expect(out.tailored_cover_letter_path).toBeNull();
    expect(tk.saveTailoredCoverLetter).not.toHaveBeenCalled();
  });

  it('also runs tailor_cover_letter when template provided', async () => {
    const tk = fakeToolKit();
    const model = modelFor([
      { summary: 's', bullets: [], skills: [] },
      {
        greeting: 'Dear',
        body_paragraphs: ['p1'],
        closing: 'Sincerely',
      },
    ]);
    const out = await runPrepareManualApply(
      { ...BASE_INPUT, cover_letter_template: { text: 'Dear Sir/Madam,' } },
      model,
      tk,
    );
    expect(out.tailored_cv_path).toBe('/tmp/a1.docx');
    expect(out.tailored_cover_letter_path).toBe('/tmp/a1-cover.docx');
    expect(tk.saveTailoredCoverLetter).toHaveBeenCalledOnce();
  });

  it('surfaces the failing stage when tailor_cv throws', async () => {
    const tk = fakeToolKit();
    const model: StructuredScorer = {
      withStructuredOutput: () => ({
        invoke: vi.fn(async () => {
          throw new Error('llm down');
        }),
      }),
    } as unknown as StructuredScorer;
    await expect(
      runPrepareManualApply(BASE_INPUT, model, tk),
    ).rejects.toMatchObject({ stage: 'tailor_cv' });
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/orchestrator test -- prepare-manual-apply`
Expected: FAIL.

- [ ] **Step 4: Implement the graph**

Create `packages/orchestrator/src/graphs/prepare-manual-apply.ts`:

```ts
import type { StructuredScorer } from './score-job.js';
import {
  runTailorCv,
  renderTailoredDocx,
  type TailorCvHeader,
} from './tailor-cv.js';
import {
  runTailorCoverLetter,
  renderTailoredCoverLetterDocx,
  type CoverLetterHeader,
} from './tailor-cover-letter.js';
import type { ManualApplyToolKit } from '../tools/types.js';

export interface PrepareManualApplyInput {
  application_id: string;
  job: { title: string; company: string; description: string };
  cv: { text: string };
  cover_letter_template: { text: string } | null;
  user_profile: { full_name: string; email: string; bio: string | null };
}

export interface PrepareManualApplyResult {
  application_id: string;
  tailored_cv_path: string;
  tailored_cover_letter_path: string | null;
}

export class PrepareManualApplyError extends Error {
  constructor(
    public readonly stage: 'tailor_cv' | 'tailor_cover_letter' | 'save_cv' | 'save_cover_letter',
    cause: unknown,
  ) {
    super(`prepare-manual-apply failed at stage=${stage}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PrepareManualApplyError';
  }
}

export async function runPrepareManualApply(
  input: PrepareManualApplyInput,
  model: StructuredScorer,
  toolKit: ManualApplyToolKit,
): Promise<PrepareManualApplyResult> {
  // Node 1: tailor_cv
  let cvDocx: Buffer;
  try {
    const cvOut = await runTailorCv(
      {
        job: input.job,
        source_cv_text: input.cv.text,
        user_profile: { full_name: input.user_profile.full_name, bio: input.user_profile.bio },
      },
      model,
    );
    const header: TailorCvHeader = {
      full_name: input.user_profile.full_name,
      email: input.user_profile.email,
    };
    cvDocx = renderTailoredDocx(cvOut, header);
  } catch (err) {
    throw new PrepareManualApplyError('tailor_cv', err);
  }

  // Save CV (failure here is a save-stage error, not tailor-stage).
  let tailored_cv_path: string;
  try {
    const saved = await toolKit.saveTailoredCv({
      application_id: input.application_id,
      docx: cvDocx,
    });
    tailored_cv_path = saved.path;
  } catch (err) {
    throw new PrepareManualApplyError('save_cv', err);
  }

  // Node 2: tailor_cover_letter (conditional)
  let tailored_cover_letter_path: string | null = null;
  if (input.cover_letter_template) {
    let clDocx: Buffer;
    try {
      const clOut = await runTailorCoverLetter(
        {
          job: input.job,
          source_template: input.cover_letter_template.text,
          user_profile: { full_name: input.user_profile.full_name, bio: input.user_profile.bio },
        },
        model,
      );
      const header: CoverLetterHeader = {
        full_name: input.user_profile.full_name,
        email: input.user_profile.email,
      };
      clDocx = renderTailoredCoverLetterDocx(clOut, header);
    } catch (err) {
      throw new PrepareManualApplyError('tailor_cover_letter', err);
    }
    try {
      const saved = await toolKit.saveTailoredCoverLetter({
        application_id: input.application_id,
        docx: clDocx,
      });
      tailored_cover_letter_path = saved.path;
    } catch (err) {
      throw new PrepareManualApplyError('save_cover_letter', err);
    }
  }

  return {
    application_id: input.application_id,
    tailored_cv_path,
    tailored_cover_letter_path,
  };
}
```

Append to `packages/orchestrator/src/index.ts`:

```ts
export {
  runPrepareManualApply,
  PrepareManualApplyError,
  type PrepareManualApplyInput,
  type PrepareManualApplyResult,
} from './graphs/prepare-manual-apply.js';
```

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm --filter @vina/orchestrator test -- prepare-manual-apply && pnpm --filter @vina/orchestrator build`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/graphs/prepare-manual-apply.ts packages/orchestrator/src/index.ts packages/orchestrator/tests/graphs/prepare-manual-apply.test.ts
git commit -m "feat(orchestrator): add prepare-manual-apply graph"
```

---

## Phase 6 — Server: prepare-manual-apply queue handler

### Task 9: `prepare_manual_apply` queue handler + worker registration

**Files:**
- Create: `packages/server/src/queue/handlers/prepare-manual-apply.ts`
- Modify: `packages/server/src/main.ts` (register handler)
- Test: `packages/server/tests/queue/handlers/prepare-manual-apply.test.ts`

The handler loads application + job + CV + optional cover-letter template, builds the orchestrator input, invokes the graph with the injected tool kit, persists tailored paths, transitions the application to `ready_for_manual_apply`, inserts a `ready_for_manual_apply` alert, and emits both `application:ready_for_manual_apply` and `alert:created`. On terminal failure (after retries exhausted upstream), the existing worker `onTerminalFailure` hook emits `apply_failed`.

- [ ] **Step 1: Read score.ts handler to mirror DI + DB-write conventions**

Run: `cat packages/server/src/queue/handlers/score.ts`

Expected: clean handler shape with `buildModel` factory, transactional writes, single emit. Mirror it.

- [ ] **Step 2: Write the failing test** — create `packages/server/tests/queue/handlers/prepare-manual-apply.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { freshTestDb } from '../../db/helpers.js';
import { createEventBus } from '../../../src/events/bus.js';
import { upsertProfile } from '../../../src/db/repositories/profile.js';
import { insertCv } from '../../../src/db/repositories/cvs.js';
import { insertCoverLetter } from '../../../src/db/repositories/cover-letters.js';
import { insertJob } from '../../../src/db/repositories/jobs.js';
import {
  insertApplication,
  findApplicationById,
} from '../../../src/db/repositories/applications.js';
import { listAlerts } from '../../../src/db/repositories/alerts.js';
import { createManualApplyToolKit } from '../../../src/orchestrator/tools/index.js';
import { createPrepareManualApplyHandler } from '../../../src/queue/handlers/prepare-manual-apply.js';
import type { StructuredScorer } from '@vina/orchestrator';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

let db: DatabaseType;
let dataDir: string;
beforeEach(() => {
  db = freshTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-pma-'));
  upsertProfile(db, { full_name: 'Pat Doe', email: 'p@x.com' });
});
afterEach(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function seedManualJobAndApp() {
  const cv = insertCv(db, {
    label: 'main',
    original_filename: 'cv.pdf',
    mime_type: 'application/pdf',
    file_path: '/tmp/cv.pdf',
    extracted_text: 'FooCo 2020-2024.',
    is_default: true,
  });
  const job = insertJob(db, {
    site_id: 'linkedin',
    external_id: 'j1',
    url: 'https://linkedin.com/jobs/view/j1',
    apply_method: 'manual',
    title: 'Senior TS Engineer',
    company: 'Acme',
    description: 'TS APIs.',
    external_apply_url: 'https://greenhouse.io/apply/j1',
  });
  const app = insertApplication(db, {
    job_id: job.id,
    cv_id: cv.id,
    apply_method: 'manual',
    status: 'queued',
  });
  return { cv, job, app };
}

function fakeModel(outputs: unknown[]): BaseChatModel {
  let i = 0;
  return {
    withStructuredOutput: () => ({
      invoke: vi.fn(async () => outputs[i++]),
    }),
  } as unknown as BaseChatModel;
}

describe('prepare_manual_apply handler', () => {
  it('happy path: tailors CV (no cover letter), persists paths, transitions to ready_for_manual_apply, inserts alert, emits events', async () => {
    const { app, job } = seedManualJobAndApp();
    const bus = createEventBus();
    const readyEvents: unknown[] = [];
    bus.on('application:ready_for_manual_apply', (p) => readyEvents.push(p));

    const handler = createPrepareManualApplyHandler({
      db,
      bus,
      buildModel: async () => fakeModel([{ summary: 's', bullets: [], skills: [] }]),
      toolKit: createManualApplyToolKit({ dataDir }),
    });

    await handler({ application_id: app.id });

    const after = findApplicationById(db, app.id)!;
    expect(after.status).toBe('ready_for_manual_apply');
    expect(after.tailored_cv_path).toMatch(/files\/tailored\/.*\.docx$/);
    expect(after.tailored_cover_letter_path).toBeNull();

    const alerts = listAlerts(db, { kind: 'ready_for_manual_apply' });
    expect(alerts).toHaveLength(1);
    expect(JSON.parse(alerts[0]!.payload!)).toMatchObject({
      application_id: app.id,
      job_id: job.id,
      external_apply_url: 'https://greenhouse.io/apply/j1',
    });

    expect(readyEvents).toHaveLength(1);
  });

  it('tailors cover letter when one is uploaded', async () => {
    const cl = insertCoverLetter(db, {
      label: 'main',
      original_filename: 'cl.pdf',
      mime_type: 'application/pdf',
      file_path: '/tmp/cl.pdf',
      extracted_text: 'Dear Sir/Madam,',
      is_default: true,
    });
    const { app } = seedManualJobAndApp();
    // Attach the cover letter to the application row.
    db.prepare(`UPDATE applications SET cover_letter_id = ? WHERE id = ?`).run(cl.id, app.id);

    const handler = createPrepareManualApplyHandler({
      db,
      bus: createEventBus(),
      buildModel: async () =>
        fakeModel([
          { summary: 's', bullets: [], skills: [] },
          { greeting: 'Dear', body_paragraphs: ['p'], closing: 'Sincerely' },
        ]),
      toolKit: createManualApplyToolKit({ dataDir }),
    });
    await handler({ application_id: app.id });

    const after = findApplicationById(db, app.id)!;
    expect(after.tailored_cover_letter_path).toMatch(/tailored-cover-letters\/.*\.docx$/);
  });

  it('throws on LLM failure so the worker retries (status stays queued)', async () => {
    const { app } = seedManualJobAndApp();
    const handler = createPrepareManualApplyHandler({
      db,
      bus: createEventBus(),
      buildModel: async () =>
        ({
          withStructuredOutput: () => ({
            invoke: async () => {
              throw new Error('5xx');
            },
          }),
        }) as unknown as BaseChatModel,
      toolKit: createManualApplyToolKit({ dataDir }),
    });

    await expect(handler({ application_id: app.id })).rejects.toThrow();
    expect(findApplicationById(db, app.id)?.status).toBe('queued');
  });

  it('fails fast with ConflictError if the application has no CV', async () => {
    const job = insertJob(db, {
      site_id: 'linkedin',
      external_id: 'j2',
      url: 'https://linkedin.com/x',
      apply_method: 'manual',
      title: 't',
      company: 'c',
      description: 'd',
    });
    // No CV row; build a synthetic application with a missing cv_id.
    db.prepare(
      `INSERT INTO applications (id, job_id, cv_id, apply_method, status, started_at)
       VALUES ('a-orphan', ?, 'cv-missing', 'manual', 'queued', ?)`,
    ).run(job.id, new Date().toISOString());

    const handler = createPrepareManualApplyHandler({
      db,
      bus: createEventBus(),
      buildModel: async () => fakeModel([]),
      toolKit: createManualApplyToolKit({ dataDir }),
    });
    await expect(handler({ application_id: 'a-orphan' })).rejects.toThrow(/cv/i);
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/server test -- prepare-manual-apply`
Expected: FAIL — handler missing.

- [ ] **Step 4: Implement the handler**

Create `packages/server/src/queue/handlers/prepare-manual-apply.ts`:

```ts
import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  runPrepareManualApply,
  PrepareManualApplyError,
  type ManualApplyToolKit,
  type StructuredScorer,
} from '@vina/orchestrator';
import { ConflictError, createLogger, NotFoundError, newId } from '@vina/shared';
import { findApplicationById } from '../../db/repositories/applications.js';
import { setApplicationTailored } from '../../db/repositories/applications.js';
import { findJobById } from '../../db/repositories/jobs.js';
import { findCvById } from '../../db/repositories/cvs.js';
import { findCoverLetterById } from '../../db/repositories/cover-letters.js';
import { findProfile } from '../../db/repositories/profile.js';
import { insertAlert } from '../../db/repositories/alerts.js';
import type { EventBus } from '../../events/bus.js';

const log = createLogger('handler.prepare_manual_apply');

export interface PrepareManualApplyHandlerDeps {
  db: DatabaseType;
  bus: EventBus;
  buildModel: () => Promise<BaseChatModel>;
  toolKit: ManualApplyToolKit;
}

export interface PrepareManualApplyPayload {
  application_id: string;
}

export function createPrepareManualApplyHandler(
  deps: PrepareManualApplyHandlerDeps,
): (payload: PrepareManualApplyPayload) => Promise<void> {
  return async (payload) => {
    const app = findApplicationById(deps.db, payload.application_id);
    if (!app) throw new NotFoundError(`Application ${payload.application_id} not found`);

    const job = findJobById(deps.db, app.job_id);
    if (!job) throw new NotFoundError(`Job ${app.job_id} not found`);

    const cv = findCvById(deps.db, app.cv_id);
    if (!cv) throw new ConflictError('Application has no CV — upload one in Profile first');

    const coverLetter = app.cover_letter_id
      ? findCoverLetterById(deps.db, app.cover_letter_id)
      : null;

    const profile = findProfile(deps.db);
    if (!profile) throw new ConflictError('Profile not configured — cannot tailor');

    const model = await deps.buildModel();

    const result = await runPrepareManualApply(
      {
        application_id: app.id,
        job: {
          title: job.title,
          company: job.company,
          description: job.description,
        },
        cv: { text: cv.extracted_text ?? '' },
        cover_letter_template:
          coverLetter && coverLetter.extracted_text
            ? { text: coverLetter.extracted_text }
            : null,
        user_profile: {
          full_name: profile.full_name,
          email: profile.email,
          bio: profile.bio,
        },
      },
      model as unknown as StructuredScorer,
      deps.toolKit,
    );

    // Persist tailored paths + transition status atomically.
    deps.db.transaction(() => {
      setApplicationTailored(deps.db, app.id, {
        tailored_cv_path: result.tailored_cv_path,
        tailored_cover_letter_path: result.tailored_cover_letter_path,
        tailored_at: new Date().toISOString(),
        new_status: 'ready_for_manual_apply',
      });

      insertAlert(deps.db, {
        id: newId(),
        kind: 'ready_for_manual_apply',
        severity: 'action_required',
        title: `Tailored materials ready for ${job.title} @ ${job.company}`,
        description: 'Download the tailored CV and apply externally, then mark applied.',
        application_id: app.id,
        payload: {
          application_id: app.id,
          job_id: job.id,
          external_apply_url: job.external_apply_url ?? job.url,
          tailored_cv_path: result.tailored_cv_path,
          tailored_cover_letter_path: result.tailored_cover_letter_path,
        },
      });
    })();

    deps.bus.emit('application:ready_for_manual_apply', {
      application_id: app.id,
      job_id: job.id,
      external_apply_url: job.external_apply_url ?? job.url,
      tailored_cv_path: result.tailored_cv_path,
      tailored_cover_letter_path: result.tailored_cover_letter_path,
    });
    deps.bus.emit('jobs:updated', { ids: [job.id] });

    log.info(
      {
        application_id: app.id,
        cv_path: result.tailored_cv_path,
        cover_letter: !!result.tailored_cover_letter_path,
      },
      'manual-apply preparation complete',
    );
  };
}
```

Add `setApplicationTailored` to `packages/server/src/db/repositories/applications.ts`:

```ts
export function setApplicationTailored(
  db: DatabaseType,
  id: string,
  patch: {
    tailored_cv_path: string;
    tailored_cover_letter_path: string | null;
    tailored_at: string;
    new_status: ApplicationStatus;
  },
): Application {
  const current = findApplicationById(db, id);
  if (!current) throw new NotFoundError(`Application ${id} not found`);
  db.prepare(
    `UPDATE applications
       SET tailored_cv_path = ?,
           tailored_cover_letter_path = ?,
           tailored_at = ?,
           status = ?
     WHERE id = ?`,
  ).run(
    patch.tailored_cv_path,
    patch.tailored_cover_letter_path,
    patch.tailored_at,
    patch.new_status,
    id,
  );
  return findApplicationById(db, id)!;
}
```

(Also widen the `ApplicationRow` interface to include `tailored_at: string | null`. Verify exact signature when implementing — `findCvById` / `findCoverLetterById` may need adding if they don't already exist in their repos.)

Register the handler in `packages/server/src/main.ts`. After the existing `score: adapt(...)` handler entry, add:

```ts
import { createPrepareManualApplyHandler } from './queue/handlers/prepare-manual-apply.js';
import { createManualApplyToolKit } from './orchestrator/tools/index.js';

  const manualApplyToolKit = createManualApplyToolKit({ dataDir: config.dataDir });

  const handlers: TaskHandlers = {
    search: adapt(createSearchHandler({ /* ... */ })),
    score: adapt(createScoreHandler({ /* ... */ })),
    prepare_manual_apply: adapt(
      createPrepareManualApplyHandler({
        db,
        bus,
        buildModel: () => getActiveChatModel(db),
        toolKit: manualApplyToolKit,
      }),
    ),
  };
```

Extend the existing `onTerminalFailure` hook so `prepare_manual_apply` terminal failures emit `apply_failed`:

```ts
  const worker = createWorker({
    db, bus, handlers,
    onTerminalFailure: (task, reason) => {
      if (task.kind === 'score') {
        insertAlert(db, { kind: 'score_failed', /* ... */ });
      } else if (task.kind === 'prepare_manual_apply') {
        const payload = JSON.parse(task.payload) as { application_id?: string };
        // Best-effort: transition the application to 'failed' so the UI
        // doesn't show a stuck "Tailoring…" card.
        if (payload.application_id) {
          updateApplicationStatus(db, payload.application_id, 'failed', {
            failure_reason: reason,
          });
        }
        insertAlert(db, {
          kind: 'apply_failed',
          severity: 'error',
          title: 'Tailoring failed',
          description: reason,
          application_id: payload.application_id ?? null,
          payload: { task_id: task.id, kind: 'prepare_manual_apply' },
        });
      }
    },
  });
```

- [ ] **Step 5: Run the tests, expect pass**

Run: `pnpm --filter @vina/server test -- prepare-manual-apply`
Expected: PASS (all four cases).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/queue/handlers/prepare-manual-apply.ts packages/server/src/db/repositories/applications.ts packages/server/src/main.ts packages/server/tests/queue/handlers/prepare-manual-apply.test.ts
git commit -m "feat(server): add prepare_manual_apply queue handler"
```

---

## Phase 7 — Server: applications repository + HTTP routes

### Task 10: Extend applications repository with helpers the routes need

**Files:**
- Modify: `packages/server/src/db/repositories/applications.ts`
- Test: `packages/server/tests/db/applications.test.ts` (extend; create if needed)

Helpers needed by Task 11's routes: `findActiveApplicationForJob`, `markApplicationSkipped`, `paginatedListApplications` (or accept a pagination patch on `listApplications`). `setApplicationTailored` already added in Task 9.

- [ ] **Step 1: Read the existing repo** to understand current exports and the `Application` type.

Run: `cat packages/server/src/db/repositories/applications.ts`

- [ ] **Step 2: Write the failing test** — extend or create `packages/server/tests/db/applications.test.ts`:

```ts
describe('applications repository — manual-apply helpers', () => {
  it('findActiveApplicationForJob returns the most recent non-terminal row', () => {
    const { cv, job } = seedFixtures();
    // Skipped is terminal — must NOT be returned.
    insertApplication(db, { job_id: job.id, cv_id: cv.id, apply_method: 'manual', status: 'skipped' });
    const ready = insertApplication(db, {
      job_id: job.id, cv_id: cv.id, apply_method: 'manual', status: 'ready_for_manual_apply',
    });
    const found = findActiveApplicationForJob(db, job.id);
    expect(found?.id).toBe(ready.id);
  });

  it('returns null when only terminal applications exist', () => {
    const { cv, job } = seedFixtures();
    insertApplication(db, { job_id: job.id, cv_id: cv.id, apply_method: 'manual', status: 'failed' });
    expect(findActiveApplicationForJob(db, job.id)).toBeNull();
  });

  it('markApplicationSkipped flips status + stores reason', () => {
    const { cv, job } = seedFixtures();
    const app = insertApplication(db, {
      job_id: job.id, cv_id: cv.id, apply_method: 'manual', status: 'ready_for_manual_apply',
    });
    const next = markApplicationSkipped(db, app.id, 'role mismatch');
    expect(next.status).toBe('skipped');
    expect(next.failure_reason).toBe('role mismatch');
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/server test -- applications`
Expected: FAIL.

- [ ] **Step 4: Add helpers**

Append to `packages/server/src/db/repositories/applications.ts`:

```ts
const TERMINAL_STATUSES: ReadonlySet<ApplicationStatus> = new Set([
  'applied_manually',
  'submitted',
  'failed',
  'skipped',
]);

export function findActiveApplicationForJob(
  db: DatabaseType,
  jobId: string,
): Application | null {
  const rows = db
    .prepare(
      `SELECT * FROM applications
         WHERE job_id = ?
         ORDER BY started_at DESC, id DESC`,
    )
    .all(jobId) as ApplicationRow[];
  for (const row of rows) {
    if (!TERMINAL_STATUSES.has(row.status)) return rowToApplication(row);
  }
  return null;
}

export function markApplicationSkipped(
  db: DatabaseType,
  id: string,
  reason?: string,
): Application {
  const current = findApplicationById(db, id);
  if (!current) throw new NotFoundError(`Application ${id} not found`);
  db.prepare(
    `UPDATE applications SET status = 'skipped', failure_reason = ? WHERE id = ?`,
  ).run(reason ?? null, id);
  return findApplicationById(db, id)!;
}
```

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm --filter @vina/server test -- applications`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/repositories/applications.ts packages/server/tests/db/applications.test.ts
git commit -m "feat(server): add applications repo helpers for manual-apply"
```

---

### Task 11: Applications HTTP routes (7 endpoints)

**Files:**
- Create: `packages/server/src/http/routes/applications.ts`
- Modify: `packages/server/src/app.ts` (register)
- Modify: `packages/server/src/http/routes/jobs.ts` (add `POST /api/jobs/:id/prepare`)
- Modify: `packages/server/src/queue/manual-apply-enqueuer.ts` (NEW — shared helper)
- Test: `packages/server/tests/http/applications.test.ts`

The seven endpoints from spec §4.3 plus the `POST /api/jobs/:id/prepare` initiator. The `prepare` endpoint and the autonomy branch in Phase 8 share the same internal helper — extract it into `packages/server/src/queue/manual-apply-enqueuer.ts`.

- [ ] **Step 1: Read existing jobs routes + alerts repo helpers** to understand `resolveAlert` and `findAlertById` signatures.

Run: `cat packages/server/src/http/routes/jobs.ts packages/server/src/db/repositories/alerts.ts | head -120`

- [ ] **Step 2: Write the failing test** — create `packages/server/tests/http/applications.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, type TestAppHandle } from './helpers.js';
import { insertJob } from '../../src/db/repositories/jobs.js';
import { insertCv } from '../../src/db/repositories/cvs.js';
import { insertApplication } from '../../src/db/repositories/applications.js';
import { insertAlert, listAlerts } from '../../src/db/repositories/alerts.js';
import { listPending } from '../../src/db/repositories/task-queue.js';

let h: TestAppHandle;
let app: FastifyInstance;
let headers: Record<string, string>;

beforeEach(async () => {
  h = await buildTestApp();
  app = h.app;
  headers = { authorization: `Bearer ${h.token}` };
  insertCv(h.db, {
    label: 'main', original_filename: 'cv.pdf', mime_type: 'application/pdf',
    file_path: '/tmp/cv.pdf', extracted_text: 'x', is_default: true,
  });
});
afterEach(async () => { await h.close(); });

function seedManualJob() {
  return insertJob(h.db, {
    site_id: 'linkedin', external_id: `j-${Math.random()}`,
    url: 'https://x', apply_method: 'manual',
    title: 'T', company: 'C', description: 'd',
    external_apply_url: 'https://greenhouse.io/apply',
  });
}

describe('POST /api/jobs/:id/prepare', () => {
  it('creates an application + enqueues a prepare_manual_apply task', async () => {
    const job = seedManualJob();
    const res = await app.inject({
      method: 'POST', url: `/api/jobs/${job.id}/prepare`, headers,
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { application_id: string; status: string };
    expect(body.status).toBe('queued');
    const pending = listPending(h.db);
    expect(pending.find((t) => t.kind === 'prepare_manual_apply')).toBeDefined();
  });

  it('is idempotent: returns existing active application without enqueueing twice', async () => {
    const job = seedManualJob();
    const a = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/prepare`, headers });
    const b = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/prepare`, headers });
    expect(a.json().application_id).toBe(b.json().application_id);
    const pending = listPending(h.db);
    expect(pending.filter((t) => t.kind === 'prepare_manual_apply')).toHaveLength(1);
  });

  it('returns 400 when no default CV exists', async () => {
    // Wipe CVs.
    h.db.exec(`DELETE FROM cvs`);
    const job = seedManualJob();
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/prepare`, headers });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/cv/i);
  });
});

describe('GET /api/applications', () => {
  it('filters by status (default ready_for_manual_apply)', async () => {
    const job = seedManualJob();
    insertApplication(h.db, {
      job_id: job.id, cv_id: 'cv-1', apply_method: 'manual', status: 'ready_for_manual_apply',
    });
    insertApplication(h.db, {
      job_id: job.id, cv_id: 'cv-1', apply_method: 'manual', status: 'skipped',
    });
    const res = await app.inject({ method: 'GET', url: '/api/applications', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
  });
});

describe('GET /api/applications/:id/tailored-cv', () => {
  it('streams the DOCX or 404s if not yet tailored', async () => {
    const job = seedManualJob();
    const a = insertApplication(h.db, {
      job_id: job.id, cv_id: 'cv-1', apply_method: 'manual', status: 'queued',
    });
    const res404 = await app.inject({
      method: 'GET', url: `/api/applications/${a.id}/tailored-cv`, headers,
    });
    expect(res404.statusCode).toBe(404);
  });
});

describe('POST /api/applications/:id/mark-applied', () => {
  it('flips status to applied_manually, stores notes, auto-resolves the ready alert', async () => {
    const job = seedManualJob();
    const a = insertApplication(h.db, {
      job_id: job.id, cv_id: 'cv-1', apply_method: 'manual', status: 'ready_for_manual_apply',
    });
    const alert = insertAlert(h.db, {
      kind: 'ready_for_manual_apply', severity: 'action_required',
      title: 't', description: 'd', application_id: a.id, payload: {},
    });
    const res = await app.inject({
      method: 'POST', url: `/api/applications/${a.id}/mark-applied`, headers,
      payload: { notes: 'applied via greenhouse' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('applied_manually');
    expect(res.json().applied_manually_notes).toBe('applied via greenhouse');

    const refreshed = listAlerts(h.db, { application_id: a.id });
    expect(refreshed.find((al) => al.id === alert.id)?.status).toBe('resolved');
  });
});

describe('POST /api/applications/:id/skip', () => {
  it('flips status to skipped, stores reason, auto-resolves the alert', async () => {
    const job = seedManualJob();
    const a = insertApplication(h.db, {
      job_id: job.id, cv_id: 'cv-1', apply_method: 'manual', status: 'ready_for_manual_apply',
    });
    const res = await app.inject({
      method: 'POST', url: `/api/applications/${a.id}/skip`, headers,
      payload: { reason: 'too junior' },
    });
    expect(res.json().status).toBe('skipped');
    expect(res.json().failure_reason).toBe('too junior');
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/server test -- applications`
Expected: FAIL.

- [ ] **Step 4: Implement the shared enqueuer + routes**

Create `packages/server/src/queue/manual-apply-enqueuer.ts`:

```ts
import type { Database as DatabaseType } from 'better-sqlite3';
import { ConflictError, ValidationError } from '@vina/shared';
import {
  findActiveApplicationForJob,
  insertApplication,
} from '../db/repositories/applications.js';
import { findJobById } from '../db/repositories/jobs.js';
import { listCvs } from '../db/repositories/cvs.js';
import { listCoverLetters } from '../db/repositories/cover-letters.js';
import { enqueue } from '../db/repositories/task-queue.js';
import type { EventBus } from '../events/bus.js';

export interface EnqueueResult {
  application_id: string;
  status: string;
  deduped: boolean;
}

/**
 * Idempotent: if there's already an active application for the job, returns
 * it without creating a new one or enqueueing a duplicate task.
 *
 * Used by both:
 *   - POST /api/jobs/:id/prepare (manual user action)
 *   - score handler in autonomous mode (auto-enqueue)
 */
export function enqueueManualApplyForJob(
  db: DatabaseType,
  bus: EventBus,
  jobId: string,
): EnqueueResult {
  const job = findJobById(db, jobId);
  if (!job) throw new ValidationError(`Job ${jobId} not found`);
  if (job.apply_method !== 'manual') {
    throw new ConflictError(`Job ${jobId} is not a manual-apply job`);
  }

  const existing = findActiveApplicationForJob(db, jobId);
  if (existing) {
    return { application_id: existing.id, status: existing.status, deduped: true };
  }

  const cv = listCvs(db).find((c) => c.is_default);
  if (!cv) throw new ValidationError('Upload a CV in Profile first', undefined, 'no_default_cv');

  const cl = listCoverLetters(db).find((c) => c.is_default) ?? null;

  const app = insertApplication(db, {
    job_id: jobId,
    cv_id: cv.id,
    cover_letter_id: cl?.id ?? null,
    apply_method: 'manual',
    status: 'queued',
  });

  enqueue(db, { kind: 'prepare_manual_apply', payload: { application_id: app.id } });
  bus.emit('jobs:updated', { ids: [jobId] });

  return { application_id: app.id, status: app.status, deduped: false };
}
```

Add the prepare endpoint to `packages/server/src/http/routes/jobs.ts`:

```ts
import { enqueueManualApplyForJob } from '../../queue/manual-apply-enqueuer.js';

  app.post('/api/jobs/:id/prepare', async (req, reply) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const result = enqueueManualApplyForJob(db, bus, id);
    return reply.status(202).send({
      application_id: result.application_id,
      status: result.status,
      deduped: result.deduped,
    });
  });
```

Wire `poke()` if needed (the worker has a poke surface used by run-now — reuse the same DI shape).

Create `packages/server/src/http/routes/applications.ts`:

```ts
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { APPLICATION_STATUSES, NotFoundError, ConflictError } from '@vina/shared';
import {
  findApplicationById,
  listApplications,
  markApplicationApplied,
  markApplicationSkipped,
} from '../../db/repositories/applications.js';
import { findJobById } from '../../db/repositories/jobs.js';
import { listAlerts, resolveAlert } from '../../db/repositories/alerts.js';
import type { EventBus } from '../../events/bus.js';
import { parse } from '../parse.js';

const ListQuerySchema = z.object({
  status: z.enum(APPLICATION_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
});
const IdParams = z.object({ id: z.string().min(1) });
const MarkAppliedBody = z.object({ notes: z.string().optional() });
const SkipBody = z.object({ reason: z.string().optional() });

function autoResolveReadyAlert(db: DatabaseType, bus: EventBus, applicationId: string): void {
  const alerts = listAlerts(db, {
    status: 'open',
    application_id: applicationId,
    kind: 'ready_for_manual_apply',
  });
  for (const a of alerts) {
    resolveAlert(db, a.id);
    bus.emit('alert:resolved', { id: a.id });
  }
}

function attachmentFilename(jobTitle: string, company: string, kind: 'cv' | 'cover'): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
  return `${safe(company)}-${safe(jobTitle)}-${kind}.docx`;
}

export async function applicationRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType; bus: EventBus },
): Promise<void> {
  const { db, bus } = deps;

  app.get('/api/applications', async (req) => {
    const q = parse(ListQuerySchema, req.query, 'query');
    const status = q.status ?? 'ready_for_manual_apply';
    const items = listApplications(db, {
      status,
      limit: q.page_size,
      offset: (q.page - 1) * q.page_size,
    });
    return { items, page: q.page, page_size: q.page_size };
  });

  app.get('/api/applications/:id', async (req) => {
    const { id } = parse(IdParams, req.params, 'route params');
    const row = findApplicationById(db, id);
    if (!row) throw new NotFoundError(`Application ${id} not found`);
    return row;
  });

  app.get('/api/applications/:id/tailored-cv', async (req, reply) => {
    const { id } = parse(IdParams, req.params, 'route params');
    const row = findApplicationById(db, id);
    if (!row || !row.tailored_cv_path) throw new NotFoundError(`No tailored CV for ${id}`);
    if (!fs.existsSync(row.tailored_cv_path)) throw new NotFoundError(`Tailored CV missing on disk`);
    const job = findJobById(db, row.job_id);
    reply.header(
      'Content-Disposition',
      `attachment; filename="${attachmentFilename(job?.title ?? 'job', job?.company ?? 'company', 'cv')}"`,
    );
    reply.type(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    return fs.createReadStream(row.tailored_cv_path);
  });

  app.get('/api/applications/:id/tailored-cover-letter', async (req, reply) => {
    const { id } = parse(IdParams, req.params, 'route params');
    const row = findApplicationById(db, id);
    if (!row || !row.tailored_cover_letter_path)
      throw new NotFoundError(`No tailored cover letter for ${id}`);
    if (!fs.existsSync(row.tailored_cover_letter_path))
      throw new NotFoundError(`Cover letter missing on disk`);
    const job = findJobById(db, row.job_id);
    reply.header(
      'Content-Disposition',
      `attachment; filename="${attachmentFilename(job?.title ?? 'job', job?.company ?? 'company', 'cover')}"`,
    );
    reply.type(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    return fs.createReadStream(row.tailored_cover_letter_path);
  });

  app.post('/api/applications/:id/mark-applied', async (req) => {
    const { id } = parse(IdParams, req.params, 'route params');
    const body = parse(MarkAppliedBody, req.body ?? {});
    const next = markApplicationApplied(db, id, undefined, body.notes);
    autoResolveReadyAlert(db, bus, id);
    const appliedAt = next.applied_manually_at ?? new Date().toISOString();
    bus.emit('application:applied_manually', { application_id: id, applied_at: appliedAt });
    bus.emit('jobs:updated', { ids: [next.job_id] });
    return next;
  });

  app.post('/api/applications/:id/skip', async (req) => {
    const { id } = parse(IdParams, req.params, 'route params');
    const body = parse(SkipBody, req.body ?? {});
    const next = markApplicationSkipped(db, id, body.reason);
    autoResolveReadyAlert(db, bus, id);
    bus.emit('application:skipped', {
      application_id: id,
      skipped_at: new Date().toISOString(),
      reason: body.reason,
    });
    bus.emit('jobs:updated', { ids: [next.job_id] });
    return next;
  });
}
```

Register the routes in `packages/server/src/app.ts`:

```ts
import { applicationRoutes } from './http/routes/applications.js';
// …inside the async register:
    await applicationRoutes(api, { db: deps.db, bus: deps.bus });
```

(`markApplicationApplied` in the existing repo throws `ConflictError` when status is not `ready_for_manual_apply`. The HTTP layer surfaces this via the existing `errorHandler`. Verify the handler maps `ConflictError` to 409 — if not, the route's 409 path needs a test.)

`listAlerts` needs to accept `application_id` in its filter — verify the existing repo signature; if missing, add `application_id?: string` to the filter (this was implied by the original repo audit but worth confirming during implementation).

- [ ] **Step 5: Run the tests, expect pass**

Run: `pnpm --filter @vina/server test -- applications`
Expected: PASS (all six describe blocks).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/http/routes/applications.ts packages/server/src/http/routes/jobs.ts packages/server/src/queue/manual-apply-enqueuer.ts packages/server/src/app.ts packages/server/tests/http/applications.test.ts
git commit -m "feat(server): add /api/applications routes and POST /jobs/:id/prepare"
```

---

## Phase 8 — Server: autonomy in score handler

### Task 12: Score handler auto-enqueues `prepare_manual_apply` in autonomous mode

**Files:**
- Modify: `packages/server/src/queue/handlers/score.ts`
- Test: `packages/server/tests/queue/handlers/score.test.ts` (extend)

After the score-write transaction, consult `settings.mode` and `score_threshold`. If autonomous + score ≥ threshold + `apply_method='manual'`, call `enqueueManualApplyForJob` from the shared helper. The helper is idempotent — re-runs from the same score do not duplicate.

- [ ] **Step 1: Read score.ts + the new enqueuer**

Run: `cat packages/server/src/queue/handlers/score.ts packages/server/src/queue/manual-apply-enqueuer.ts`

- [ ] **Step 2: Write the failing test** — append to `packages/server/tests/queue/handlers/score.test.ts`:

```ts
import { getOrInitSearchPreferences, updateSearchPreferences } from '../../../src/db/repositories/search-preferences.js';
import { getOrInitSettings, updateSettings } from '../../../src/db/repositories/settings.js';
import { listPending } from '../../../src/db/repositories/task-queue.js';

describe('score handler — autonomous-mode auto-enqueue', () => {
  it('enqueues prepare_manual_apply when mode=autonomous + score>=threshold + apply_method=manual', async () => {
    // Setup: autonomous mode, threshold 70.
    getOrInitSettings(db);
    updateSettings(db, { mode: 'autonomous' });
    getOrInitSearchPreferences(db);
    updateSearchPreferences(db, { score_threshold: 70 });
    upsertProfile(db, { full_name: 'Pat', email: 'p@x.com' });
    insertCv(db, { /* default cv */ is_default: true /* … */ });
    const job = insertJob(db, { apply_method: 'manual', /* … */ });

    const fakeModel = { withStructuredOutput: () => ({ invoke: async () => ({ score: 82, justification: 'ok' }) }) };
    const handler = createScoreHandler({ db, bus: createEventBus(), buildModel: async () => fakeModel as never });
    await handler({ job_id: job.id });

    const pending = listPending(db);
    expect(pending.find((t) => t.kind === 'prepare_manual_apply')).toBeDefined();
  });

  it('does NOT enqueue when mode=supervised', async () => {
    updateSettings(db, { mode: 'supervised' });
    // … same fixtures as above
    await handler({ job_id: job.id });
    expect(listPending(db).find((t) => t.kind === 'prepare_manual_apply')).toBeUndefined();
  });

  it('does NOT enqueue when score < threshold', async () => {
    updateSettings(db, { mode: 'autonomous' });
    updateSearchPreferences(db, { score_threshold: 90 });
    const fakeModel = { withStructuredOutput: () => ({ invoke: async () => ({ score: 60, justification: 'ok' }) }) };
    // … same handler call
    expect(listPending(db).find((t) => t.kind === 'prepare_manual_apply')).toBeUndefined();
  });

  it('does NOT enqueue when apply_method=auto (Phase C territory)', async () => {
    updateSettings(db, { mode: 'autonomous' });
    const job = insertJob(db, { apply_method: 'auto', /* … */ });
    // … same handler call
    expect(listPending(db).find((t) => t.kind === 'prepare_manual_apply')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/server test -- score`
Expected: FAIL — autonomy branch not present.

- [ ] **Step 4: Wire autonomy into score handler**

In `packages/server/src/queue/handlers/score.ts`, after the existing transaction:

```ts
import { getOrInitSettings } from '../../db/repositories/settings.js';
import { enqueueManualApplyForJob } from '../manual-apply-enqueuer.js';

    deps.db.transaction(() => {
      updateJobScore(deps.db, job.id, result.score, result.justification);
      updateJobStatus(deps.db, job.id, 'scored');
    })();
    deps.bus.emit('jobs:updated', { ids: [job.id] });

    // Autonomy hook: only manual-apply jobs feed Phase B's pipeline.
    // The score handler stays decoupled from the apply path via the shared
    // enqueuer — POST /jobs/:id/prepare uses the same helper.
    const settings = getOrInitSettings(deps.db);
    if (
      settings.mode === 'autonomous' &&
      result.score >= prefs.score_threshold &&
      job.apply_method === 'manual'
    ) {
      try {
        enqueueManualApplyForJob(deps.db, deps.bus, job.id);
        log.info({ job_id: job.id }, 'autonomous-mode: enqueued prepare_manual_apply');
      } catch (err) {
        // Don't fail the score task on enqueue failure (e.g. no default CV).
        // The user will see the alert and can fix the underlying issue.
        log.warn({ err, job_id: job.id }, 'autonomous enqueue skipped');
      }
    }
```

- [ ] **Step 5: Run the tests, expect pass**

Run: `pnpm --filter @vina/server test -- score`
Expected: PASS (all four cases).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/queue/handlers/score.ts packages/server/tests/queue/handlers/score.test.ts
git commit -m "feat(server): auto-enqueue prepare_manual_apply in autonomous mode"
```

---

## Phase 9 — Web: Ready-to-Apply page

### Task 13: API hooks for applications + manual-apply actions

**Files:**
- Modify: `packages/web/src/api/resources.ts`
- Test: `packages/web/src/api/resources.test.tsx` (extend; create if needed)

Add `useApplications({ status })`, `useApplication(id)`, `useMarkApplied()`, `useSkipApplication()`, `usePrepareJob()`, and download URL helpers. Live updates: subscribe to `application:ready_for_manual_apply` and `alerts:resolved` and invalidate the applications query.

- [ ] **Step 1: Read existing resources.ts** to mirror the `useJobs` / `useMarkApplied` patterns.

Run: `grep -n "useJobs\|useMarkApplied\|useSkipJob" packages/web/src/api/resources.ts | head`

- [ ] **Step 2: Write the failing test** — extend `packages/web/src/api/resources.test.tsx`:

```tsx
describe('useApplications', () => {
  it('queries /api/applications?status=ready_for_manual_apply by default', async () => {
    const { result } = renderHook(() => useApplications(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/applications?status=ready_for_manual_apply'),
      expect.anything(),
    );
  });
});

describe('useMarkApplied', () => {
  it('POSTs notes and invalidates applications + alerts on success', async () => {
    // … standard TanStack-Query mock pattern
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/web test -- resources`
Expected: FAIL.

- [ ] **Step 4: Add hooks** in `packages/web/src/api/resources.ts`:

```ts
import type { Application, ApplicationStatus } from '@vina/shared';

interface UseApplicationsOpts {
  status?: ApplicationStatus;
  pageSize?: number;
}

export function useApplications(opts: UseApplicationsOpts = {}): {
  data: Application[];
  isLoading: boolean;
} {
  const status = opts.status ?? 'ready_for_manual_apply';
  const q = useQuery<{ items: Application[] }>({
    queryKey: ['applications', status],
    queryFn: () =>
      api<{ items: Application[] }>(`/api/applications?status=${status}&page_size=${opts.pageSize ?? 50}`),
  });
  return { data: q.data?.items ?? [], isLoading: q.isLoading };
}

export function useApplication(id: string): { data: Application | null; isLoading: boolean } {
  const q = useQuery<Application | null>({
    queryKey: ['applications', id],
    queryFn: () => api<Application>(`/api/applications/${id}`),
  });
  return { data: q.data ?? null, isLoading: q.isLoading };
}

export function useMarkApplied(): {
  mutate: (id: string, notes?: string) => Promise<Application>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<Application, Error, { id: string; notes?: string }>({
    mutationFn: ({ id, notes }) =>
      api<Application>(`/api/applications/${id}/mark-applied`, {
        method: 'POST', body: { notes },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['applications'] });
      void qc.invalidateQueries({ queryKey: ['alerts'] });
    },
  });
  return { mutate: (id, notes) => mut.mutateAsync({ id, notes }), isPending: mut.isPending };
}

export function useSkipApplication(): {
  mutate: (id: string, reason?: string) => Promise<Application>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<Application, Error, { id: string; reason?: string }>({
    mutationFn: ({ id, reason }) =>
      api<Application>(`/api/applications/${id}/skip`, {
        method: 'POST', body: { reason },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['applications'] });
      void qc.invalidateQueries({ queryKey: ['alerts'] });
    },
  });
  return { mutate: (id, reason) => mut.mutateAsync({ id, reason }), isPending: mut.isPending };
}

export function usePrepareJob(): {
  mutate: (jobId: string) => Promise<{ application_id: string; status: string }>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<{ application_id: string; status: string }, Error, string>({
    mutationFn: (jobId) =>
      api<{ application_id: string; status: string }>(`/api/jobs/${jobId}/prepare`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['applications'] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
  return { mutate: (id) => mut.mutateAsync(id), isPending: mut.isPending };
}

export function tailoredCvUrl(applicationId: string): string {
  return `/api/applications/${applicationId}/tailored-cv`;
}
export function tailoredCoverLetterUrl(applicationId: string): string {
  return `/api/applications/${applicationId}/tailored-cover-letter`;
}
```

Subscribe to live updates from `packages/web/src/api/ws.ts` — verify the shape of the existing handler list. Add invalidation for `application:ready_for_manual_apply` (invalidate `['applications']`) and `application:applied_manually` and `application:skipped` (also invalidate `['applications']` and `['alerts']`).

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm --filter @vina/web test -- resources`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/api/resources.ts packages/web/src/api/ws.ts packages/web/src/api/resources.test.tsx
git commit -m "feat(web): add applications API hooks and live-update wiring"
```

---

### Task 14: `ReadyToApplyPage` component + route activation

**Files:**
- Create: `packages/web/src/routes/ready/ReadyToApplyPage.tsx`
- Create: `packages/web/src/routes/ready/ApplicationCard.tsx`
- Create: `packages/web/src/routes/ready/MarkAppliedDialog.tsx`
- Modify: `packages/web/src/router.tsx` (swap the redirect for a lazy import)
- Modify: `packages/web/src/components/layout/Sidebar.tsx` (re-add Ready to apply entry + badge)
- Test: `packages/web/src/routes/ready/ReadyToApplyPage.test.tsx`

- [ ] **Step 1: Read the existing JobsPage** to mirror layout, status banner, toast usage, and `useUiStore` wiring.

Run: `cat packages/web/src/routes/jobs/JobsPage.tsx | head -120`

- [ ] **Step 2: Write the failing test** — create `packages/web/src/routes/ready/ReadyToApplyPage.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReadyToApplyPage } from './ReadyToApplyPage.js';
import { renderWithProviders } from '../../test-utils/render.js';

const APP_FIXTURE = {
  id: 'a1', job_id: 'j1',
  cv_id: 'cv1', cover_letter_id: null,
  apply_method: 'manual', status: 'ready_for_manual_apply',
  tailored_cv_path: '/tmp/a1.docx',
  tailored_cover_letter_path: null,
  tailored_at: new Date().toISOString(),
  started_at: new Date().toISOString(),
};

describe('ReadyToApplyPage', () => {
  it('renders the empty state when no applications exist', async () => {
    renderWithProviders(<ReadyToApplyPage />, { applicationsFixture: [] });
    expect(await screen.findByText(/no applications waiting/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /scored jobs/i })).toHaveAttribute('href', '/jobs?status=scored');
  });

  it('renders a card per ready application', async () => {
    renderWithProviders(<ReadyToApplyPage />, { applicationsFixture: [APP_FIXTURE] });
    expect(await screen.findByText(/tailored cv ready/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download cv/i })).toHaveAttribute(
      'href',
      '/api/applications/a1/tailored-cv',
    );
  });

  it('opens the Mark Applied dialog and POSTs notes', async () => {
    const markApplied = vi.fn();
    renderWithProviders(<ReadyToApplyPage />, {
      applicationsFixture: [APP_FIXTURE],
      mocks: { useMarkApplied: () => ({ mutate: markApplied, isPending: false }) },
    });
    await userEvent.click(screen.getByRole('button', { name: /mark applied/i }));
    await userEvent.type(screen.getByLabelText(/notes/i), 'via greenhouse');
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(markApplied).toHaveBeenCalledWith('a1', 'via greenhouse');
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/web test -- ReadyToApply`
Expected: FAIL.

- [ ] **Step 4: Implement the page + helpers**

Create `packages/web/src/routes/ready/ApplicationCard.tsx`:

```tsx
import { useState } from 'react';
import type { Application, Job } from '@vina/shared';
import { Button } from '../../components/ui/button.js';
import { tailoredCvUrl, tailoredCoverLetterUrl } from '../../api/resources.js';
import { MarkAppliedDialog } from './MarkAppliedDialog.js';
import { SkipDialog } from './SkipDialog.js';

interface Props {
  application: Application;
  job: Job | null;
  onMarkApplied: (id: string, notes?: string) => void;
  onSkip: (id: string, reason?: string) => void;
}

function smartLinkLabel(job: Job | null): string {
  const source = job?.original_source;
  if (source) return `Apply on ${source}`;
  return 'Apply externally';
}

export function ApplicationCard({ application, job, onMarkApplied, onSkip }: Props): JSX.Element {
  const [markOpen, setMarkOpen] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);

  return (
    <article className="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <header className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium text-ink-primary">{job?.title ?? 'Job'}</span>
        <span className="text-ink-muted">·</span>
        <span className="text-ink-secondary">{job?.company ?? ''}</span>
        {job?.location && (
          <>
            <span className="text-ink-muted">·</span>
            <span className="text-ink-secondary">{job.location}</span>
          </>
        )}
      </header>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-warning">External</span>
        {job?.match_score != null && (
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-ink-secondary">
            Score {job.match_score}
          </span>
        )}
      </div>
      <p className="mt-2 text-sm text-ink-secondary">
        Tailored CV ready
        {application.tailored_cover_letter_path && ' · Cover letter ready'}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button asChild variant="default" size="sm">
          <a href={tailoredCvUrl(application.id)}>Download CV</a>
        </Button>
        {application.tailored_cover_letter_path && (
          <Button asChild variant="outline" size="sm">
            <a href={tailoredCoverLetterUrl(application.id)}>Download cover letter</a>
          </Button>
        )}
        {job?.external_apply_url && (
          <Button asChild variant="outline" size="sm">
            <a href={job.external_apply_url} target="_blank" rel="noopener noreferrer">
              {smartLinkLabel(job)}
            </a>
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setMarkOpen(true)}>
          Mark applied
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setSkipOpen(true)}>
          Skip
        </Button>
      </div>
      <MarkAppliedDialog
        open={markOpen}
        onClose={() => setMarkOpen(false)}
        onConfirm={(notes) => onMarkApplied(application.id, notes)}
      />
      <SkipDialog
        open={skipOpen}
        onClose={() => setSkipOpen(false)}
        onConfirm={(reason) => onSkip(application.id, reason)}
      />
    </article>
  );
}
```

Create `MarkAppliedDialog.tsx` (small dialog with notes textarea + Confirm/Cancel; mirrors any existing dialog component pattern — verify the shadcn Dialog wrapper at `packages/web/src/components/ui/dialog.tsx`).

Create `packages/web/src/routes/ready/ReadyToApplyPage.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { useApplications, useMarkApplied, useSkipApplication, useJob } from '../../api/resources.js';
import { ApplicationCard } from './ApplicationCard.js';
import { useUiStore } from '../../store/ui-store.js';

export function ReadyToApplyPage(): JSX.Element {
  const apps = useApplications();
  const markApplied = useMarkApplied();
  const skip = useSkipApplication();
  const pushToast = useUiStore((s) => s.pushToast);

  const onMarkApplied = async (id: string, notes?: string) => {
    await markApplied.mutate(id, notes);
    pushToast({ message: 'Marked applied', kind: 'success' });
  };
  const onSkip = async (id: string, reason?: string) => {
    await skip.mutate(id, reason);
    pushToast({ message: 'Skipped', kind: 'info' });
  };

  return (
    <section className="space-y-4">
      <header>
        <h1 className="font-display text-3xl font-headline tracking-tight text-ink-primary">
          Ready to Apply
        </h1>
        <p className="mt-1 text-sm text-ink-secondary">
          {apps.data.length} application{apps.data.length === 1 ? '' : 's'} waiting
        </p>
      </header>
      {apps.isLoading ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : apps.data.length === 0 ? (
        <p className="text-sm text-ink-secondary">
          No applications waiting.{' '}
          <Link to="/jobs?status=scored" className="underline">Scored jobs</Link>{' '}
          you mark for tailoring will appear here.
        </p>
      ) : (
        <ul className="space-y-3">
          {apps.data.map((app) => (
            <li key={app.id}>
              <ApplicationCardWithJob
                application={app}
                onMarkApplied={onMarkApplied}
                onSkip={onSkip}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ApplicationCardWithJob({
  application, onMarkApplied, onSkip,
}: {
  application: import('@vina/shared').Application;
  onMarkApplied: (id: string, notes?: string) => void;
  onSkip: (id: string, reason?: string) => void;
}): JSX.Element {
  const job = useJob(application.job_id);
  return (
    <ApplicationCard
      application={application}
      job={job.data}
      onMarkApplied={onMarkApplied}
      onSkip={onSkip}
    />
  );
}
```

(`useJob` either exists already or is a trivial wrapper around `api<Job>('/api/jobs/:id')` — verify and add if missing.)

Update `packages/web/src/router.tsx`. Add the lazy import:

```ts
const ReadyToApply = lazy(() =>
  import('./routes/ready/ReadyToApplyPage.js').then((m) => ({ default: m.ReadyToApplyPage })),
);
```

Replace the existing redirect block:

```tsx
          {
            path: '/ready',
            element: (
              <Suspense fallback={<PageFallback />}>
                <ReadyToApply />
              </Suspense>
            ),
          },
```

Update `packages/web/src/components/layout/Sidebar.tsx` to re-add the Ready-to-Apply nav item with the action-required badge. The badge counts open `ready_for_manual_apply` alerts:

```tsx
import { useAlerts } from '../../api/resources.js';

function readyBadgeCount(alerts: Alert[]): number {
  return alerts.filter((a) => a.kind === 'ready_for_manual_apply' && a.status === 'open').length;
}

// Inside Sidebar component:
const alerts = useAlerts();
const readyCount = readyBadgeCount(alerts.data);

const ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/ready', label: 'Ready to apply', badge: readyCount > 0 ? readyCount : undefined },
  { to: '/applications', label: 'Applications' },
  { to: '/alerts', label: 'Alerts' },
  { to: '/profile', label: 'Profile' },
  { to: '/settings', label: 'Settings' },
];
```

Update the NavLink JSX to render the badge inline:

```tsx
{item.badge !== undefined && (
  <span className="ml-auto inline-flex items-center rounded-full bg-warning-soft px-1.5 py-0.5 text-xs text-warning">
    {item.badge}
  </span>
)}
```

- [ ] **Step 5: Run the tests, expect pass**

Run: `pnpm --filter @vina/web test -- ReadyToApply`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/routes/ready/ packages/web/src/router.tsx packages/web/src/components/layout/Sidebar.tsx
git commit -m "feat(web): add ReadyToApplyPage and re-activate /ready route"
```

---

## Phase 10 — Web: JobCard + Dashboard integration

### Task 15: "Prepare materials" action on JobCard for manual jobs

**Files:**
- Modify: `packages/web/src/routes/jobs/JobCard.tsx`
- Modify: `packages/web/src/routes/jobs/JobsPage.tsx` (wire the prepare mutation)
- Test: `packages/web/src/routes/jobs/JobCard.test.tsx`

For `apply_method='manual'` jobs, the primary action becomes "Prepare materials" → `POST /jobs/:id/prepare`. The existing "Apply externally" remains as a secondary action. When an active application already exists for the job, the primary becomes "Tailoring…" or "Ready to apply" linking to `/ready#<application_id>`.

- [ ] **Step 1: Read JobCard.tsx** to understand the existing prop shape.

Run: `cat packages/web/src/routes/jobs/JobCard.tsx`

- [ ] **Step 2: Write the failing test** — extend or create `packages/web/src/routes/jobs/JobCard.test.tsx`:

```tsx
describe('JobCard — manual-apply variant', () => {
  it('shows "Prepare materials" as primary when apply_method=manual and no active application', () => {
    render(<JobCard job={manualJob} variant="new" activeApplication={null} … />);
    expect(screen.getByRole('button', { name: /prepare materials/i })).toBeInTheDocument();
  });

  it('shows a Ready-to-apply badge linking to /ready when an active application exists', () => {
    render(<JobCard job={manualJob} variant="new" activeApplication={{ id: 'a1', status: 'ready_for_manual_apply' }} … />);
    expect(screen.getByRole('link', { name: /ready to apply/i })).toHaveAttribute('href', '/ready');
  });

  it('shows "Tailoring..." when the application is still queued', () => {
    render(<JobCard job={manualJob} variant="new" activeApplication={{ id: 'a1', status: 'queued' }} … />);
    expect(screen.getByText(/tailoring/i)).toBeInTheDocument();
  });

  it('keeps "Apply externally" as a secondary action for manual jobs', () => {
    render(<JobCard job={manualJob} variant="new" activeApplication={null} … />);
    expect(screen.getByRole('link', { name: /apply externally/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/web test -- JobCard`
Expected: FAIL.

- [ ] **Step 4: Update JobCard**

Add `activeApplication` and `onPrepare` props:

```tsx
interface Props {
  job: Job;
  variant: 'new' | 'applied' | 'skipped';
  activeApplication: { id: string; status: ApplicationStatus } | null;
  onApply: () => void;
  onPrepare: () => void;
  onMarkApplied: () => void;
  onSkip: () => void;
  onReopen: () => void;
}
```

In the `variant === 'new'` branch, replace the existing primary action block with:

```tsx
{variant === 'new' && job.apply_method === 'manual' ? (
  <>
    {activeApplication ? (
      activeApplication.status === 'ready_for_manual_apply' ? (
        <Button asChild variant="default" size="sm">
          <Link to="/ready">Ready to apply</Link>
        </Button>
      ) : (
        <Button variant="default" size="sm" disabled>
          Tailoring…
        </Button>
      )
    ) : (
      <Button variant="default" size="sm" onClick={onPrepare}>
        Prepare materials
      </Button>
    )}
    <Button asChild variant="ghost" size="sm">
      <a href={applyHref(job)} target="_blank" rel="noopener noreferrer">
        Apply externally
      </a>
    </Button>
    <Button variant="ghost" size="sm" onClick={onMarkApplied}>
      Mark applied
    </Button>
    <Button variant="ghost" size="sm" onClick={onSkip}>
      Skip
    </Button>
  </>
) : variant === 'new' ? (
  // Existing auto-apply branch — unchanged.
  <>
    <Button variant="default" size="sm" onClick={onApply}>Apply on LinkedIn</Button>
    <Button variant="ghost" size="sm" onClick={onMarkApplied}>Mark applied</Button>
    <Button variant="ghost" size="sm" onClick={onSkip}>Skip</Button>
  </>
) : (
  <Button variant="ghost" size="sm" onClick={onReopen}>Reopen</Button>
)}
```

Update `JobsPage.tsx` to fetch the active application per job. Since looking up per-job is N+1, prefer a single `useApplications({ status: ['queued', 'ready_for_manual_apply'] })` query and zip into a `Map<job_id, Application>`. (The current `useApplications` only accepts a single status; widen the hook to accept an array, or expose a second hook `useActiveApplications`.) Pass `activeApplication={map.get(job.id) ?? null}` and `onPrepare={() => prepare.mutate(job.id)}`.

- [ ] **Step 5: Run the tests, expect pass**

Run: `pnpm --filter @vina/web test -- JobCard`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/routes/jobs/JobCard.tsx packages/web/src/routes/jobs/JobsPage.tsx packages/web/src/routes/jobs/JobCard.test.tsx packages/web/src/api/resources.ts
git commit -m "feat(web): add Prepare materials action to manual JobCards"
```

---

### Task 16: Dashboard "Ready to apply" tile

**Files:**
- Modify: `packages/web/src/routes/pages.tsx` (Dashboard component)
- Test: `packages/web/src/routes/dashboard.test.tsx`

A small tile listing the count + top 3 ready-to-apply applications, link to `/ready`. Below the existing Search-now block.

- [ ] **Step 1: Re-read the existing Dashboard** in `packages/web/src/routes/pages.tsx:36-72`.

- [ ] **Step 2: Write the failing test** — create or extend `packages/web/src/routes/dashboard.test.tsx`:

```tsx
describe('Dashboard — Ready to apply tile', () => {
  it('shows the count and a link to /ready', async () => {
    renderWithProviders(<Dashboard />, {
      applicationsFixture: [READY_APP_1, READY_APP_2, READY_APP_3, READY_APP_4],
    });
    expect(await screen.findByText(/4 ready to apply/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view all/i })).toHaveAttribute('href', '/ready');
  });

  it('renders nothing when there are no ready applications', () => {
    renderWithProviders(<Dashboard />, { applicationsFixture: [] });
    expect(screen.queryByText(/ready to apply/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/web test -- dashboard`
Expected: FAIL.

- [ ] **Step 4: Add the tile**

In `packages/web/src/routes/pages.tsx`, inside `Dashboard`:

```tsx
import { useApplications } from '../api/resources.js';

const apps = useApplications({ status: 'ready_for_manual_apply', pageSize: 3 });

// …in JSX, after <SearchActivityPanel />:
{apps.data.length > 0 && (
  <section className="rounded-lg border border-border-subtle bg-surface-raised p-4">
    <header className="flex items-center justify-between">
      <h2 className="text-lg font-medium text-ink-primary">
        {apps.data.length} ready to apply
      </h2>
      <Link to="/ready" className="text-sm text-accent underline">View all</Link>
    </header>
    <ul className="mt-3 space-y-1">
      {apps.data.slice(0, 3).map((a) => (
        <li key={a.id} className="text-sm text-ink-secondary">
          Application {a.id.slice(-6)} · tailored {timeAgo(a.tailored_at)}
        </li>
      ))}
    </ul>
  </section>
)}
```

(`timeAgo` is either an existing util or a one-liner — verify when implementing.)

- [ ] **Step 5: Run the tests, expect pass**

Run: `pnpm --filter @vina/web test -- dashboard`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/routes/pages.tsx packages/web/src/routes/dashboard.test.tsx
git commit -m "feat(web): add Ready-to-apply tile to Dashboard"
```

---

## Phase 11 — Web: Alerts inline card for ready_for_manual_apply

### Task 17: Per-kind alert card with Download / Open / Mark applied

**Files:**
- Modify: `packages/web/src/routes/alerts/AlertsPage.tsx`
- Test: `packages/web/src/routes/alerts/AlertsPage.test.tsx`

The Alerts page currently renders all alerts uniformly. Add a per-kind branch for `ready_for_manual_apply` rendering inline Download CV / Open external / Mark applied buttons. Marking applied auto-resolves via the same `mark-applied` endpoint; clicking Download/Open does not.

- [ ] **Step 1: Read AlertsPage.tsx** — already inspected; the alert payload has `application_id`, `external_apply_url`, `tailored_cv_path`.

- [ ] **Step 2: Write the failing test** — extend `packages/web/src/routes/alerts/AlertsPage.test.tsx`:

```tsx
describe('AlertsPage — ready_for_manual_apply card', () => {
  it('renders Download CV, Open external, and Mark applied buttons inline', async () => {
    renderWithProviders(<AlertsPage />, {
      alertsFixture: [{
        id: 'al1', kind: 'ready_for_manual_apply', severity: 'action_required',
        title: 'Tailored materials ready for X @ Y', description: '…',
        application_id: 'a1', status: 'open',
        payload: JSON.stringify({
          application_id: 'a1', job_id: 'j1',
          external_apply_url: 'https://x.com/apply',
          tailored_cv_path: '/tmp/a1.docx',
          tailored_cover_letter_path: null,
        }),
        created_at: new Date().toISOString(),
      }],
    });
    expect(await screen.findByRole('link', { name: /download cv/i })).toHaveAttribute(
      'href', '/api/applications/a1/tailored-cv',
    );
    expect(screen.getByRole('link', { name: /open external/i })).toHaveAttribute(
      'href', 'https://x.com/apply',
    );
    expect(screen.getByRole('button', { name: /mark applied/i })).toBeInTheDocument();
  });

  it('Mark applied click calls useMarkApplied with the application_id', async () => {
    const markApplied = vi.fn().mockResolvedValue({});
    renderWithProviders(<AlertsPage />, {
      alertsFixture: [READY_ALERT],
      mocks: { useMarkApplied: () => ({ mutate: markApplied, isPending: false }) },
    });
    await userEvent.click(screen.getByRole('button', { name: /mark applied/i }));
    expect(markApplied).toHaveBeenCalledWith('a1', undefined);
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/web test -- AlertsPage`
Expected: FAIL.

- [ ] **Step 4: Add the per-kind branch**

In `packages/web/src/routes/alerts/AlertsPage.tsx`, add a helper:

```tsx
interface ReadyPayload {
  application_id: string;
  job_id: string;
  external_apply_url: string;
  tailored_cv_path: string;
  tailored_cover_letter_path: string | null;
}

function parseReadyPayload(alert: Alert): ReadyPayload | null {
  if (alert.kind !== 'ready_for_manual_apply' || !alert.payload) return null;
  try {
    return JSON.parse(alert.payload) as ReadyPayload;
  } catch {
    return null;
  }
}
```

Inside the `alerts.data.map` block, before the existing button row, render the inline card when the kind matches:

```tsx
const ready = parseReadyPayload(alert);
// …
{ready && (
  <div className="mt-3 flex flex-wrap items-center gap-2">
    <Button asChild size="sm" variant="default">
      <a href={`/api/applications/${ready.application_id}/tailored-cv`}>Download CV</a>
    </Button>
    {ready.tailored_cover_letter_path && (
      <Button asChild size="sm" variant="outline">
        <a href={`/api/applications/${ready.application_id}/tailored-cover-letter`}>
          Download cover letter
        </a>
      </Button>
    )}
    <Button asChild size="sm" variant="outline">
      <a href={ready.external_apply_url} target="_blank" rel="noopener noreferrer">
        Open external
      </a>
    </Button>
    <Button size="sm" variant="ghost" onClick={() => markApplied.mutate(ready.application_id)}>
      Mark applied
    </Button>
  </div>
)}
```

(The existing `Resolve` / `Dismiss` buttons remain underneath; auto-resolution from Mark applied happens server-side.)

- [ ] **Step 5: Run the tests, expect pass**

Run: `pnpm --filter @vina/web test -- AlertsPage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/routes/alerts/AlertsPage.tsx packages/web/src/routes/alerts/AlertsPage.test.tsx
git commit -m "feat(web): add inline ready_for_manual_apply alert card"
```

---

## Phase 12 — CLI updates

### Task 18: `vina status` and `vina doctor` surface manual-apply signals

**Files:**
- Modify: `packages/cli/src/commands/status.ts`
- Modify: `packages/cli/src/commands/doctor.ts`
- Modify: `packages/server/src/http/routes/system.ts` (extend `/system/status` response)
- Test: `packages/cli/tests/status.test.ts`, `packages/cli/tests/doctor.test.ts`

`vina status` should print `Manual-apply queue: N pending` and `Ready to apply: N`. `vina doctor` adds a check: "Tailored CV directory writable (`<dataDir>/files/tailored/`)".

- [ ] **Step 1: Read the existing status command** — already inspected. The `SystemStatus` interface receives the `/system/status` response; extend both sides.

- [ ] **Step 2: Write the failing tests**

For `vina status`:

```ts
it('prints manual-apply queue depth and ready-to-apply count', async () => {
  mockSystemStatus({
    queue: { pending: 4, running: 1, kinds: { prepare_manual_apply: 2 } },
    ready_to_apply_count: 3,
    // …other existing fields
  });
  const out = await captureStdout(statusCommand);
  expect(out).toContain('Manual-apply queue: 2 pending');
  expect(out).toContain('Ready to apply: 3');
});
```

For `vina doctor`:

```ts
it('flags Tailored CV directory writable', async () => {
  const checks = await runDoctorChecks();
  const tailoredCheck = checks.find((c) => c.name.includes('Tailored CV directory'));
  expect(tailoredCheck).toBeDefined();
});

it('reports OK when the directory is creatable', async () => {
  // dataDir already a tempdir, no preceding state
  const checks = await runDoctorChecks();
  expect(checks.find((c) => c.name.includes('Tailored CV directory'))?.ok).toBe(true);
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/cli test`
Expected: FAIL.

- [ ] **Step 4: Implement**

Extend `packages/server/src/http/routes/system.ts` `/api/system/status` response: add `ready_to_apply_count` (count of `applications WHERE status='ready_for_manual_apply'`) and break down `queue.kinds` by `task_kind`.

Update the `SystemStatus` interface in `packages/cli/src/commands/status.ts`:

```ts
interface SystemStatus {
  // …existing fields…
  queue: {
    pending: number;
    running: number;
    kinds?: Partial<Record<string, number>>;
  };
  ready_to_apply_count: number;
}
```

Add the print line:

```ts
const prepDepth = detail.queue.kinds?.['prepare_manual_apply'] ?? 0;
process.stdout.write(`Manual-apply queue: ${prepDepth} pending\n`);
process.stdout.write(`Ready to apply: ${detail.ready_to_apply_count}\n`);
```

Add `checkTailoredCvDir` to `packages/cli/src/commands/doctor.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

function checkTailoredCvDir(): CheckResult {
  const dir = path.join(dataDir, 'files', 'tailored');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return { name: `Tailored CV directory writable (${dir})`, ok: true };
  } catch (err) {
    return {
      name: 'Tailored CV directory writable',
      ok: false,
      remediation: `Could not write to ${dir}: ${(err as Error).message}`,
    };
  }
}
```

Add it to the check list ordering.

- [ ] **Step 5: Run the tests, expect pass**

Run: `pnpm --filter @vina/cli test && pnpm --filter @vina/server test -- system`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/status.ts packages/cli/src/commands/doctor.ts packages/server/src/http/routes/system.ts packages/cli/tests packages/server/tests/http/system.test.ts
git commit -m "feat(cli): surface manual-apply queue depth and tailored-cv check"
```

---

## Phase 13 — End-to-end integration test

### Task 19: Manual-apply pipeline integration test

**Files:**
- Create: `packages/server/tests/integration/manual-apply-pipeline.test.ts`

Drive a complete cycle: insert a scored manual job → `POST /jobs/:id/prepare` → assert `prepare_manual_apply` task enqueued → run worker (single step) with a fake `BaseChatModel` → assert application transitions to `ready_for_manual_apply` with tailored CV path on disk + `ready_for_manual_apply` alert → `POST mark-applied` → assert `applied_manually` + alert resolved.

- [ ] **Step 1: Read existing integration test fixtures** — the LinkedIn slice introduced `packages/server/tests/integration/linkedin-e2e.test.ts`. Mirror its boot and worker patterns.

Run: `cat packages/server/tests/integration/linkedin-e2e.test.ts | head -80`

- [ ] **Step 2: Write the failing test** — create `packages/server/tests/integration/manual-apply-pipeline.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { freshTestDb } from '../db/helpers.js';
import { createEventBus } from '../../src/events/bus.js';
import { upsertProfile } from '../../src/db/repositories/profile.js';
import { insertCv } from '../../src/db/repositories/cvs.js';
import { insertJob, updateJobScore, updateJobStatus } from '../../src/db/repositories/jobs.js';
import { findApplicationById } from '../../src/db/repositories/applications.js';
import { listAlerts } from '../../src/db/repositories/alerts.js';
import { createPrepareManualApplyHandler } from '../../src/queue/handlers/prepare-manual-apply.js';
import { createManualApplyToolKit } from '../../src/orchestrator/tools/index.js';
import { enqueueManualApplyForJob } from '../../src/queue/manual-apply-enqueuer.js';
import { buildTestApp, type TestAppHandle } from '../http/helpers.js';

let dataDir: string;
let h: TestAppHandle;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-ma-e2e-'));
  h = await buildTestApp({ dataDir });
  upsertProfile(h.db, { full_name: 'Pat Doe', email: 'p@x.com' });
  insertCv(h.db, {
    label: 'main', original_filename: 'cv.pdf', mime_type: 'application/pdf',
    file_path: '/tmp/cv.pdf', extracted_text: 'FooCo 2020-2024.', is_default: true,
  });
});
afterEach(async () => {
  await h.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function deterministicModel(): BaseChatModel {
  let i = 0;
  const outputs = [{ summary: 'sum', bullets: [{ section: 'FooCo', bullet: 'b1' }], skills: ['ts'] }];
  return {
    withStructuredOutput: () => ({ invoke: async () => outputs[i++ % outputs.length] }),
  } as unknown as BaseChatModel;
}

describe('manual-apply pipeline (end-to-end)', () => {
  it('scored manual job → prepare → ready → mark applied → alert resolved', async () => {
    const job = insertJob(h.db, {
      site_id: 'linkedin', external_id: 'e2e-1',
      url: 'https://linkedin.com/x', apply_method: 'manual',
      title: 'Senior TS Engineer', company: 'Acme', description: 'TS APIs.',
      external_apply_url: 'https://greenhouse.io/apply/x',
    });
    updateJobScore(h.db, job.id, 82, 'great fit');
    updateJobStatus(h.db, job.id, 'scored');

    // Initiate prepare via the HTTP route.
    const headers = { authorization: `Bearer ${h.token}` };
    const prepareRes = await h.app.inject({
      method: 'POST', url: `/api/jobs/${job.id}/prepare`, headers,
    });
    expect(prepareRes.statusCode).toBe(202);
    const { application_id } = prepareRes.json() as { application_id: string };

    // Drive the queue handler directly (the worker would do this in prod).
    const handler = createPrepareManualApplyHandler({
      db: h.db, bus: createEventBus(),
      buildModel: async () => deterministicModel(),
      toolKit: createManualApplyToolKit({ dataDir }),
    });
    await handler({ application_id });

    // Application should now be ready, with a real DOCX on disk.
    const app = findApplicationById(h.db, application_id)!;
    expect(app.status).toBe('ready_for_manual_apply');
    expect(app.tailored_cv_path).toBeTruthy();
    expect(fs.existsSync(app.tailored_cv_path!)).toBe(true);
    expect(fs.readFileSync(app.tailored_cv_path!).subarray(0, 2).toString()).toBe('PK');

    const alerts = listAlerts(h.db, { kind: 'ready_for_manual_apply' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.status).toBe('open');

    // Mark applied.
    const markRes = await h.app.inject({
      method: 'POST', url: `/api/applications/${application_id}/mark-applied`,
      headers, payload: { notes: 'via greenhouse' },
    });
    expect(markRes.statusCode).toBe(200);
    expect(markRes.json().status).toBe('applied_manually');

    const alertsAfter = listAlerts(h.db, { kind: 'ready_for_manual_apply' });
    expect(alertsAfter[0]!.status).toBe('resolved');
  }, 30_000);
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/server test -- manual-apply-pipeline`
Expected: FAIL initially — likely small glue mismatches (verify `buildTestApp` accepts `dataDir`; verify the route layer is wired with the same toolKit the handler is). Fix one by one.

- [ ] **Step 4: Iterate until passing**

If `buildTestApp` doesn't accept `dataDir`, extend it. If the prepare endpoint hits a different handler than the test invokes directly, that's fine — the test exercises both surfaces (route writes `applications`, then handler reads & writes them) independently. The worker is not booted in this test; the handler is invoked manually to keep the test deterministic.

- [ ] **Step 5: Run the tests, expect pass**

Run: `pnpm --filter @vina/server test -- manual-apply-pipeline`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/tests/integration/manual-apply-pipeline.test.ts packages/server/tests/http/helpers.ts
git commit -m "test(server): add manual-apply pipeline end-to-end integration test"
```

---

## Phase 14 — Final verification

### Task 20: Cross-package verify + spec sync + deferred-followups note

**Files (verify only, possibly tiny doc edits):**
- `pnpm test && pnpm lint && pnpm build` repo-wide
- `docs/superpowers/specs/2026-05-13-manual-apply-pipeline-design.md` — flip status to "Implemented"
- `docs/decisions.md` — add a one-liner referencing this slice if any decisions surfaced

- [ ] **Step 1: Run the full repo test + lint + build**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: all PASS. If any tests not related to this slice fail, investigate; do **not** mass-skip.

- [ ] **Step 2: Update the spec status**

Edit the top of `docs/superpowers/specs/2026-05-13-manual-apply-pipeline-design.md`:

```
**Status:** Implemented (<today's ISO date>).
```

- [ ] **Step 3: Document any drift discovered during implementation**

If any deviation from the spec surfaced (e.g. the `tailored_at` column had to be split across two migrations, the renderer turned async, an endpoint signature changed) — append a paragraph under a `## Implementation notes` section in the spec.

- [ ] **Step 4: Note deferred follow-ups**

If applicable, add a short list under `§9 Explicitly NOT in this slice`:

```
## Deferred follow-ups surfaced during implementation

- **Re-tailor action on Ready-to-Apply cards.** Current behaviour is one-shot; the user has to re-prepare from the Jobs page (creating a fresh application row) to retry. Worth a card-level "Re-tailor" action that reuses the same application id.
- **Application timeline UI.** `application_events` are written by the handler but no UI surface lists them. Belongs in a later slice.
- **Cross-source dedup.** When a job appears on both LinkedIn (external) and Google Jobs, today both produce separate jobs/applications. The dedup heuristic (company + title + apply URL similarity) is straightforward but out of this slice's scope.
- **Tailored material previews.** A `docx-preview` in-browser viewer would let the user check the file without downloading. Significant scope; deferred.
```

- [ ] **Step 5: Final commit (only if files changed)**

```bash
git add docs/superpowers/specs/2026-05-13-manual-apply-pipeline-design.md docs/decisions.md
git commit -m "docs: mark manual-apply pipeline slice implemented; note deferred follow-ups"
```

---

## Appendix A — Mapping spec § to plan tasks

| Spec section | Tasks |
|---|---|
| §1.2 (1) tailor-cv graph | 5, 6 |
| §1.2 (2) tailor-cover-letter graph | 7 |
| §1.2 (3) prepare-manual-apply graph | 8 |
| §1.2 (4) prepare_manual_apply queue handler | 9 |
| §1.2 (5) applications table activation | 1, 10, 11 |
| §1.2 (6) tool kit boundary | 3, 4 |
| §1.2 (7) HTTP routes | 11 |
| §1.2 (8) ready_for_manual_apply alert activation | 9, 17 |
| §1.2 (9) Ready-to-Apply route | 13, 14 |
| §1.2 (10) Jobs page integration | 15 |
| §1.2 (11) Autonomy in score handler | 12 |
| §1.2 (12) Dashboard tile | 16 |
| §1.2 (13) Sidebar | 14 |
| §1.3 Approval mode (implicit) | — (no work — `settings.approval` stays dormant) |
| §1.4 Deferred / dormant | — (verified, no code touches re-tailor/edit UI/profile-answers/timeline UI) |
| §2.1 Pipeline diagram | 9, 11, 12 |
| §2.2 Status flow | 10, 11 |
| §2.3 Job ↔ Application | 10, 11 |
| §2.4 Worker concurrency | 9 (handler) + existing worker config |
| §3.1 tailor-cv schema + renderer | 5, 6 |
| §3.2 tailor-cover-letter | 7 |
| §3.3 prepare-manual-apply state | 8 |
| §3.4 Determinism, prompts, temperature | 5, 6, 7 |
| §4.1 Queue handler | 9 |
| §4.2 Tool kit (server-side persistence) | 3, 4 |
| §4.3 HTTP routes table | 11 |
| §4.4 Score handler autonomy | 12 |
| §5.1 Ready-to-Apply route | 14 |
| §5.2 Page layout | 14 |
| §5.3 Empty state | 14 |
| §5.4 Live updates | 13, 14 |
| §5.5 Dashboard integration | 16 |
| §5.6 Jobs page integration | 15 |
| §6.1 ready_for_manual_apply alert payload | 2, 9 |
| §6.2 Auto-resolve | 11 |
| §7 Edge cases | 9 (no CV), 11 (no CV), 12 (autonomous) |
| §8 Recorded decisions | (no code — design choices already in place) |
| §9 Explicitly NOT in this slice | — (do not implement) |
| §10 Success criteria | 19 (E2E test exercises all four bullets) |

## Appendix B — Files touched (final inventory)

**Created:**
- `packages/server/migrations/004_manual_apply_pipeline.sql`
- `packages/orchestrator/src/tools/types.ts`
- `packages/orchestrator/src/tools/save-tailored-cv.ts`
- `packages/orchestrator/src/tools/save-tailored-cover-letter.ts`
- `packages/orchestrator/src/prompts/tailor-cv.ts`
- `packages/orchestrator/src/prompts/tailor-cover-letter.ts`
- `packages/orchestrator/src/graphs/tailor-cv.ts`
- `packages/orchestrator/src/graphs/tailor-cover-letter.ts`
- `packages/orchestrator/src/graphs/prepare-manual-apply.ts`
- `packages/orchestrator/tests/tools/tool-kit.test.ts`
- `packages/orchestrator/tests/prompts/tailor-cv.test.ts`
- `packages/orchestrator/tests/graphs/tailor-cv.test.ts`
- `packages/orchestrator/tests/graphs/tailor-cover-letter.test.ts`
- `packages/orchestrator/tests/graphs/prepare-manual-apply.test.ts`
- `packages/server/src/orchestrator/tools/index.ts`
- `packages/server/src/orchestrator/tools/save-tailored-cv.ts`
- `packages/server/src/orchestrator/tools/save-tailored-cover-letter.ts`
- `packages/server/src/queue/handlers/prepare-manual-apply.ts`
- `packages/server/src/queue/manual-apply-enqueuer.ts`
- `packages/server/src/http/routes/applications.ts`
- `packages/server/tests/orchestrator/tools/save-tailored.test.ts`
- `packages/server/tests/queue/handlers/prepare-manual-apply.test.ts`
- `packages/server/tests/http/applications.test.ts`
- `packages/server/tests/integration/manual-apply-pipeline.test.ts`
- `packages/web/src/routes/ready/ReadyToApplyPage.tsx`
- `packages/web/src/routes/ready/ApplicationCard.tsx`
- `packages/web/src/routes/ready/MarkAppliedDialog.tsx`
- `packages/web/src/routes/ready/SkipDialog.tsx`
- `packages/web/src/routes/ready/ReadyToApplyPage.test.tsx`

**Modified:**
- `packages/shared/src/events.ts`
- `packages/shared/tests/events.test.ts`
- `packages/orchestrator/package.json` (add `docx` dependency)
- `packages/orchestrator/src/index.ts` (new exports)
- `packages/server/src/db/repositories/applications.ts` (`setApplicationTailored`, `findActiveApplicationForJob`, `markApplicationSkipped`)
- `packages/server/src/db/repositories/alerts.ts` (verify `application_id` filter; widen if needed)
- `packages/server/src/queue/handlers/score.ts` (autonomy branch)
- `packages/server/src/http/routes/jobs.ts` (add `POST /:id/prepare`)
- `packages/server/src/http/routes/system.ts` (queue.kinds + ready_to_apply_count)
- `packages/server/src/app.ts` (register applicationRoutes)
- `packages/server/src/main.ts` (register `prepare_manual_apply` handler + extend `onTerminalFailure`)
- `packages/server/tests/queue/handlers/score.test.ts`
- `packages/server/tests/db/applications.test.ts`
- `packages/server/tests/db/migrations.test.ts`
- `packages/server/tests/http/system.test.ts`
- `packages/server/tests/http/helpers.ts` (pass dataDir through)
- `packages/web/src/api/resources.ts` (new hooks)
- `packages/web/src/api/ws.ts` (subscribe to new events)
- `packages/web/src/router.tsx` (mount /ready)
- `packages/web/src/components/layout/Sidebar.tsx` (re-add Ready nav + badge)
- `packages/web/src/routes/jobs/JobCard.tsx` (manual-apply primary action)
- `packages/web/src/routes/jobs/JobsPage.tsx` (wire prepare + active-application map)
- `packages/web/src/routes/pages.tsx` (Dashboard tile)
- `packages/web/src/routes/alerts/AlertsPage.tsx` (inline ready card)
- `packages/web/src/routes/jobs/JobCard.test.tsx`
- `packages/web/src/routes/dashboard.test.tsx`
- `packages/web/src/routes/alerts/AlertsPage.test.tsx`
- `packages/cli/src/commands/status.ts`
- `packages/cli/src/commands/doctor.ts`
- `packages/cli/tests/status.test.ts`
- `packages/cli/tests/doctor.test.ts`
- `docs/superpowers/specs/2026-05-13-manual-apply-pipeline-design.md` (status flip)

**No deletions.** This slice is purely additive on top of the LinkedIn slice + Phase A.
