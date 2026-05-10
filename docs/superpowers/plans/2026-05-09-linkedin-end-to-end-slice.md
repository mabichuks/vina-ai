# LinkedIn End-to-End Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working LinkedIn-only job-search loop (login → schedule/manual search → score → review/apply/skip in UI) per `docs/superpowers/specs/2026-05-04-linkedin-end-to-end-slice-design.md`.

**Architecture:** Replace the M10 search-handler stub with a real `linkedInAdapter` flow (login predicates, search iterator, openListing, detectApplyMethod). Wire `BrowserManager` into the daemon, add a `linkedin-connect-service` for the headed login attempt, fold the user's CV into the score prompt, and add the four missing HTTP surfaces (`/api/sites/linkedin/*`, `/api/jobs`, `/api/jobs/:id/{applied,skip,scored}`, `/api/searches/run-now`). Frontend gets a Connect-LinkedIn wizard step, a real Jobs page (tabs + smart-link Apply + optimistic Mark applied/Skip), and a Settings → Sites tile. Schema gets one forward-only migration (`schedules.consecutive_failures`, `schedules.paused`, widened `alerts.kind` CHECK).

**Tech Stack:** TypeScript, Node ≥20, pnpm workspaces, Fastify + `@fastify/websocket`, better-sqlite3, Playwright (already in `packages/automation`), LangGraph orchestrator (already wired), React 18 + Vite + Tailwind + TanStack Query + Zustand, Vitest, Playwright Test against the existing LinkedIn fixture at `tests/fixtures/sites/linkedin/`.

**Status notes from the codebase audit:**
- The existing `JobStatus` enum uses `new` (not `created`) and `applied_manually` (not `applied`). Endpoints will be named `/jobs/:id/applied` per spec; the underlying DB write uses `applied_manually` so we don't churn the schema.
- The wizard step order today is `welcome → profile → llm-provider → cv → cover-letter → preferences → sources → schedule → mode → done`. Per spec §3.1 the new order is `welcome → profile → cv → llm-provider → preferences → schedule → connect-linkedin → done` (CV moves before LLM provider, sources/cover-letter/mode are unrouted, connect-linkedin is new).
- `BrowserManager` (`packages/automation/src/browser/manager.ts`) is already implemented but not wired into the server daemon. We add it in Phase 3.
- The existing `POST /api/sites/:id/login` is a stub that immediately marks the session valid. We keep it for non-LinkedIn callers but route LinkedIn through the new dedicated endpoints.
- Schedule failure tracking uses `schedule_id` threaded through the search task payload (scheduler tasks set it; manual `Search now` tasks omit it). Only scheduler-fired failures bump `consecutive_failures`.

**Coding conventions reminder (from CLAUDE.md):**
- Strict TypeScript; `kebab-case.ts` for modules, `PascalCase.tsx` for components.
- No default exports except React pages and Vite entrypoints.
- Comment _why_, not _what_; prefer no comments.
- Conventional Commits scoped by package: `feat(server): …`, `feat(web): …`, etc.
- One commit per task; **never** include "Claude" or "Co-Authored-By Claude" in commit messages (per user memory).

---

## Phase 1 — Schema, Shared Types, Events

### Task 1: Forward-only migration `002_linkedin_e2e_schema.sql`

**Files:**
- Create: `packages/server/migrations/002_linkedin_e2e_schema.sql`
- Test: `packages/server/tests/db/migrations.test.ts` (extend)

- [ ] **Step 1: Read existing migrations test to understand conventions**

Run: `cat packages/server/src/db/migrations.test.ts packages/server/src/db/migrate.test.ts`

Expected: see how applied/skipped is asserted; copy the assertion style.

- [ ] **Step 2: Write the failing test** in `packages/server/src/db/migrations.test.ts` (append a new `describe` block):

```ts
describe('002_linkedin_e2e_schema', () => {
  it('adds consecutive_failures and paused columns to schedules', () => {
    const db = freshTestDb();
    const cols = db.prepare(`PRAGMA table_info(schedules)`).all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('consecutive_failures')).toBe(true);
    expect(names.has('paused')).toBe(true);
    db.close();
  });

  it('widens alerts.kind to include the new linkedin slice values', () => {
    const db = freshTestDb();
    for (const kind of [
      'linkedin_session_expired',
      'search_failed',
      'score_failed',
      'schedule_paused',
      'provider_failed',
    ]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO alerts (id, kind, severity, title, description, status, created_at)
             VALUES (?, ?, 'info', 't', 'd', 'open', ?)`,
          )
          .run(`a-${kind}`, kind, new Date().toISOString()),
      ).not.toThrow();
    }
    db.close();
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- migrations`
Expected: FAIL — columns missing or CHECK constraint rejects the new kinds.

- [ ] **Step 4: Write the migration SQL**

```sql
-- 002_linkedin_e2e_schema.sql
-- Adds schedule failure tracking + widens alerts.kind for the LinkedIn slice.
-- Forward-only. SQLite cannot ALTER a CHECK constraint, so we rebuild `alerts`.

ALTER TABLE schedules ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedules ADD COLUMN paused INTEGER NOT NULL DEFAULT 0
  CHECK (paused IN (0, 1));

CREATE TABLE alerts_new (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'missing_field', 'captcha', 'session_expired',
                     'awaiting_approval', 'apply_failed',
                     'ready_for_manual_apply', 'general',
                     'linkedin_session_expired', 'search_failed',
                     'score_failed', 'schedule_paused', 'provider_failed'
                   )),
  severity         TEXT NOT NULL CHECK (severity IN ('info', 'action_required', 'error')),
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  application_id   TEXT REFERENCES applications(id) ON DELETE CASCADE,
  site_id          TEXT REFERENCES sites(id) ON DELETE CASCADE,
  payload          TEXT,
  status           TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution_value TEXT,
  created_at       TEXT NOT NULL,
  resolved_at      TEXT
);

INSERT INTO alerts_new SELECT * FROM alerts;
DROP TABLE alerts;
ALTER TABLE alerts_new RENAME TO alerts;

CREATE INDEX idx_alerts_status ON alerts(status, created_at);
```

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm --filter @vina/server test -- migrations`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/migrations/002_linkedin_e2e_schema.sql packages/server/src/db/migrations.test.ts
git commit -m "feat(server): add migration 002 for schedule failure tracking + alert kinds"
```

---

### Task 2: Add new alert kinds to `@vina/shared`

**Files:**
- Modify: `packages/shared/src/enums.ts`
- Test: `packages/shared/tests/enums.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/tests/enums.test.ts`:

```ts
import { ALERT_KINDS } from '../src/enums.js';

describe('ALERT_KINDS — linkedin slice additions', () => {
  it.each([
    'linkedin_session_expired',
    'search_failed',
    'score_failed',
    'schedule_paused',
    'provider_failed',
  ])('includes %s', (kind) => {
    expect(ALERT_KINDS as readonly string[]).toContain(kind);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @vina/shared test -- enums`
Expected: FAIL.

- [ ] **Step 3: Update the enum**

In `packages/shared/src/enums.ts:42-51`, replace the `ALERT_KINDS` array with:

```ts
export const ALERT_KINDS = [
  'missing_field',
  'captcha',
  'session_expired',
  'awaiting_approval',
  'apply_failed',
  'ready_for_manual_apply',
  'general',
  'linkedin_session_expired',
  'search_failed',
  'score_failed',
  'schedule_paused',
  'provider_failed',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
```

- [ ] **Step 4: Run the test, expect pass; build to ensure consumers still typecheck**

Run: `pnpm --filter @vina/shared test -- enums && pnpm --filter @vina/shared build`
Expected: PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/enums.ts packages/shared/tests/enums.test.ts
git commit -m "feat(shared): add linkedin slice alert kinds"
```

---

### Task 3: Add new WebSocket event types

**Files:**
- Modify: `packages/shared/src/events.ts`
- Test: `packages/shared/tests/events.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/tests/events.test.ts`:

```ts
import { EVENTS, EVENT_PAYLOADS } from '../src/events.js';

describe('EVENTS — linkedin slice additions', () => {
  it.each(['SEARCH_STARTED', 'SEARCH_COMPLETED', 'SEARCH_FAILED', 'LINKEDIN_SESSION_EXPIRED'])(
    'includes %s',
    (key) => {
      expect((EVENTS as Record<string, string>)[key]).toBeTruthy();
    },
  );

  it('search:completed payload validates listings_added and scored', () => {
    const schema = EVENT_PAYLOADS['search:completed'];
    expect(() =>
      schema.parse({
        task_id: 't1',
        site_id: 'linkedin',
        listings_added: 3,
        scored: 2,
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @vina/shared test -- events`
Expected: FAIL.

- [ ] **Step 3: Update events.ts**

In `packages/shared/src/events.ts`, extend the `EVENTS` const and `EVENT_PAYLOADS` map:

```ts
export const EVENTS = {
  JOBS_UPDATED: 'jobs:updated',
  APPLICATION_UPDATED: 'application:updated',
  APPLICATION_EVENT: 'application:event',
  APPLICATION_READY_FOR_MANUAL_APPLY: 'application:ready_for_manual_apply',
  APPLICATION_APPLIED_MANUALLY: 'application:applied_manually',
  ALERT_CREATED: 'alert:created',
  ALERT_RESOLVED: 'alert:resolved',
  ALERT_DISMISSED: 'alert:dismissed',
  CHAT_TOKEN: 'chat:token',
  CHAT_MESSAGE: 'chat:message',
  SITE_LOGIN_STATUS: 'site:login_status',
  SYSTEM_STATUS: 'system:status',
  QUEUE_UPDATED: 'queue:updated',
  SEARCH_STARTED: 'search:started',
  SEARCH_COMPLETED: 'search:completed',
  SEARCH_FAILED: 'search:failed',
  LINKEDIN_SESSION_EXPIRED: 'linkedin:session-expired',
} as const;
```

Append to the schema declarations (above `EVENT_PAYLOADS`):

```ts
const SearchStartedPayload = z.object({
  task_id: z.string(),
  site_id: z.string(),
});
const SearchCompletedPayload = z.object({
  task_id: z.string(),
  site_id: z.string(),
  listings_added: z.number().int().nonnegative(),
  scored: z.number().int().nonnegative(),
});
const SearchFailedPayload = z.object({
  task_id: z.string(),
  site_id: z.string(),
  error_kind: z.enum(['session_expired', 'network', 'unknown']),
});
const LinkedInSessionExpiredPayload = z.object({ at: isoDate });
```

Add the four new entries to `EVENT_PAYLOADS`:

```ts
  [EVENTS.SEARCH_STARTED]: SearchStartedPayload,
  [EVENTS.SEARCH_COMPLETED]: SearchCompletedPayload,
  [EVENTS.SEARCH_FAILED]: SearchFailedPayload,
  [EVENTS.LINKEDIN_SESSION_EXPIRED]: LinkedInSessionExpiredPayload,
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @vina/shared test -- events && pnpm --filter @vina/shared build`
Expected: PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/events.ts packages/shared/tests/events.test.ts
git commit -m "feat(shared): add search and linkedin-session-expired WS events"
```

---

### Task 4: Schedule repository — failure tracking helpers

**Files:**
- Modify: `packages/server/src/db/repositories/schedules.ts`
- Test: `packages/server/tests/db/schedules.test.ts` (create if missing; otherwise extend)

- [ ] **Step 1: Write the failing test**

Create or extend `packages/server/tests/db/schedules.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
  insertSchedule,
  findScheduleById,
  incrementScheduleFailures,
  resetScheduleFailures,
  setSchedulePaused,
} from '../../src/db/repositories/schedules.js';
import { freshTestDb } from '../db/helpers.js';

let db: DatabaseType;
beforeEach(() => { db = freshTestDb(); });
afterEach(() => { db.close(); });

describe('schedule failure helpers', () => {
  it('increments and resets consecutive_failures', () => {
    const s = insertSchedule(db, { cron_expression: '*/15 * * * *' });
    expect(findScheduleById(db, s.id)?.consecutive_failures).toBe(0);
    incrementScheduleFailures(db, s.id);
    incrementScheduleFailures(db, s.id);
    expect(findScheduleById(db, s.id)?.consecutive_failures).toBe(2);
    resetScheduleFailures(db, s.id);
    expect(findScheduleById(db, s.id)?.consecutive_failures).toBe(0);
  });

  it('flips paused via setSchedulePaused', () => {
    const s = insertSchedule(db, { cron_expression: '*/15 * * * *' });
    expect(findScheduleById(db, s.id)?.paused).toBe(false);
    setSchedulePaused(db, s.id, true);
    expect(findScheduleById(db, s.id)?.paused).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- schedules`
Expected: FAIL — `consecutive_failures`/`paused` not on the `Schedule` type, helpers don't exist.

- [ ] **Step 3: Extend the repository**

In `packages/server/src/db/repositories/schedules.ts`, replace the `Schedule` interface and `ScheduleRow` interface with:

```ts
export interface Schedule {
  id: string;
  cron_expression: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  consecutive_failures: number;
  paused: boolean;
  created_at: string;
}

interface ScheduleRow {
  id: string;
  cron_expression: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  consecutive_failures: number;
  paused: number;
  created_at: string;
}

function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    ...row,
    enabled: row.enabled === 1,
    paused: row.paused === 1,
  };
}
```

Update `insertSchedule` to set the new defaults explicitly via the existing INSERT (no SQL change needed — defaults are 0).

Append three new exports:

```ts
export function incrementScheduleFailures(db: DatabaseType, id: string): void {
  db.prepare(
    `UPDATE schedules SET consecutive_failures = consecutive_failures + 1 WHERE id = ?`,
  ).run(id);
}

export function resetScheduleFailures(db: DatabaseType, id: string): void {
  db.prepare(`UPDATE schedules SET consecutive_failures = 0 WHERE id = ?`).run(id);
}

export function setSchedulePaused(db: DatabaseType, id: string, paused: boolean): void {
  db.prepare(`UPDATE schedules SET paused = ? WHERE id = ?`).run(paused ? 1 : 0, id);
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @vina/server test -- schedules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/repositories/schedules.ts packages/server/tests/db/schedules.test.ts
git commit -m "feat(server): add schedule failure tracking helpers"
```

---

## Phase 2 — Orchestrator: CV in Score Input

### Task 5: Add `cv_text` to `ScoreInput` and update prompt template

**Files:**
- Modify: `packages/orchestrator/src/prompts/score.ts`
- Test: `packages/orchestrator/tests/prompts/score.test.ts` (extend; create if missing)

- [ ] **Step 1: Write the failing test**

In `packages/orchestrator/tests/prompts/score.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { scoreUserPrompt, type ScoreInput } from '../../src/prompts/score.js';

const BASE_INPUT: ScoreInput = {
  job: {
    title: 'Senior TS Engineer',
    company: 'Acme',
    location: 'Remote',
    description: 'Build TypeScript APIs.',
  },
  profile: { full_name: 'Pat', bio: 'Generalist engineer.' },
  prefs: {
    description: 'Backend roles.',
    keywords: ['typescript'],
    locations: ['Remote'],
    work_models: ['remote'],
    seniority: ['senior'],
    excluded_companies: [],
  },
};

describe('scoreUserPrompt', () => {
  it('omits the CV section when cv_text is undefined', () => {
    const out = scoreUserPrompt(BASE_INPUT);
    expect(out).not.toMatch(/## CV/);
  });

  it('renders a CV section between Profile and Search preferences when cv_text is set', () => {
    const out = scoreUserPrompt({ ...BASE_INPUT, cv_text: 'Worked on Postgres pipelines.' });
    const profileIdx = out.indexOf('## User profile');
    const cvIdx = out.indexOf('## CV');
    const prefsIdx = out.indexOf('## Search preferences');
    expect(cvIdx).toBeGreaterThan(profileIdx);
    expect(prefsIdx).toBeGreaterThan(cvIdx);
    expect(out).toContain('Worked on Postgres pipelines.');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @vina/orchestrator test -- score`
Expected: FAIL.

- [ ] **Step 3: Update `ScoreInput` and `scoreUserPrompt`**

In `packages/orchestrator/src/prompts/score.ts`, change the `ScoreInput` interface to add an optional `cv_text`:

```ts
export interface ScoreInput {
  job: {
    title: string;
    company: string;
    location: string | null;
    description: string;
  };
  profile: {
    full_name: string;
    bio: string | null;
  };
  cv_text?: string | null;
  prefs: {
    description: string;
    keywords: string[];
    locations: string[];
    work_models: string[];
    seniority: string[];
    excluded_companies: string[];
  };
}
```

In the `scoreUserPrompt` function, insert a CV block after the profile block and before the search-prefs block:

```ts
  lines.push('## User profile');
  lines.push(`Name: ${profile.full_name}`);
  if (profile.bio) lines.push(`Bio: ${profile.bio}`);
  lines.push('');

  if (input.cv_text && input.cv_text.trim().length > 0) {
    lines.push('## CV');
    lines.push(input.cv_text.trim());
    lines.push('');
  }

  lines.push('## Search preferences');
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @vina/orchestrator test`
Expected: PASS (existing snapshot tests may need refresh — if they fail, inspect and update only if the diff is just the new optional CV block).

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/prompts/score.ts packages/orchestrator/tests
git commit -m "feat(orchestrator): include CV text in score prompt"
```

---

### Task 6: Score handler folds default CV into `ScoreInput`

**Files:**
- Modify: `packages/server/src/queue/handlers/score.ts`
- Test: `packages/server/tests/queue/handlers/score.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/server/tests/queue/handlers/score.test.ts` (use the same `freshTestDb` + fake-chat-model pattern as the existing tests):

```ts
it('passes the default CV extracted_text into the scorer prompt as cv_text', async () => {
  // Insert profile + a default CV with extracted_text + a job in `new`.
  upsertProfile(db, { full_name: 'Pat', email: 'p@x.com' });
  insertCv(db, {
    label: 'main',
    original_filename: 'cv.pdf',
    mime_type: 'application/pdf',
    file_path: '/tmp/cv.pdf',
    extracted_text: 'CV-FINGERPRINT-12345',
    is_default: true,
  });
  const job = insertJob(db, {
    site_id: 'linkedin',
    external_id: 'j1',
    url: 'https://linkedin.com/jobs/view/j1',
    apply_method: 'auto',
    title: 'Senior Engineer',
    company: 'Acme',
    description: 'TS APIs.',
  });

  let captured: BaseMessage[] | null = null;
  const fakeModel = {
    withStructuredOutput: () => ({
      invoke: async (msgs: BaseMessage[]) => {
        captured = msgs;
        return { score: 80, justification: 'ok' };
      },
    }),
  } as unknown as BaseChatModel;

  const handler = createScoreHandler({ db, bus: createEventBus(), buildModel: async () => fakeModel });
  await handler({ job_id: job.id });

  const userMsg = captured!.find((m) => m._getType() === 'human');
  expect(String(userMsg?.content)).toContain('CV-FINGERPRINT-12345');
  expect(String(userMsg?.content)).toContain('## CV');
});
```

(`upsertProfile` and `insertCv` come from `packages/server/src/db/repositories/{profile,cvs}.ts`.)

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- score`
Expected: FAIL — handler doesn't yet read the CV.

- [ ] **Step 3: Update the score handler**

In `packages/server/src/queue/handlers/score.ts`, change the imports:

```ts
import { listCvs } from '../../db/repositories/cvs.js';
```

And, inside the returned async function, after `const prefs = getOrInitSearchPreferences(deps.db);`, add:

```ts
    const defaultCv = listCvs(deps.db).find((c) => c.is_default) ?? null;
```

Then add `cv_text` to the `ScoreInput`:

```ts
    const input: ScoreInput = {
      job: {
        title: job.title,
        company: job.company,
        location: job.location,
        description: job.description,
      },
      profile: {
        full_name: profile.full_name,
        bio: profile.bio,
      },
      cv_text: defaultCv?.extracted_text ?? null,
      prefs: {
        description: prefs.description,
        keywords: prefs.keywords,
        locations: prefs.locations,
        work_models: prefs.work_models,
        seniority: prefs.seniority,
        excluded_companies: prefs.excluded_companies,
      },
    };
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @vina/server test -- score`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/queue/handlers/score.ts packages/server/tests/queue/handlers/score.test.ts
git commit -m "feat(server): fold default CV text into score input"
```

---

## Phase 3 — Server: BrowserManager wiring + LinkedIn Connect Service

### Task 7: Wire `BrowserManager` into the server boot

**Files:**
- Modify: `packages/server/src/main.ts`
- Modify: `packages/server/src/app.ts` (pass through to routes)
- Test: `packages/server/tests/integration/server.smoke.test.ts` (light extension)

- [ ] **Step 1: Write the failing test**

In a new file `packages/server/tests/integration/browser-manager-wiring.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { bootServer } from '../../src/main.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('bootServer wires BrowserManager', () => {
  it('exposes browserManager on the booted handle for shutdown', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-bm-'));
    const booted = await bootServer({ port: 0, dataDir: tmp });
    expect(typeof booted.browserManager.getContext).toBe('function');
    expect(typeof booted.browserManager.closeAll).toBe('function');
    await booted.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- browser-manager-wiring`
Expected: FAIL — `booted.browserManager` undefined.

- [ ] **Step 3: Wire the manager**

In `packages/server/src/main.ts`, add the import and instantiate:

```ts
import { createBrowserManager, type BrowserManagerHandle } from '@vina/automation';
```

After `await initVault(config.dataDir);`:

```ts
  const browserManager = createBrowserManager({
    dataDir: config.dataDir,
    headless: !config.headfulBrowser,
  });
```

Pass it to handlers and routes (the search handler will use it in Task 10; for now, just plumb):

```ts
  const handlers: TaskHandlers = {
    search: adapt(createSearchHandler({ db, bus, browserManager })),
    score: adapt(
      createScoreHandler({ db, bus, buildModel: () => getActiveChatModel(db) }),
    ),
  };
```

(`createSearchHandler` will be updated in Task 10 to accept `browserManager`. For now, add the optional parameter so this typechecks — see Task 10 step 3 for the signature change.)

Update `BootedServer` interface and the returned object:

```ts
export interface BootedServer {
  app: FastifyInstance;
  config: ServerConfig;
  port: number;
  browserManager: BrowserManagerHandle;
  shutdown: () => Promise<void>;
}
```

In the returned shutdown:

```ts
  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    await worker.stop();
    await browserManager.closeAll();
    await app.close();
    closeDb();
    deleteStatusFile(config);
  };

  return { app, config, port, browserManager, shutdown };
```

In `packages/server/src/app.ts`, extend `BuildAppDeps` and the function so routes can receive the manager:

```ts
import type { BrowserManagerHandle } from '@vina/automation';

export interface BuildAppDeps {
  db: DatabaseType;
  config: ServerConfig;
  version: string;
  startedAt: string;
  bus: EventBus;
  browserManager: BrowserManagerHandle;
}
```

Pass `deps` (already done) — the `siteRoutes` invocation in app.ts will be extended in Task 9.

In `main.ts`, the `buildApp` call:

```ts
  const app = await buildApp({ db, config, version, startedAt, bus, browserManager });
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @vina/server test -- browser-manager-wiring`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/main.ts packages/server/src/app.ts packages/server/tests/integration/browser-manager-wiring.test.ts
git commit -m "feat(server): wire BrowserManager into daemon boot"
```

---

### Task 8: `linkedin-connect-service` — connect attempt state machine

**Files:**
- Create: `packages/server/src/services/linkedin-connect-service.ts`
- Test: `packages/server/tests/services/linkedin-connect-service.test.ts`

This service owns the in-flight headed-Chromium login attempt: it opens a page, polls `linkedInAdapter.onLoginSuccess(page)` every ~1s, and exposes status. It is a per-process singleton-style state container (not a global — the caller wires one instance through DI).

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/services/linkedin-connect-service.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createBrowserManager } from '@vina/automation';
import { linkedInAdapter } from '@vina/automation';
import { startLinkedInFixture } from '../../../../tests/fixtures/sites/linkedin/server.js';
import type { FixtureServerHandle } from '../../../../tests/fixtures/start-server.js';
import { createLinkedInConnectService } from '../../src/services/linkedin-connect-service.js';
import { freshTestDb } from '../db/helpers.js';
import { createEventBus } from '../../src/events/bus.js';

let fixture: FixtureServerHandle;
beforeAll(async () => { fixture = await startLinkedInFixture(); });
afterAll(async () => { await fixture.close(); });

describe('linkedin-connect-service', () => {
  it('reports connected:false attempting:false initially', () => {
    const db = freshTestDb();
    const bus = createEventBus();
    const bm = createBrowserManager({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vina-')) });
    const svc = createLinkedInConnectService({
      db,
      bus,
      browserManager: bm,
      adapter: linkedInAdapter,
      loginUrlOverride: `${fixture.url}/login`,
      pollIntervalMs: 50,
      timeoutMs: 5_000,
    });
    expect(svc.getStatus()).toMatchObject({ connected: false, attempting: false });
  });

  it('flips connected:true after the user navigates to /feed', async () => {
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-'));
    const db = freshTestDb();
    const bus = createEventBus();
    const bm = createBrowserManager({ dataDir: tmpData });
    const svc = createLinkedInConnectService({
      db, bus, browserManager: bm, adapter: linkedInAdapter,
      loginUrlOverride: `${fixture.url}/login`,
      onLoginSuccessNavigationOverride: `${fixture.url}/feed`,
      pollIntervalMs: 50,
      timeoutMs: 5_000,
    });
    await svc.startConnect();
    // Test seam: the service navigates the page to feedUrl when loginUrlOverride
    // is set, simulating the user logging in. Service polls and detects success.
    await new Promise((r) => setTimeout(r, 300));
    expect(svc.getStatus().connected).toBe(true);
    await svc.cancelConnect();
    await bm.closeAll();
    db.close();
  });
});
```

(Note: the `onLoginSuccessNavigationOverride` is a test seam — when set, the service navigates the page to that URL after launching the browser, simulating a user login. In production this is undefined and the user actually logs in.)

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- linkedin-connect-service`
Expected: FAIL — service does not exist.

- [ ] **Step 3: Implement the service**

Create `packages/server/src/services/linkedin-connect-service.ts`:

```ts
import type { Database as DatabaseType } from 'better-sqlite3';
import type { Page } from 'playwright';
import type { BrowserManagerHandle, SiteAdapter } from '@vina/automation';
import { createLogger } from '@vina/shared';
import type { EventBus } from '../events/bus.js';
import { updateSiteSession, updateSiteEnabled } from '../db/repositories/sites.js';

const log = createLogger('linkedin-connect-service');

export interface LinkedInConnectStatus {
  connected: boolean;
  attempting: boolean;
  last_success_at: string | null;
  error: string | null;
}

export interface LinkedInConnectServiceOptions {
  db: DatabaseType;
  bus: EventBus;
  browserManager: BrowserManagerHandle;
  adapter: SiteAdapter;
  /** Test seam — overrides the adapter's loginUrl. */
  loginUrlOverride?: string;
  /** Test seam — when set, after launch we navigate to this URL instead of waiting for the user. */
  onLoginSuccessNavigationOverride?: string;
  pollIntervalMs?: number;
  /** Default 5 minutes per spec §3.3. */
  timeoutMs?: number;
}

export interface LinkedInConnectService {
  startConnect(): Promise<void>;
  cancelConnect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): LinkedInConnectStatus;
}

const SITE_ID = 'linkedin';

export function createLinkedInConnectService(
  opts: LinkedInConnectServiceOptions,
): LinkedInConnectService {
  const pollMs = opts.pollIntervalMs ?? 1_500;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  let attempting = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  let page: Page | null = null;
  let stop: (() => void) | null = null;

  function getStatus(): LinkedInConnectStatus {
    return {
      connected: lastSuccessAt !== null,
      attempting,
      last_success_at: lastSuccessAt,
      error: lastError,
    };
  }

  async function startConnect(): Promise<void> {
    if (attempting) return; // Idempotent per spec §3.6
    attempting = true;
    lastError = null;
    try {
      const ctx = await opts.browserManager.getContext(SITE_ID);
      page = await ctx.newPage();
      const loginUrl = opts.loginUrlOverride ?? opts.adapter.loginUrl;
      await page.goto(loginUrl);

      if (opts.onLoginSuccessNavigationOverride) {
        // Test seam — pretend the user logged in.
        await page.goto(opts.onLoginSuccessNavigationOverride);
      }

      // Poll loop: every pollMs, check onLoginSuccess. Stop on success,
      // page-closed-by-user, cancel(), or timeout.
      const startedAt = Date.now();
      let done = false;
      const interval = setInterval(async () => {
        if (done || !page) return;
        try {
          if (page.isClosed()) {
            log.info('login page closed by user before success');
            done = true;
            clearInterval(interval);
            attempting = false;
            return;
          }
          const ok = await opts.adapter.onLoginSuccess(page);
          if (ok) {
            done = true;
            clearInterval(interval);
            lastSuccessAt = new Date().toISOString();
            attempting = false;
            // Persist session metadata + enable the site so wizard completion gates pass.
            updateSiteSession(opts.db, SITE_ID, {
              session_path: `${SITE_ID}`,
              session_valid_at: lastSuccessAt,
            });
            updateSiteEnabled(opts.db, SITE_ID, true);
            await page.close().catch(() => undefined);
            page = null;
            return;
          }
          if (Date.now() - startedAt > timeoutMs) {
            done = true;
            clearInterval(interval);
            attempting = false;
            lastError = 'timed_out';
            await page.close().catch(() => undefined);
            page = null;
          }
        } catch (err) {
          done = true;
          clearInterval(interval);
          attempting = false;
          lastError = err instanceof Error ? err.message : String(err);
          await page?.close().catch(() => undefined);
          page = null;
        }
      }, pollMs);
      stop = () => {
        done = true;
        clearInterval(interval);
      };
    } catch (err) {
      attempting = false;
      lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async function cancelConnect(): Promise<void> {
    stop?.();
    stop = null;
    attempting = false;
    if (page) {
      await page.close().catch(() => undefined);
      page = null;
    }
  }

  async function disconnect(): Promise<void> {
    await cancelConnect();
    await opts.browserManager.closeContext(SITE_ID);
    lastSuccessAt = null;
    lastError = null;
    updateSiteSession(opts.db, SITE_ID, { session_path: null, session_valid_at: null });
    updateSiteEnabled(opts.db, SITE_ID, false);
  }

  return { startConnect, cancelConnect, disconnect, getStatus };
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @vina/server test -- linkedin-connect-service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/linkedin-connect-service.ts packages/server/tests/services/linkedin-connect-service.test.ts
git commit -m "feat(server): add linkedin-connect-service for headed login flow"
```

---

### Task 9: HTTP routes for `/api/sites/linkedin/*`

**Files:**
- Modify: `packages/server/src/http/routes/sites.ts`
- Modify: `packages/server/src/app.ts` (pass `linkedInConnectService` to siteRoutes)
- Modify: `packages/server/src/main.ts` (instantiate + pass)
- Test: `packages/server/tests/http/sites.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/server/tests/http/sites.test.ts`:

```ts
describe('LinkedIn connect endpoints', () => {
  it('GET /api/sites/linkedin/status returns the initial state', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sites/linkedin/status', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      connected: false,
      attempting: false,
      last_success_at: null,
    });
  });

  it('POST /api/sites/linkedin/connect starts an attempt and is idempotent', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/sites/linkedin/connect', headers });
    expect(a.statusCode).toBe(202);
    expect(a.json()).toMatchObject({ attempting: true });
    const b = await app.inject({ method: 'POST', url: '/api/sites/linkedin/connect', headers });
    expect(b.statusCode).toBe(202);
    expect(b.json()).toMatchObject({ attempting: true });
  });

  it('DELETE /api/sites/linkedin/connect cancels the attempt', async () => {
    await app.inject({ method: 'POST', url: '/api/sites/linkedin/connect', headers });
    const res = await app.inject({
      method: 'DELETE', url: '/api/sites/linkedin/connect', headers,
    });
    expect(res.statusCode).toBe(204);
  });

  it('DELETE /api/sites/linkedin disconnects (clears session)', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/sites/linkedin', headers });
    expect(res.statusCode).toBe(204);
  });
});
```

The existing `app` fixture in this test file is built with a fake (or no) connect service; provide a stub that satisfies the interface. Use the `createLinkedInConnectService` against a freshly created BrowserManager backed by the LinkedIn fixture (similar to Task 8).

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- sites`
Expected: FAIL — endpoints not present.

- [ ] **Step 3: Add endpoints + plumb the service**

In `packages/server/src/http/routes/sites.ts`, extend the `siteRoutes` deps and add new routes. Replace the route signature:

```ts
import type { LinkedInConnectService } from '../../services/linkedin-connect-service.js';

export async function siteRoutes(
  app: FastifyInstance,
  deps: {
    db: DatabaseType;
    config: ServerConfig;
    linkedInConnectService: LinkedInConnectService;
  },
): Promise<void> {
  const { db, config, linkedInConnectService } = deps;
```

Append four new route handlers after the existing ones:

```ts
  app.get('/api/sites/linkedin/status', async () => linkedInConnectService.getStatus());

  app.post('/api/sites/linkedin/connect', async (_req, reply) => {
    await linkedInConnectService.startConnect();
    return reply.status(202).send({ attempting: true });
  });

  app.delete('/api/sites/linkedin/connect', async (_req, reply) => {
    await linkedInConnectService.cancelConnect();
    return reply.status(204).send();
  });

  app.delete('/api/sites/linkedin', async (_req, reply) => {
    await linkedInConnectService.disconnect();
    return reply.status(204).send();
  });
```

In `packages/server/src/app.ts`, extend `BuildAppDeps`:

```ts
import type { LinkedInConnectService } from './services/linkedin-connect-service.js';

export interface BuildAppDeps {
  db: DatabaseType;
  config: ServerConfig;
  version: string;
  startedAt: string;
  bus: EventBus;
  browserManager: BrowserManagerHandle;
  linkedInConnectService: LinkedInConnectService;
}
```

In `siteRoutes` invocation:

```ts
    await siteRoutes(api, { db: deps.db, config: deps.config, linkedInConnectService: deps.linkedInConnectService });
```

In `packages/server/src/main.ts`, instantiate the service and pass it through:

```ts
import { linkedInAdapter } from '@vina/automation';
import { createLinkedInConnectService } from './services/linkedin-connect-service.js';

  const linkedInConnectService = createLinkedInConnectService({
    db, bus, browserManager, adapter: linkedInAdapter,
  });

  const app = await buildApp({
    db, config, version, startedAt, bus, browserManager, linkedInConnectService,
  });
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @vina/server test -- sites`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/routes/sites.ts packages/server/src/app.ts packages/server/src/main.ts packages/server/tests/http/sites.test.ts
git commit -m "feat(server): add /api/sites/linkedin/{connect,status} endpoints"
```

---

## Phase 4 — Server: Real LinkedIn Search Worker

### Task 10: Replace M10 stub with real LinkedIn flow

**Files:**
- Modify: `packages/server/src/queue/handlers/search.ts`
- Modify: `packages/server/src/queue/handlers/search.test.ts` (rewrite — old assertions are about the stub)
- Create: `packages/server/src/queue/handlers/errors.ts` (`LinkedInSessionExpiredError`)

- [ ] **Step 1: Write the failing test**

Rewrite `packages/server/tests/queue/handlers/search.test.ts`. The new test boots the LinkedIn fixture, points the adapter at it via a `loginUrlOverride` injected through search-handler deps, and asserts:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createBrowserManager, linkedInAdapter } from '@vina/automation';
import { startLinkedInFixture } from '../../../../../tests/fixtures/sites/linkedin/server.js';
import type { FixtureServerHandle } from '../../../../../tests/fixtures/start-server.js';
import { listJobs } from '../../../src/db/repositories/jobs.js';
import { listPending } from '../../../src/db/repositories/task-queue.js';
import { listAlerts } from '../../../src/db/repositories/alerts.js';
import { createEventBus } from '../../../src/events/bus.js';
import { createSearchHandler } from '../../../src/queue/handlers/search.js';
import { freshTestDb } from '../../db/helpers.js';
import { getOrInitSearchPreferences } from '../../../src/db/repositories/search-preferences.js';

let fixture: FixtureServerHandle;
beforeAll(async () => { fixture = await startLinkedInFixture(); });
afterAll(async () => { await fixture.close(); });

let db: DatabaseType;
let dataDir: string;
beforeEach(() => {
  db = freshTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-search-'));
  // ensure search prefs exist with defaults
  getOrInitSearchPreferences(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('search handler — real LinkedIn flow', () => {
  it('inserts jobs from the fixture and enqueues a score task per listing', async () => {
    const bus = createEventBus();
    const browserManager = createBrowserManager({ dataDir });
    const handler = createSearchHandler({
      db, bus, browserManager,
      adapters: { linkedin: linkedInAdapter },
      // test seams
      feedUrlOverride: `${fixture.url}/feed`,
    });

    await handler({ site_id: 'linkedin' });

    const jobs = listJobs(db, { site_id: 'linkedin' });
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    const pending = listPending(db);
    expect(pending.filter((t) => t.kind === 'score').length).toBe(jobs.length);

    await browserManager.closeAll();
  }, 60_000);

  it('emits a linkedin_session_expired alert and throws if the page is on /login at task start', async () => {
    const bus = createEventBus();
    const browserManager = createBrowserManager({ dataDir });
    const handler = createSearchHandler({
      db, bus, browserManager,
      adapters: { linkedin: linkedInAdapter },
      feedUrlOverride: `${fixture.url}/login`, // already at login => session expired
    });

    await expect(handler({ site_id: 'linkedin' })).rejects.toThrow(/session/i);

    const alerts = listAlerts(db, { kind: 'linkedin_session_expired' });
    expect(alerts.length).toBe(1);

    await browserManager.closeAll();
  }, 60_000);
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- search`
Expected: FAIL — handler still M10 stub.

- [ ] **Step 3: Implement the new handler**

Create `packages/server/src/queue/handlers/errors.ts`:

```ts
export class LinkedInSessionExpiredError extends Error {
  constructor() {
    super('linkedin_session_expired');
    this.name = 'LinkedInSessionExpiredError';
  }
}
```

Replace `packages/server/src/queue/handlers/search.ts` entirely:

```ts
import type { Database as DatabaseType } from 'better-sqlite3';
import { createLogger, ValidationError } from '@vina/shared';
import type { BrowserManagerHandle, SiteAdapter } from '@vina/automation';
import { findSiteById, updateSiteSession } from '../../db/repositories/sites.js';
import { insertJob, updateJobStatus, findJobById } from '../../db/repositories/jobs.js';
import { enqueue } from '../../db/repositories/task-queue.js';
import { insertAlert } from '../../db/repositories/alerts.js';
import {
  incrementScheduleFailures,
  resetScheduleFailures,
  setSchedulePaused,
  findScheduleById,
} from '../../db/repositories/schedules.js';
import { getOrInitSearchPreferences } from '../../db/repositories/search-preferences.js';
import type { EventBus } from '../../events/bus.js';
import { LinkedInSessionExpiredError } from './errors.js';

const log = createLogger('handler.search');

export interface SearchHandlerDeps {
  db: DatabaseType;
  bus: EventBus;
  browserManager: BrowserManagerHandle;
  adapters: Record<string, SiteAdapter>;
  /** Test seam — overrides the post-context navigation target. */
  feedUrlOverride?: string;
}

export interface SearchPayload {
  site_id: string;
  /** Only set when the scheduler enqueues; manual Search now omits it. */
  schedule_id?: string;
  /** Used by the worker to attribute the WS event back to a task id. */
  task_id?: string;
}

const FEED_URL = 'https://www.linkedin.com/feed';

export function createSearchHandler(
  deps: SearchHandlerDeps,
): (payload: SearchPayload) => Promise<void> {
  return async (payload) => {
    const site = findSiteById(deps.db, payload.site_id);
    if (!site) throw new ValidationError(`Unknown site_id: ${payload.site_id}`);

    const adapter = deps.adapters[site.id];
    if (!adapter) throw new ValidationError(`No adapter registered for site: ${site.id}`);

    const prefs = getOrInitSearchPreferences(deps.db);
    deps.bus.emit('search:started', {
      task_id: payload.task_id ?? 'unknown',
      site_id: site.id,
    });

    let listingsAdded = 0;
    let scoredEnqueued = 0;

    try {
      const ctx = await deps.browserManager.getContext(site.id);
      const page = await ctx.newPage();
      try {
        await page.goto(deps.feedUrlOverride ?? FEED_URL);

        if (await adapter.onSessionExpired(page)) {
          throw new LinkedInSessionExpiredError();
        }

        for await (const raw of adapter.search(page, prefs)) {
          try {
            const job = insertJob(deps.db, {
              site_id: site.id,
              external_id: raw.externalId,
              url: raw.url,
              apply_method: 'auto', // refined below by detectApplyMethod
              title: raw.title,
              company: raw.company,
              location: raw.location,
              description: raw.snippet ?? '',
              posted_at: raw.postedAt,
            });
            const detail = await adapter.openListing(page, raw);
            const apply = await adapter.detectApplyMethod(page, raw);
            // Update description, salary, apply method, and external URL.
            deps.db
              .prepare(
                `UPDATE jobs
                   SET description = ?, salary_text = ?, apply_method = ?, external_apply_url = ?
                 WHERE id = ?`,
              )
              .run(
                detail.description,
                detail.salaryText,
                apply.method,
                apply.method === 'manual' ? apply.externalApplyUrl : null,
                job.id,
              );
            enqueue(deps.db, { kind: 'score', payload: { job_id: job.id } });
            scoredEnqueued += 1;
            listingsAdded += 1;
            deps.bus.emit('jobs:updated', { ids: [job.id] });
          } catch (err) {
            // Per-listing skip per spec §4.3
            log.warn({ err, externalId: raw.externalId }, 'listing extraction failed; skipping');
          }
        }
      } finally {
        await page.close().catch(() => undefined);
      }

      // Successful run — reset schedule failure counter.
      if (payload.schedule_id) resetScheduleFailures(deps.db, payload.schedule_id);

      updateSiteSession(deps.db, site.id, {
        session_path: site.session_path ?? site.id,
        session_valid_at: new Date().toISOString(),
      });

      deps.bus.emit('search:completed', {
        task_id: payload.task_id ?? 'unknown',
        site_id: site.id,
        listings_added: listingsAdded,
        scored: scoredEnqueued,
      });
    } catch (err) {
      const isSessionExpired = err instanceof LinkedInSessionExpiredError;
      const errorKind = isSessionExpired ? 'session_expired' : 'unknown';
      deps.bus.emit('search:failed', {
        task_id: payload.task_id ?? 'unknown',
        site_id: site.id,
        error_kind: errorKind,
      });

      if (isSessionExpired) {
        insertAlert(deps.db, {
          kind: 'linkedin_session_expired',
          severity: 'action_required',
          title: 'LinkedIn session expired',
          description: 'Re-connect LinkedIn from Settings to resume searches.',
          site_id: site.id,
        });
        deps.bus.emit('linkedin:session-expired', { at: new Date().toISOString() });
      } else {
        insertAlert(deps.db, {
          kind: 'search_failed',
          severity: 'error',
          title: 'Search failed',
          description: err instanceof Error ? err.message : String(err),
          site_id: site.id,
        });
      }

      if (payload.schedule_id) {
        incrementScheduleFailures(deps.db, payload.schedule_id);
        const schedule = findScheduleById(deps.db, payload.schedule_id);
        if (schedule && schedule.consecutive_failures >= 3) {
          setSchedulePaused(deps.db, payload.schedule_id, true);
          insertAlert(deps.db, {
            kind: 'schedule_paused',
            severity: 'action_required',
            title: 'Schedule paused',
            description: '3 consecutive search failures. Re-enable from Settings.',
            site_id: site.id,
          });
        }
      }

      throw err; // worker handles retry/backoff per its own policy
    }
  };
}
```

- [ ] **Step 4: Run the tests, expect pass**

Run: `pnpm --filter @vina/server test -- search`
Expected: PASS (both new test cases).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/queue/handlers/search.ts packages/server/src/queue/handlers/errors.ts packages/server/tests/queue/handlers/search.test.ts
git commit -m "feat(server): replace search stub with real LinkedIn flow"
```

---

### Task 11: Scheduler — skip paused schedules and pass `schedule_id`

**Files:**
- Modify: `packages/server/src/scheduler/scheduler.ts`
- Test: `packages/server/tests/scheduler/scheduler.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/server/tests/scheduler/scheduler.test.ts`:

```ts
it('skips firing for paused schedules', () => {
  const sch = insertSchedule(db, { cron_expression: '*/5 * * * *' });
  setSchedulePaused(db, sch.id, true);
  scheduler.fireNow(sch.id);
  expect(listPending(db)).toHaveLength(0);
});

it('embeds schedule_id in the search task payload', () => {
  const sch = insertSchedule(db, { cron_expression: '*/5 * * * *' });
  // enable linkedin first
  updateSiteEnabled(db, 'linkedin', true);
  scheduler.fireNow(sch.id);
  const tasks = listPending(db);
  const search = tasks.find((t) => t.kind === 'search');
  expect(search).toBeDefined();
  expect(JSON.parse(search!.payload)).toMatchObject({ site_id: 'linkedin', schedule_id: sch.id });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- scheduler`
Expected: FAIL.

- [ ] **Step 3: Update the scheduler**

In `packages/server/src/scheduler/scheduler.ts`, modify `fire(scheduleId)`:

After the `findScheduleById` call, return early if paused:

```ts
    if (schedule.paused) {
      log.info({ scheduleId }, 'schedule is paused; skipping fire');
      return;
    }
```

Update the enqueue call to include `schedule_id`:

```ts
    for (const site of enabledSites) {
      enqueue(options.db, {
        kind: 'search',
        payload: { site_id: site.id, schedule_id: scheduleId },
      });
    }
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @vina/server test -- scheduler`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scheduler/scheduler.ts packages/server/tests/scheduler/scheduler.test.ts
git commit -m "feat(server): skip paused schedules; thread schedule_id into search payloads"
```

---

## Phase 5 — Server: Jobs and Searches HTTP Routes

### Task 12: `/api/jobs` GET routes

**Files:**
- Create: `packages/server/src/http/routes/jobs.ts`
- Modify: `packages/server/src/app.ts` (register)
- Test: `packages/server/tests/http/jobs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/http/jobs.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, type TestAppHandle } from './helpers.js';
import { insertJob, updateJobScore, updateJobStatus } from '../../src/db/repositories/jobs.js';

let h: TestAppHandle;
let app: FastifyInstance;
let headers: Record<string, string>;
beforeEach(async () => {
  h = await buildTestApp();
  app = h.app;
  headers = { authorization: `Bearer ${h.token}` };
});
afterEach(async () => { await h.close(); });

function seedJob(opts: { score?: number; status?: string; title?: string }) {
  const j = insertJob(h.db, {
    site_id: 'linkedin',
    external_id: `ext-${Math.random().toString(36).slice(2)}`,
    url: 'https://linkedin.com/x',
    apply_method: 'auto',
    title: opts.title ?? 'Engineer',
    company: 'Acme',
    description: 'desc',
  });
  if (opts.score !== undefined) updateJobScore(h.db, j.id, opts.score, 'reason');
  if (opts.status) updateJobStatus(h.db, j.id, opts.status as never);
  return j;
}

describe('GET /api/jobs', () => {
  it('filters by status and min_score', async () => {
    seedJob({ score: 50, status: 'scored' });
    seedJob({ score: 80, status: 'scored', title: 'Hi-score' });
    seedJob({ status: 'skipped' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs?status=scored&min_score=70',
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe('Hi-score');
  });

  it('paginates', async () => {
    for (let i = 0; i < 5; i++) seedJob({ score: 70 + i, status: 'scored' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs?status=scored&page=2&page_size=2',
      headers,
    });
    expect(res.json().items).toHaveLength(2);
    expect(res.json().page).toBe(2);
  });
});

describe('GET /api/jobs/:id', () => {
  it('returns the row', async () => {
    const j = seedJob({});
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${j.id}`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(j.id);
  });
  it('404s on missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs/missing', headers });
    expect(res.statusCode).toBe(404);
  });
});
```

(Use the existing `buildTestApp` helper if present in `tests/http/helpers.ts`; otherwise model on `cvs.test.ts`.)

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- jobs`
Expected: FAIL — endpoint missing.

- [ ] **Step 3: Implement the routes**

Create `packages/server/src/http/routes/jobs.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { JOB_STATUSES, NotFoundError } from '@vina/shared';
import { findJobById, listJobs } from '../../db/repositories/jobs.js';
import { parse } from '../parse.js';

const ListQuerySchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  min_score: z.coerce.number().int().min(0).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
});

const IdParamsSchema = z.object({ id: z.string().min(1) });

export async function jobRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType },
): Promise<void> {
  const { db } = deps;

  app.get('/api/jobs', async (req) => {
    const q = parse(ListQuerySchema, req.query, 'query');
    const offset = (q.page - 1) * q.page_size;
    const rows = listJobs(db, {
      ...(q.status && { status: q.status }),
      ...(q.min_score !== undefined && { min_score: q.min_score }),
      limit: q.page_size,
      offset,
    });
    return { items: rows, page: q.page, page_size: q.page_size };
  });

  app.get('/api/jobs/:id', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const job = findJobById(db, id);
    if (!job) throw new NotFoundError(`Job ${id} not found`);
    return job;
  });
}
```

In `packages/server/src/app.ts`, import and register:

```ts
import { jobRoutes } from './http/routes/jobs.js';
// ...inside buildApp's register block:
    await jobRoutes(api, { db: deps.db });
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @vina/server test -- jobs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/routes/jobs.ts packages/server/src/app.ts packages/server/tests/http/jobs.test.ts
git commit -m "feat(server): add GET /api/jobs and GET /api/jobs/:id"
```

---

### Task 13: `/api/jobs/:id/{applied,skip,scored}` status flips

**Files:**
- Modify: `packages/server/src/http/routes/jobs.ts`
- Test: extend `packages/server/tests/http/jobs.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/tests/http/jobs.test.ts`:

```ts
import { findJobById } from '../../src/db/repositories/jobs.js';

describe('job status flips', () => {
  it('POST /api/jobs/:id/applied flips to applied_manually', async () => {
    const j = seedJob({ status: 'scored' });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${j.id}/applied`, headers });
    expect(res.statusCode).toBe(200);
    expect(findJobById(h.db, j.id)?.status).toBe('applied_manually');
  });

  it('POST /api/jobs/:id/skip flips to skipped', async () => {
    const j = seedJob({ status: 'scored' });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${j.id}/skip`, headers });
    expect(res.statusCode).toBe(200);
    expect(findJobById(h.db, j.id)?.status).toBe('skipped');
  });

  it('POST /api/jobs/:id/scored flips to scored (undo)', async () => {
    const j = seedJob({ status: 'skipped' });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${j.id}/scored`, headers });
    expect(res.statusCode).toBe(200);
    expect(findJobById(h.db, j.id)?.status).toBe('scored');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @vina/server test -- jobs`
Expected: FAIL.

- [ ] **Step 3: Implement the routes**

In `packages/server/src/http/routes/jobs.ts`, add three endpoints inside `jobRoutes`:

```ts
import { updateJobStatus } from '../../db/repositories/jobs.js';

  app.post('/api/jobs/:id/applied', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const job = findJobById(db, id);
    if (!job) throw new NotFoundError(`Job ${id} not found`);
    return updateJobStatus(db, id, 'applied_manually');
  });

  app.post('/api/jobs/:id/skip', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const job = findJobById(db, id);
    if (!job) throw new NotFoundError(`Job ${id} not found`);
    return updateJobStatus(db, id, 'skipped');
  });

  app.post('/api/jobs/:id/scored', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const job = findJobById(db, id);
    if (!job) throw new NotFoundError(`Job ${id} not found`);
    return updateJobStatus(db, id, 'scored');
  });
```

After each successful update, emit `jobs:updated` for live UI feedback. Pass `bus` in deps:

```ts
export async function jobRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType; bus: EventBus },
): Promise<void> {
  // ...
  // After updateJobStatus(...) in each handler:
  deps.bus.emit('jobs:updated', { ids: [id] });
```

In `app.ts`, pass `bus`:

```ts
    await jobRoutes(api, { db: deps.db, bus: deps.bus });
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @vina/server test -- jobs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/routes/jobs.ts packages/server/src/app.ts packages/server/tests/http/jobs.test.ts
git commit -m "feat(server): add job status-flip endpoints"
```

---

### Task 13b: Worker exhausted-retry alert hook for `score` kind

**Files:**
- Modify: `packages/server/src/queue/worker.ts`
- Modify: `packages/server/src/main.ts` (pass alert-emit hook into worker options)
- Test: `packages/server/tests/queue/worker.test.ts` (extend)

The score handler retries 3× via the existing worker backoff. When the final attempt fails (`fail(retry=false)` path for kind=`score`), the worker should emit a `score_failed` alert. Adding a generic `onTerminalFailure?: (task: Task, reason: string) => void` callback to `WorkerOptions` keeps the worker decoupled from alerts; `main.ts` wires it.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/tests/queue/worker.test.ts`:

```ts
it('calls onTerminalFailure exactly once when retries are exhausted', async () => {
  const calls: Array<{ kind: string; reason: string }> = [];
  const handlers = { score: async () => { throw new Error('boom'); } };
  const worker = createWorker({
    db, bus,
    handlers,
    backoffMs: [1, 1, 1],
    onTerminalFailure: (task, reason) => calls.push({ kind: task.kind, reason }),
  });
  enqueue(db, { kind: 'score', payload: { job_id: 'j' }, max_attempts: 1 });
  worker.start();
  await waitFor(() => calls.length === 1, 1500);
  await worker.stop();
  expect(calls[0]).toMatchObject({ kind: 'score' });
  expect(calls[0]?.reason).toContain('boom');
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @vina/server test -- worker`
Expected: FAIL.

- [ ] **Step 3: Add the hook**

In `packages/server/src/queue/worker.ts`, extend `WorkerOptions`:

```ts
  onTerminalFailure?: (task: Task, reason: string) => void;
```

Inside `runOne`, when calling `fail(..., false)` (the no-retry path, both for unhandled-kind and exhausted-retry branches), call the hook:

```ts
      } else {
        fail(options.db, task.id, reason, false);
        options.onTerminalFailure?.(task, reason);
      }
```

(Two call sites: the unhandled-kind branch and the exhausted-retry branch. Decide implementation-time whether to call the hook for unhandled-kind too — the spec is silent, but firing it is harmless and surfaces config bugs. Default: fire on both terminal-failure paths.)

- [ ] **Step 4: Wire alerts in main.ts**

```ts
import { insertAlert } from './db/repositories/alerts.js';

  const worker = createWorker({
    db, bus, handlers,
    onTerminalFailure: (task, reason) => {
      if (task.kind === 'score') {
        insertAlert(db, {
          kind: 'score_failed',
          severity: 'error',
          title: 'Scoring failed',
          description: reason,
          payload: { task_id: task.id },
        });
      }
    },
  });
```

- [ ] **Step 5: Run tests, expect pass**

Run: `pnpm --filter @vina/server test -- worker`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/queue/worker.ts packages/server/src/main.ts packages/server/tests/queue/worker.test.ts
git commit -m "feat(server): emit score_failed alert when score retries exhaust"
```

---

### Task 14: `POST /api/searches/run-now`

**Files:**
- Create: `packages/server/src/http/routes/searches.ts`
- Modify: `packages/server/src/app.ts` (register)
- Test: `packages/server/tests/http/searches.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { listPending } from '../../src/db/repositories/task-queue.js';
// ... typical app fixture from helpers

describe('POST /api/searches/run-now', () => {
  it('enqueues a search task with site_id=linkedin and no schedule_id', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/searches/run-now', headers,
      payload: { site_id: 'linkedin' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { task_id: string };
    expect(body.task_id).toBeTruthy();
    const tasks = listPending(db);
    const task = tasks.find((t) => t.kind === 'search');
    expect(task).toBeDefined();
    const payload = JSON.parse(task!.payload);
    expect(payload.site_id).toBe('linkedin');
    expect(payload.schedule_id).toBeUndefined();
  });

  it('returns the existing in-flight task id when one is already pending', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/searches/run-now', headers, payload: { site_id: 'linkedin' } });
    const b = await app.inject({ method: 'POST', url: '/api/searches/run-now', headers, payload: { site_id: 'linkedin' } });
    expect(a.json()).toEqual(b.json()); // idempotent
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @vina/server test -- searches`
Expected: FAIL.

- [ ] **Step 3: Implement the route**

Create `packages/server/src/http/routes/searches.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { findSiteById } from '../../db/repositories/sites.js';
import { enqueue, listPending } from '../../db/repositories/task-queue.js';
import { NotFoundError } from '@vina/shared';
import { parse } from '../parse.js';

const BodySchema = z.object({ site_id: z.string().min(1) });

export async function searchRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType; poke: () => void },
): Promise<void> {
  const { db, poke } = deps;

  app.post('/api/searches/run-now', async (req, reply) => {
    const body = parse(BodySchema, req.body);
    const site = findSiteById(db, body.site_id);
    if (!site) throw new NotFoundError(`Site ${body.site_id} not found`);

    // Idempotent: if a pending search task for this site already exists,
    // return its id rather than enqueueing a duplicate.
    const inFlight = listPending(db).find(
      (t) =>
        t.kind === 'search' &&
        (JSON.parse(t.payload) as { site_id?: string }).site_id === site.id,
    );
    if (inFlight) {
      return reply.status(202).send({ task_id: inFlight.id, deduped: true });
    }

    const task = enqueue(db, { kind: 'search', payload: { site_id: site.id } });
    poke();
    return reply.status(202).send({ task_id: task.id, deduped: false });
  });
}
```

In `app.ts`, extend `BuildAppDeps` with `poke: () => void` and register:

```ts
    await searchRoutes(api, { db: deps.db, poke: deps.poke });
```

In `main.ts`, pass `poke: () => worker.poke()` to `buildApp`.

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @vina/server test -- searches`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/routes/searches.ts packages/server/src/app.ts packages/server/src/main.ts packages/server/tests/http/searches.test.ts
git commit -m "feat(server): add idempotent POST /api/searches/run-now"
```

---

## Phase 6 — Web: Wizard Refactor + ConnectLinkedIn Step

### Task 15: Update wizard step order + completion check

**Files:**
- Modify: `packages/web/src/routes/onboarding/use-wizard.ts`
- Modify: `packages/web/src/routes/onboarding/index.tsx` (route map)

- [ ] **Step 1: Write the change**

Replace the `STEPS`, `REQUIRED_STEPS`, `STEP_LABELS`, and `useWizardCompletion` in `packages/web/src/routes/onboarding/use-wizard.ts` with the new order:

```ts
export const STEPS = [
  'welcome',
  'profile',
  'cv',
  'llm-provider',
  'preferences',
  'schedule',
  'connect-linkedin',
  'done',
] as const;
export type StepId = (typeof STEPS)[number];

export const REQUIRED_STEPS: ReadonlySet<StepId> = new Set<StepId>([
  'profile',
  'cv',
  'llm-provider',
  'connect-linkedin',
]);

export const STEP_LABELS: Record<StepId, string> = {
  welcome: 'Welcome',
  profile: 'Profile',
  cv: 'CV',
  'llm-provider': 'LLM Provider',
  preferences: 'Search preferences',
  schedule: 'Schedule',
  'connect-linkedin': 'Connect LinkedIn',
  done: 'Done',
};

interface CompletionFlags {
  profile: boolean;
  'llm-provider': boolean;
  cv: boolean;
  'connect-linkedin': boolean;
}

export function useWizardCompletion(): {
  flags: CompletionFlags | null;
  isLoading: boolean;
  allRequiredDone: boolean;
} {
  const profile = useProfile();
  const providers = useLlmProviders();
  const cvs = useCvs();
  const linkedin = useLinkedInStatus(); // see Task 17

  const isLoading =
    profile.isLoading || providers.isLoading || cvs.isLoading || linkedin.isLoading;
  if (isLoading) return { flags: null, isLoading: true, allRequiredDone: false };

  const flags: CompletionFlags = {
    profile: profile.data !== null,
    'llm-provider': providers.data.length > 0,
    cv: cvs.data.length > 0,
    'connect-linkedin': linkedin.data?.connected === true,
  };
  const allRequiredDone =
    flags.profile && flags['llm-provider'] && flags.cv && flags['connect-linkedin'];
  return { flags, isLoading: false, allRequiredDone };
}

export function firstIncompleteStep(flags: CompletionFlags): Exclude<StepId, 'welcome'> {
  if (!flags.profile) return 'profile';
  if (!flags.cv) return 'cv';
  if (!flags['llm-provider']) return 'llm-provider';
  if (!flags['connect-linkedin']) return 'connect-linkedin';
  return 'done';
}
```

`useNextStep` and `usePrevStep` keep their logic but operate on the new array.

In `packages/web/src/routes/onboarding/index.tsx`, replace the route registrations with the new step set. Keep the `Sources`, `CoverLetter`, `Mode` files as unrouted (do not register routes for them; do not delete the files — spec §1.4 says files unchanged).

Add the new step component import:

```ts
const ConnectLinkedIn = lazy(() =>
  import('./steps/ConnectLinkedIn.js').then((m) => ({ default: m.ConnectLinkedIn })),
);
```

And the route:

```tsx
        <Route
          path="connect-linkedin"
          element={
            <StepGuard step="connect-linkedin">
              <ConnectLinkedIn />
            </StepGuard>
          }
        />
```

Remove `<Route path="cover-letter" ... />`, `<Route path="sources" ... />`, `<Route path="mode" ... />`.

- [ ] **Step 2: This task depends on Task 17 (the LinkedIn status hook). Land Task 17 before this and the build will pass.**

Run: `pnpm --filter @vina/web typecheck` (after Task 17 lands).
Expected: PASS.

- [ ] **Step 3: Commit (after Task 17 also)**

```bash
git add packages/web/src/routes/onboarding/use-wizard.ts packages/web/src/routes/onboarding/index.tsx
git commit -m "feat(web): wizard step order — drop sources/cover-letter/mode, add connect-linkedin"
```

---

### Task 16: `ConnectLinkedIn` wizard step component

**Files:**
- Create: `packages/web/src/routes/onboarding/steps/ConnectLinkedIn.tsx`

- [ ] **Step 1: Implement the component (no TDD — UI-only; visual verification in Phase 9)**

```tsx
import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import {
  useLinkedInStatus,
  useStartLinkedInConnect,
  useCancelLinkedInConnect,
} from '../../../api/resources.js';
import { useNextStep, usePrevStep } from '../use-wizard.js';

type UiState = 'initial' | 'launching' | 'waiting' | 'connected' | 'timed_out' | 'error';

export function ConnectLinkedIn(): JSX.Element {
  const status = useLinkedInStatus({ pollMs: 1500 });
  const start = useStartLinkedInConnect();
  const cancel = useCancelLinkedInConnect();
  const next = useNextStep();
  const prev = usePrevStep();

  const ui: UiState = (() => {
    if (status.data?.connected) return 'connected';
    if (status.data?.error === 'timed_out') return 'timed_out';
    if (status.data?.attempting) return 'waiting';
    if (start.isPending) return 'launching';
    return 'initial';
  })();

  useEffect(() => {
    if (ui === 'connected') {
      const t = setTimeout(() => next('connect-linkedin'), 1000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [ui, next]);

  return (
    <section className="space-y-4">
      <h1 className="font-display text-3xl tracking-tight">Connect LinkedIn</h1>
      <p className="text-sm text-ink-secondary">
        Vina will open a browser window. Log in to LinkedIn there and we&rsquo;ll continue
        automatically.
      </p>

      {ui === 'initial' && (
        <Button onClick={() => start.mutate()}>Connect LinkedIn</Button>
      )}
      {ui === 'launching' && <p>Launching browser…</p>}
      {ui === 'waiting' && (
        <div>
          <p>Log in to LinkedIn in the window we just opened.</p>
          <button className="text-sm underline" onClick={() => cancel.mutate()}>
            Cancel
          </button>
        </div>
      )}
      {ui === 'connected' && <p>✅ Connected to LinkedIn.</p>}
      {ui === 'timed_out' && (
        <div className="space-y-2">
          <p>Login is taking longer than expected.</p>
          <Button onClick={() => start.mutate()}>Try again</Button>
          <button className="text-sm underline" onClick={() => next('connect-linkedin')}>
            Skip for now (no jobs will arrive)
          </button>
        </div>
      )}

      <div className="flex justify-between pt-6">
        <button onClick={() => prev('connect-linkedin')} className="text-sm">Back</button>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Visual sanity check**

Run: `pnpm dev` (in a separate terminal). Open `http://localhost:5173/onboarding/connect-linkedin`. Verify the Initial state renders with the Connect button. Click Connect; expect the API call to succeed (Phase 3 must already be merged for this to work — note this in the PR if testing in isolation).

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/routes/onboarding/steps/ConnectLinkedIn.tsx
git commit -m "feat(web): add Connect LinkedIn wizard step"
```

---

### Task 17: API resource hooks for LinkedIn connect status

**Files:**
- Modify: `packages/web/src/api/resources.ts`

- [ ] **Step 1: Add the hooks**

Append to `packages/web/src/api/resources.ts`:

```ts
export interface LinkedInStatus {
  connected: boolean;
  attempting: boolean;
  last_success_at: string | null;
  error: string | null;
}

export function useLinkedInStatus(opts: { pollMs?: number } = {}): {
  data: LinkedInStatus | null;
  isLoading: boolean;
} {
  const q = useQuery<LinkedInStatus>({
    queryKey: ['linkedin-status'],
    queryFn: () => api<LinkedInStatus>('/api/sites/linkedin/status'),
    refetchInterval: opts.pollMs ?? false,
  });
  return { data: q.data ?? null, isLoading: q.isLoading };
}

export function useStartLinkedInConnect(): {
  mutate: () => Promise<void>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<void, Error, void>({
    mutationFn: async () => {
      await api('/api/sites/linkedin/connect', { method: 'POST', body: {} });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['linkedin-status'] }),
  });
  return { mutate: () => mut.mutateAsync(), isPending: mut.isPending };
}

export function useCancelLinkedInConnect(): {
  mutate: () => Promise<void>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<void, Error, void>({
    mutationFn: async () => {
      await api('/api/sites/linkedin/connect', { method: 'DELETE' });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['linkedin-status'] }),
  });
  return { mutate: () => mut.mutateAsync(), isPending: mut.isPending };
}

export function useDisconnectLinkedIn(): {
  mutate: () => Promise<void>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<void, Error, void>({
    mutationFn: async () => {
      await api('/api/sites/linkedin', { method: 'DELETE' });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['linkedin-status'] });
      void qc.invalidateQueries({ queryKey: ['sites'] });
    },
  });
  return { mutate: () => mut.mutateAsync(), isPending: mut.isPending };
}
```

Also import `useWizardCompletion` users (`use-wizard.ts` Task 15) — make sure `useLinkedInStatus` is imported there.

- [ ] **Step 2: Run web typecheck**

Run: `pnpm --filter @vina/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/api/resources.ts
git commit -m "feat(web): add LinkedIn connect API hooks"
```

---

## Phase 7 — Web: Jobs Page

### Task 18: Jobs API hooks

**Files:**
- Modify: `packages/web/src/api/resources.ts`

- [ ] **Step 1: Implement**

Append:

```ts
import type { Job } from '@vina/shared';

export interface JobsListResponse {
  items: Job[];
  page: number;
  page_size: number;
}

export function useJobs(filters: {
  status?: 'scored' | 'applied_manually' | 'skipped';
  min_score?: number;
  page?: number;
  page_size?: number;
}): { data: Job[]; isLoading: boolean } {
  const qs = new URLSearchParams();
  if (filters.status) qs.set('status', filters.status);
  if (filters.min_score !== undefined) qs.set('min_score', String(filters.min_score));
  if (filters.page) qs.set('page', String(filters.page));
  if (filters.page_size) qs.set('page_size', String(filters.page_size));
  const q = useQuery<JobsListResponse>({
    queryKey: ['jobs', filters],
    queryFn: () => api<JobsListResponse>(`/api/jobs?${qs.toString()}`),
  });
  return { data: q.data?.items ?? [], isLoading: q.isLoading };
}

function useJobStatusMutation(suffix: 'applied' | 'skip' | 'scored') {
  const qc = useQueryClient();
  const mut = useMutation<Job, Error, string>({
    mutationFn: (id) => api<Job>(`/api/jobs/${id}/${suffix}`, { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
  return { mutate: (id: string) => mut.mutateAsync(id), isPending: mut.isPending };
}

export const useMarkApplied = () => useJobStatusMutation('applied');
export const useSkipJob = () => useJobStatusMutation('skip');
export const useReopenJob = () => useJobStatusMutation('scored');

export function useRunSearchNow(): {
  mutate: (siteId: string) => Promise<{ task_id: string; deduped: boolean }>;
  isPending: boolean;
} {
  const mut = useMutation<{ task_id: string; deduped: boolean }, Error, string>({
    mutationFn: (siteId) =>
      api(`/api/searches/run-now`, { method: 'POST', body: { site_id: siteId } }),
  });
  return { mutate: (siteId) => mut.mutateAsync(siteId), isPending: mut.isPending };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @vina/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/api/resources.ts
git commit -m "feat(web): add jobs and run-now API hooks"
```

---

### Task 19: Jobs page — tabs + JobCard + Search now

**Files:**
- Create: `packages/web/src/routes/jobs/JobsPage.tsx`
- Create: `packages/web/src/routes/jobs/JobCard.tsx`
- Modify: `packages/web/src/router.tsx` (replace `Jobs` page import; remove `/ready` route)
- Modify: `packages/web/src/routes/pages.tsx` (remove the `Jobs` stub export)

- [ ] **Step 1: Create JobCard**

`packages/web/src/routes/jobs/JobCard.tsx`:

```tsx
import type { Job } from '@vina/shared';
import { Button } from '../../components/ui/button.js';

interface Props {
  job: Job;
  onApply: () => void;
  onSkip: () => void;
  onMarkApplied: () => void;
  onReopen?: () => void;
  variant: 'new' | 'applied' | 'skipped';
}

export function JobCard({ job, onApply, onSkip, onMarkApplied, onReopen, variant }: Props): JSX.Element {
  const applyHref = job.apply_method === 'auto' ? job.url : (job.external_apply_url ?? job.url);
  const isExternal = job.apply_method === 'manual';
  return (
    <article className="rounded-lg border border-ink-line bg-surface-base p-4">
      <header className="flex items-baseline gap-2 text-sm">
        <span className="font-medium text-ink-primary">{job.title}</span>
        <span className="text-ink-secondary">·</span>
        <span>{job.company}</span>
        {job.location && (
          <>
            <span className="text-ink-secondary">·</span>
            <span>{job.location}</span>
          </>
        )}
      </header>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span
          className={`rounded-full px-2 py-0.5 ${
            isExternal ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900'
          }`}
        >
          {isExternal ? 'External' : 'Easy Apply'}
        </span>
        {job.match_score != null && (
          <span className="rounded-full bg-ink-line px-2 py-0.5">Score {job.match_score}</span>
        )}
        {job.salary_text && <span>{job.salary_text}</span>}
      </div>
      <p className="mt-2 line-clamp-2 text-sm text-ink-secondary">{job.description}</p>
      <div className="mt-3 flex gap-2">
        {variant === 'new' ? (
          <>
            <Button onClick={onApply}>Apply on LinkedIn</Button>
            <button onClick={onMarkApplied} className="text-sm">Mark applied</button>
            <button onClick={onSkip} className="text-sm">Skip</button>
          </>
        ) : (
          <button onClick={onReopen} className="text-sm">Reopen</button>
        )}
      </div>
    </article>
  );
}

// applyHref is consumed by Button via an onClick that opens window.open(applyHref, '_blank').
```

(Adjust the Button to wrap an `<a>` with `target="_blank" rel="noreferrer"` — the spec says smart-link opens in new tab.)

- [ ] **Step 2: Create JobsPage**

`packages/web/src/routes/jobs/JobsPage.tsx`:

```tsx
import { useState } from 'react';
import { useJobs, useMarkApplied, useSkipJob, useReopenJob, useRunSearchNow, useSearchPreferences, useLinkedInStatus } from '../../api/resources.js';
import { JobCard } from './JobCard.js';
import { useUiStore } from '../../store/ui-store.js';

type Tab = 'new' | 'applied' | 'skipped';

export function JobsPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('new');
  const prefs = useSearchPreferences();
  const linkedin = useLinkedInStatus({ pollMs: 5000 });
  const sessionExpired = linkedin.data && !linkedin.data.connected && !!linkedin.data.error;

  const minScore = prefs.data?.score_threshold ?? 70;
  const status = tab === 'new' ? 'scored' : tab === 'applied' ? 'applied_manually' : 'skipped';
  const jobs = useJobs({ status, min_score: tab === 'new' ? minScore : undefined });

  const markApplied = useMarkApplied();
  const skip = useSkipJob();
  const reopen = useReopenJob();
  const runNow = useRunSearchNow();
  const { addToast } = useUiStore();

  return (
    <section className="space-y-4">
      {sessionExpired && (
        <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          LinkedIn session expired. <a href="/settings#sites" className="underline">Reconnect</a>
        </div>
      )}
      <header className="flex items-center justify-between">
        <h1 className="font-display text-3xl tracking-tight">Jobs</h1>
        <button
          disabled={!!sessionExpired || runNow.isPending}
          onClick={async () => {
            const r = await runNow.mutate('linkedin');
            addToast({ id: r.task_id, message: r.deduped ? 'Already searching…' : 'Search started' });
          }}
          className="rounded bg-ink-primary px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {runNow.isPending ? 'Searching…' : 'Search now'}
        </button>
      </header>

      <nav className="flex gap-3 border-b border-ink-line">
        {(['new', 'applied', 'skipped'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`pb-2 text-sm ${tab === t ? 'border-b-2 border-ink-primary text-ink-primary' : 'text-ink-secondary'}`}
          >
            {t === 'new' ? 'New' : t === 'applied' ? 'Applied' : 'Skipped'}
          </button>
        ))}
      </nav>

      {jobs.isLoading ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : jobs.data.length === 0 ? (
        <p className="text-sm text-ink-secondary">No jobs to show.</p>
      ) : (
        <ul className="space-y-3">
          {jobs.data.map((j) => (
            <li key={j.id}>
              <JobCard
                job={j}
                variant={tab}
                onApply={() => window.open(j.apply_method === 'auto' ? j.url : (j.external_apply_url ?? j.url), '_blank', 'noreferrer')}
                onMarkApplied={async () => {
                  await markApplied.mutate(j.id);
                  addToast({ id: `a-${j.id}`, message: 'Marked applied. Undo', onUndo: () => reopen.mutate(j.id) });
                }}
                onSkip={async () => {
                  await skip.mutate(j.id);
                  addToast({ id: `s-${j.id}`, message: 'Skipped. Undo', onUndo: () => reopen.mutate(j.id) });
                }}
                onReopen={() => reopen.mutate(j.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

(`addToast` may need a small extension to accept an `onUndo` callback. If not present, extend the toast store accordingly — keep it minimal.)

- [ ] **Step 3: Wire route**

In `packages/web/src/router.tsx`:

Replace the `Jobs` lazy import with the new path:

```ts
const Jobs = lazy(() =>
  import('./routes/jobs/JobsPage.js').then((m) => ({ default: m.JobsPage })),
);
```

Remove the `/ready` route entirely:

```tsx
// delete the entire `{ path: '/ready', element: ... }` block
```

Add a redirect for legacy `/ready` URLs:

```tsx
{ path: '/ready', element: <Navigate to="/jobs" replace /> },
```

In `packages/web/src/routes/pages.tsx`, delete the `Jobs` and `ReadyToApply` exports (no longer referenced).

- [ ] **Step 4: Visual sanity check**

Run: `pnpm dev`. Open `http://localhost:5173/jobs`. Verify tabs render. With no jobs in DB, expect "No jobs to show." Click Search now (should be disabled or fire if LinkedIn connected).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/jobs/ packages/web/src/router.tsx packages/web/src/routes/pages.tsx
git commit -m "feat(web): real Jobs page with tabs, smart-link Apply, and Search now"
```

---

### Task 20: WS-driven live job updates

**Files:**
- Modify: `packages/web/src/api/ws.ts`
- Test: `packages/web/tests/api/ws.test.ts` (extend if present; otherwise smoke-test in dev server)

- [ ] **Step 1: Update the WebSocket dispatcher to invalidate jobs queries on relevant events**

In `packages/web/src/api/ws.ts`, locate the inbound-message handler and add cases for the new event types:

```ts
import { queryClient } from '../store/query-client.js';

// inside the message handler, after JSON parse:
switch (envelope.type) {
  case 'jobs:updated':
    void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    break;
  case 'search:started':
  case 'search:completed':
  case 'search:failed':
    void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    break;
  case 'linkedin:session-expired':
    void queryClient.invalidateQueries({ queryKey: ['linkedin-status'] });
    break;
}
```

(The exact dispatcher hook depends on the existing implementation — adapt to wherever `EventEnvelopeSchema` is parsed.)

- [ ] **Step 2: Sanity-check via integration**

Run dev server, open Jobs page, trigger a search via `Search now`, watch the page update. (Manual verification — no automated UI test in this slice.)

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/api/ws.ts
git commit -m "feat(web): invalidate jobs/linkedin-status on WS events"
```

---

## Phase 8 — Web: Settings → Sites Tile

### Task 21: Settings page Sites section

**Files:**
- Modify: `packages/web/src/routes/pages.tsx` (replace `Settings` stub)
- Create: `packages/web/src/routes/settings/SettingsPage.tsx`
- Create: `packages/web/src/routes/settings/SitesTile.tsx`
- Modify: `packages/web/src/router.tsx` (point `/settings` at the new component)

- [ ] **Step 1: Implement `SitesTile`**

```tsx
import { useLinkedInStatus, useStartLinkedInConnect, useDisconnectLinkedIn } from '../../api/resources.js';
import { Button } from '../../components/ui/button.js';

export function SitesTile(): JSX.Element {
  const linkedin = useLinkedInStatus({ pollMs: 3000 });
  const start = useStartLinkedInConnect();
  const disconnect = useDisconnectLinkedIn();
  return (
    <section id="sites" className="rounded-lg border border-ink-line p-4">
      <h2 className="font-display text-xl">Job sources</h2>
      <ul className="mt-3 divide-y divide-ink-line">
        <li className="flex items-center justify-between py-3">
          <div>
            <p className="font-medium">LinkedIn</p>
            <p className="text-xs text-ink-secondary">
              {linkedin.data?.connected ? '● Connected'
                : linkedin.data?.error ? '⚠ Session expired'
                : '○ Not connected'}
            </p>
          </div>
          <div className="flex gap-2">
            {linkedin.data?.connected ? (
              <button className="text-sm underline" onClick={() => disconnect.mutate()}>
                Disconnect
              </button>
            ) : (
              <Button onClick={() => start.mutate()}>Connect</Button>
            )}
          </div>
        </li>
        <li className="flex items-center justify-between py-3">
          <p className="font-medium text-ink-secondary">Indeed</p>
          <span className="rounded-full bg-ink-line px-2 py-0.5 text-xs">Coming soon</span>
        </li>
        <li className="flex items-center justify-between py-3">
          <p className="font-medium text-ink-secondary">Google Jobs</p>
          <span className="rounded-full bg-ink-line px-2 py-0.5 text-xs">Coming soon</span>
        </li>
      </ul>
    </section>
  );
}
```

- [ ] **Step 2: Implement `SettingsPage`**

```tsx
import { SitesTile } from './SitesTile.js';

export function SettingsPage(): JSX.Element {
  return (
    <section className="space-y-6">
      <h1 className="font-display text-3xl tracking-tight">Settings</h1>
      <SitesTile />
    </section>
  );
}
```

- [ ] **Step 3: Wire route**

In `packages/web/src/router.tsx`, replace the `Settings` lazy import:

```ts
const Settings = lazy(() =>
  import('./routes/settings/SettingsPage.js').then((m) => ({ default: m.SettingsPage })),
);
```

In `packages/web/src/routes/pages.tsx`, delete the `Settings` stub export.

- [ ] **Step 4: Visual sanity check**

Run: `pnpm dev`, open `/settings`. Verify the Sites tile renders. Connect button triggers headed Chromium (in dev). Disconnect appears when connected.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/settings/ packages/web/src/router.tsx packages/web/src/routes/pages.tsx
git commit -m "feat(web): Settings page Sites tile with LinkedIn connect/disconnect"
```

---

### Task 22: Sidebar — hide Chat, drop Ready-to-Apply

**Files:**
- Modify: `packages/web/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Update the nav array**

Read `Sidebar.tsx` to find the nav-item array. Remove:
- the `/chat` entry (route stays, link disappears).
- any `/ready` entry (the route is now a redirect to `/jobs` — Task 19 — so a sidebar link to `/ready` would be dead).

Keep: Dashboard, Jobs, Applications, Alerts, Profile, Settings.

- [ ] **Step 2: Visual sanity check**

Run: `pnpm dev`. Verify Chat and Ready-to-Apply links are gone. Direct navigation to `/chat` still works; `/ready` redirects to `/jobs`.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/layout/Sidebar.tsx
git commit -m "feat(web): drop /chat and /ready from sidebar"
```

---

## Phase 8b — Alerts Surface

### Task 22b: `GET /api/alerts` + resolve/dismiss endpoints

**Files:**
- Create: `packages/server/src/http/routes/alerts.ts`
- Modify: `packages/server/src/app.ts` (register)
- Test: `packages/server/tests/http/alerts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppHandle } from './helpers.js';
import { insertAlert } from '../../src/db/repositories/alerts.js';

let h: TestAppHandle;
beforeEach(async () => { h = await buildTestApp(); });
afterEach(async () => { await h.close(); });

describe('alerts routes', () => {
  it('GET /api/alerts returns open alerts by default', async () => {
    insertAlert(h.db, { kind: 'linkedin_session_expired', severity: 'action_required', title: 't', description: 'd' });
    const res = await h.app.inject({ method: 'GET', url: '/api/alerts', headers: { authorization: `Bearer ${h.token}` } });
    expect(res.json().items).toHaveLength(1);
  });
  it('POST /api/alerts/:id/resolve flips status', async () => {
    const a = insertAlert(h.db, { kind: 'general', severity: 'info', title: 't', description: 'd' });
    const res = await h.app.inject({
      method: 'POST', url: `/api/alerts/${a.id}/resolve`,
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.json().status).toBe('resolved');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @vina/server test -- alerts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `packages/server/src/http/routes/alerts.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { ALERT_STATUSES, NotFoundError } from '@vina/shared';
import {
  dismissAlert,
  findAlertById,
  listAlerts,
  resolveAlert,
} from '../../db/repositories/alerts.js';
import { parse } from '../parse.js';

const ListQuerySchema = z.object({
  status: z.enum(ALERT_STATUSES).default('open'),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
});
const IdParamsSchema = z.object({ id: z.string().min(1) });

export async function alertRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType },
): Promise<void> {
  const { db } = deps;
  app.get('/api/alerts', async (req) => {
    const q = parse(ListQuerySchema, req.query, 'query');
    const items = listAlerts(db, {
      status: q.status,
      limit: q.page_size,
      offset: (q.page - 1) * q.page_size,
    });
    return { items, page: q.page, page_size: q.page_size };
  });
  app.post('/api/alerts/:id/resolve', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    if (!findAlertById(db, id)) throw new NotFoundError(`Alert ${id} not found`);
    return resolveAlert(db, id);
  });
  app.post('/api/alerts/:id/dismiss', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    if (!findAlertById(db, id)) throw new NotFoundError(`Alert ${id} not found`);
    return dismissAlert(db, id);
  });
}
```

In `app.ts`, register: `await alertRoutes(api, { db: deps.db });`.

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @vina/server test -- alerts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/routes/alerts.ts packages/server/src/app.ts packages/server/tests/http/alerts.test.ts
git commit -m "feat(server): add /api/alerts list/resolve/dismiss"
```

---

### Task 22c: Alerts page with `linkedin_session_expired` link

**Files:**
- Modify: `packages/web/src/api/resources.ts` (alerts hooks)
- Create: `packages/web/src/routes/alerts/AlertsPage.tsx`
- Modify: `packages/web/src/router.tsx` (replace Alerts lazy import)
- Modify: `packages/web/src/routes/pages.tsx` (delete Alerts stub)

- [ ] **Step 1: Add hooks**

In `packages/web/src/api/resources.ts`:

```ts
import type { Alert } from '@vina/shared';

export function useAlerts(): { data: Alert[]; isLoading: boolean } {
  const q = useQuery<{ items: Alert[] }>({
    queryKey: ['alerts'],
    queryFn: () => api<{ items: Alert[] }>('/api/alerts?status=open'),
  });
  return { data: q.data?.items ?? [], isLoading: q.isLoading };
}

export function useResolveAlert(): { mutate: (id: string) => Promise<void> } {
  const qc = useQueryClient();
  const mut = useMutation<void, Error, string>({
    mutationFn: async (id) => { await api(`/api/alerts/${id}/resolve`, { method: 'POST', body: {} }); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });
  return { mutate: (id) => mut.mutateAsync(id) };
}
```

- [ ] **Step 2: Implement `AlertsPage.tsx`**

```tsx
import type { Alert } from '@vina/shared';
import { useAlerts, useResolveAlert } from '../../api/resources.js';

function alertHref(a: Alert): string | null {
  if (a.kind === 'linkedin_session_expired') return '/settings#sites';
  if (a.kind === 'schedule_paused') return '/settings#sites';
  return null;
}

export function AlertsPage(): JSX.Element {
  const alerts = useAlerts();
  const resolve = useResolveAlert();
  return (
    <section className="space-y-4">
      <h1 className="font-display text-3xl tracking-tight">Alerts</h1>
      {alerts.data.length === 0 ? (
        <p className="text-sm text-ink-secondary">All clear.</p>
      ) : (
        <ul className="space-y-3">
          {alerts.data.map((a) => {
            const href = alertHref(a);
            return (
              <li key={a.id} className="rounded border border-ink-line p-3">
                <p className="font-medium">{a.title}</p>
                <p className="text-sm text-ink-secondary">{a.description}</p>
                <div className="mt-2 flex gap-2 text-sm">
                  {href && <a href={href} className="underline">Reconnect</a>}
                  <button onClick={() => resolve.mutate(a.id)} className="underline">Resolve</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Wire route**

In `packages/web/src/router.tsx`:

```ts
const Alerts = lazy(() =>
  import('./routes/alerts/AlertsPage.js').then((m) => ({ default: m.AlertsPage })),
);
```

In `packages/web/src/routes/pages.tsx`, delete the `Alerts` stub export.

- [ ] **Step 4: WS invalidation**

In `packages/web/src/api/ws.ts`, in the dispatcher (already extended in Task 20), add:

```ts
  case 'alert:created':
  case 'alert:resolved':
  case 'alert:dismissed':
    void queryClient.invalidateQueries({ queryKey: ['alerts'] });
    break;
```

- [ ] **Step 5: Visual check + commit**

Run: `pnpm dev`, trigger an alert (e.g. POST a search with linkedin disconnected, or insert one via SQL), open `/alerts`. Verify it renders with reconnect link.

```bash
git add packages/web/src/api/resources.ts packages/web/src/routes/alerts/ packages/web/src/router.tsx packages/web/src/routes/pages.tsx packages/web/src/api/ws.ts
git commit -m "feat(web): Alerts page with linkedin reconnect link"
```

---

## Phase 9 — CLI Updates

### Task 23: `vina status` reports LinkedIn + queue depth + paused-schedule flag

**Files:**
- Modify: `packages/cli/src/commands/status.ts`
- Modify: `packages/server/src/http/routes/system.ts` (extend `/api/system/status` payload if not already present)
- Test: `packages/cli/tests/cli.smoke.test.ts` or `packages/server/tests/http/system.test.ts` (extend)

- [ ] **Step 1: Read existing `status` and `system` to understand current payload**

Run: `cat packages/server/src/http/routes/system.ts packages/cli/src/commands/status.ts`

- [ ] **Step 2: Write the failing test**

Add to `packages/server/tests/http/system.test.ts` (or wherever `/api/system/status` is tested):

```ts
it('returns linkedin connection, queue depth, and paused-schedule flag', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/system/status', headers });
  const body = res.json();
  expect(body).toHaveProperty('linkedin_connected');
  expect(body).toHaveProperty('linkedin_last_search_at');
  expect(body.queue).toHaveProperty('pending');
  expect(body).toHaveProperty('schedule_paused');
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @vina/server test -- system`
Expected: FAIL.

- [ ] **Step 4: Extend the system route**

In `packages/server/src/http/routes/system.ts`, expand the `/api/system/status` response. Read the LinkedIn site row, queue counts, and paused-schedule flag (any schedule with `paused = 1`).

```ts
import { findSiteById } from '../../db/repositories/sites.js';
import { countByStatus } from '../../db/repositories/task-queue.js';
import { listSchedules } from '../../db/repositories/schedules.js';

// inside the GET /api/system/status handler:
const linkedin = findSiteById(db, 'linkedin');
const pending = countByStatus(db, 'pending');
const running = countByStatus(db, 'running');
const schedulePaused = listSchedules(db).some((s) => s.paused);

return {
  // ...existing fields,
  linkedin_connected: linkedin?.session_valid_at != null,
  linkedin_last_search_at: linkedin?.last_search_at ?? null,
  queue: { pending, running },
  schedule_paused: schedulePaused,
};
```

- [ ] **Step 5: Update `vina status` to print the new fields**

In `packages/cli/src/commands/status.ts`, after the existing output add lines like:

```ts
console.log(`LinkedIn: ${status.linkedin_connected ? 'connected' : 'not connected'}`);
console.log(`Last search: ${status.linkedin_last_search_at ?? 'never'}`);
console.log(`Queue: ${status.queue.pending} pending / ${status.queue.running} running`);
if (status.schedule_paused) console.log('⚠ Schedule is paused');
```

- [ ] **Step 6: Run tests, expect pass**

Run: `pnpm --filter @vina/server test -- system && pnpm --filter @vina/cli test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/http/routes/system.ts packages/cli/src/commands/status.ts packages/server/tests/http/system.test.ts
git commit -m "feat(cli): vina status — linkedin, queue depth, paused-schedule"
```

---

### Task 24: `vina doctor` adds Chromium / profile-dir / LLM / schedule / alerts checks

**Files:**
- Modify: `packages/cli/src/commands/doctor.ts`
- Test: `packages/cli/tests/doctor.test.ts` (create or extend)

- [ ] **Step 1: Write the failing test**

```ts
import { runDoctor } from '../src/commands/doctor.js';

it('reports each new check by name', async () => {
  const result = await runDoctor({ /* mock config + db */ });
  const labels = result.checks.map((c) => c.label);
  expect(labels).toContain('Chromium');
  expect(labels).toContain('LinkedIn profile dir');
  expect(labels).toContain('LLM provider');
  expect(labels).toContain('Schedule not paused');
  expect(labels).toContain('No unacknowledged alerts');
});
```

(Adapt to the existing `runDoctor` signature — read `doctor.ts` first.)

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @vina/cli test -- doctor`
Expected: FAIL.

- [ ] **Step 3: Implement checks**

In `packages/cli/src/commands/doctor.ts`, add five new checks alongside the existing ones:

```ts
// Chromium binary check
async function checkChromium(): Promise<CheckResult> {
  try {
    const { chromium } = await import('playwright');
    const path = chromium.executablePath();
    return { label: 'Chromium', ok: !!path, detail: path ?? 'missing — run `pnpm exec playwright install chromium`' };
  } catch (err) {
    return { label: 'Chromium', ok: false, detail: String(err) };
  }
}

// Profile dir check
function checkProfileDir(dataDir: string): CheckResult {
  const dir = `${dataDir}/sessions/linkedin`;
  return { label: 'LinkedIn profile dir', ok: fs.existsSync(dir), detail: dir };
}

// LLM provider configured
function checkLlmProvider(db: DatabaseType): CheckResult {
  const settings = findSettings(db);
  return {
    label: 'LLM provider',
    ok: !!settings?.active_llm_provider_id,
    detail: settings?.active_llm_provider_id ?? 'no active provider set',
  };
}

function checkSchedule(db: DatabaseType): CheckResult {
  const paused = listSchedules(db).some((s) => s.paused);
  return { label: 'Schedule not paused', ok: !paused };
}

function checkAlerts(db: DatabaseType): CheckResult {
  const open = listAlerts(db, { status: 'open' }).length;
  return { label: 'No unacknowledged alerts', ok: open === 0, detail: `${open} open` };
}
```

Wire all five into the existing `runDoctor` aggregator.

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @vina/cli test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/doctor.ts packages/cli/tests/doctor.test.ts
git commit -m "feat(cli): vina doctor — chromium, profile, LLM, schedule, alerts checks"
```

---

## Phase 10 — End-to-End Integration Test

### Task 25: Full search → score → status flip e2e (against fixture)

**Files:**
- Create: `packages/server/tests/integration/linkedin-e2e.test.ts`

**Test seam approach:** Task 10's search handler accepts `feedUrlOverride` via `SearchHandlerDeps`. The integration test bypasses `bootServer`'s default wiring by calling the handler directly through a test-only worker bootstrap (or by extending `bootServer` to accept overrides — only do that if needed). The simplest path: run the handler directly inside the test rather than going through HTTP, since the goal is to verify the full pipeline state transitions, not the HTTP flow.

- [ ] **Step 1: Implement the test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { Database as DatabaseType } from 'better-sqlite3';
import { createBrowserManager, linkedInAdapter } from '@vina/automation';
import { startLinkedInFixture } from '../../../../tests/fixtures/sites/linkedin/server.js';
import type { FixtureServerHandle } from '../../../../tests/fixtures/start-server.js';
import { freshTestDb } from '../db/helpers.js';
import { createEventBus } from '../../src/events/bus.js';
import { createSearchHandler } from '../../src/queue/handlers/search.js';
import { createScoreHandler } from '../../src/queue/handlers/score.js';
import { listJobs, updateJobStatus, findJobById } from '../../src/db/repositories/jobs.js';
import { listPending } from '../../src/db/repositories/task-queue.js';
import { upsertProfile } from '../../src/db/repositories/profile.js';
import { insertCv } from '../../src/db/repositories/cvs.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

describe('LinkedIn slice end-to-end', () => {
  let fixture: FixtureServerHandle;
  let db: DatabaseType;
  let dataDir: string;

  beforeEach(async () => {
    fixture = await startLinkedInFixture();
    db = freshTestDb();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-e2e-'));
    upsertProfile(db, { full_name: 'Pat', email: 'p@x.com' });
    insertCv(db, {
      label: 'main',
      original_filename: 'cv.pdf',
      mime_type: 'application/pdf',
      file_path: '/tmp/cv.pdf',
      extracted_text: 'TS, Postgres, AWS',
      is_default: true,
    });
  });
  afterEach(async () => {
    db.close();
    await fixture.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('search → score → applied flow', async () => {
    const bus = createEventBus();
    const browserManager = createBrowserManager({ dataDir });
    const search = createSearchHandler({
      db, bus, browserManager,
      adapters: { linkedin: linkedInAdapter },
      feedUrlOverride: `${fixture.url}/feed`,
    });

    await search({ site_id: 'linkedin' });

    const jobs = listJobs(db, { site_id: 'linkedin' });
    expect(jobs.length).toBeGreaterThan(0);

    // Run score handler with a fake model for each enqueued score task.
    const fakeModel = {
      withStructuredOutput: () => ({
        invoke: async () => ({ score: 85, justification: 'Good match.' }),
      }),
    } as unknown as BaseChatModel;
    const score = createScoreHandler({
      db, bus, buildModel: async () => fakeModel,
    });

    for (const t of listPending(db).filter((p) => p.kind === 'score')) {
      await score(JSON.parse(t.payload) as { job_id: string });
    }

    const scoredJobs = listJobs(db, { status: 'scored' });
    expect(scoredJobs.length).toBe(jobs.length);
    expect(scoredJobs[0]!.match_score).toBe(85);

    // Flip one to applied_manually (simulates the /applied endpoint).
    updateJobStatus(db, scoredJobs[0]!.id, 'applied_manually');
    expect(findJobById(db, scoredJobs[0]!.id)?.status).toBe('applied_manually');

    await browserManager.closeAll();
  }, 90_000);
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @vina/server test -- linkedin-e2e`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/tests/integration/linkedin-e2e.test.ts
git commit -m "test(server): end-to-end LinkedIn slice integration test"
```

---

## Phase 11 — Final Verification

### Task 26: Run the full test + lint + build matrix and update specs

**Files:**
- Modify: `docs/superpowers/specs/2026-05-04-linkedin-end-to-end-slice-design.md` (flip status to "implemented")

- [ ] **Step 1: Run everything**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: PASS across all packages.

- [ ] **Step 2: Update spec status**

In `docs/superpowers/specs/2026-05-04-linkedin-end-to-end-slice-design.md` line 3, change:

```
**Status:** Brainstorm-approved · awaiting plan
```

to:

```
**Status:** Implemented (2026-05-09)
```

- [ ] **Step 3: Manual verification (golden path)**

In a clean fresh data dir:
1. `vina start` — daemon comes up.
2. Open the web UI — wizard shows, Welcome page.
3. Profile → CV upload → LLM provider → Preferences → Schedule → Connect LinkedIn.
4. Connect LinkedIn launches headed Chromium; log in; auto-advances after success.
5. Done page → Dashboard.
6. Click Jobs in sidebar — empty.
7. Click Search now — Search task runs; listings populate after a few seconds; scores attach.
8. Click Apply on LinkedIn → opens new tab to LinkedIn detail.
9. Click Mark applied → row moves to Applied tab; toast offers Undo.
10. Click Skip on another → moves to Skipped tab.
11. Click Reopen on a skipped row → moves back to New.
12. Settings → Sites tile shows LinkedIn ● Connected. Click Disconnect → flips to ○ Not connected.

If any step fails, fix the underlying bug (do not move on with a known regression).

- [ ] **Step 4: Final commit**

```bash
git add docs/superpowers/specs/2026-05-04-linkedin-end-to-end-slice-design.md
git commit -m "docs: mark LinkedIn end-to-end slice spec as implemented"
```

---

## Appendix A — Migration Notes

- `001_init.sql` already exists; the runner (`packages/server/src/db/migrate.ts`) is forward-only and lex-sorted, so `002_…` lands cleanly.
- The `alerts` rebuild is a forward-only operation; the migration runs inside a transaction so a partial failure rolls back.
- The `idx_alerts_status` index is recreated at the end of the migration since it dies with the dropped table.

## Appendix B — Mapping Spec § to Tasks

| Spec § | Tasks |
|---|---|
| §1.1, §1.2 (goal & ships) | All tasks |
| §2 (architecture) | 7, 8, 10, 11 |
| §3 (onboarding & login) | 8, 9, 15, 16, 17 |
| §3.4 (Settings → Sites tile) | 21 |
| §3.5 (alert → reconnect) | 22b, 22c |
| §4 (search & score pipeline) | 5, 6, 10, 11, 13b |
| §4.3 (error paths — score retry exhausted → score_failed alert) | 13b |
| §4.6 (schema) | 1 |
| §5 (Jobs page UX) | 12, 13, 14, 18, 19, 20 |
| §6.1 (WS events; `alerts:new` mapped to existing `alert:created`) | 3, 20, 22c |
| §6.2 (alert kinds) | 2; emission in 10 (linkedin_session_expired, search_failed, schedule_paused), 13b (score_failed) |
| §6.4 (CLI) | 23, 24 |
| §7 (open resolutions) | 5, 6 (CV wiring); 1 (migration); 20, 22c (WS client extension) |
| §9 (Q&A) | Q1→16, Q2→14, Q3→19, Q4→21, Q5→19+22, Q6→16, Q7→10+11, Q8→3+20 |

**Note on `alerts:new`:** The spec uses the shorthand `alerts:new` in §6.1, but the existing event taxonomy already publishes `alert:created` via `EVENTS.ALERT_CREATED`. We reuse the existing event (its payload already carries the full alert) rather than introduce a redundant alias.

**Note on `provider_failed`:** The spec lists this alert kind in §6.2 but provides no precise emission trigger ("LLM provider repeatedly errored across multiple score tasks"). We add the enum value (Task 2) but defer emission logic — implementing the cross-task heuristic is out of scope for this slice and would land alongside richer LLM-provider observability later.

## Appendix C — What Stays Hidden / Unchanged

- `cv-service.ts`, `cover-letter-service.ts` — code untouched, not invoked by this slice.
- Wizard `Sources.tsx`, `Mode.tsx`, `CoverLetter.tsx` — files untouched, just unrouted in `index.tsx`.
- `/chat` route — registered, unlinked from sidebar.
- `/ready` route — replaced with redirect to `/jobs`.
- Form-walker, M14 tailoring, M15 auto-apply — untouched.

---

**Plan complete.**
