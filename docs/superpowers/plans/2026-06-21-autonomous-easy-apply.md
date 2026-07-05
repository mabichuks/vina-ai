# Autonomous Easy Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Easy Apply into a real autonomous flow with safety gates (daily cap, velocity throttle, freshness, idempotency, circuit breaker), an explicit `autonomous | manual` mode toggle with risk disclosure, a "never guess" form-fill rule with EEO hard-skip, a Settings UI for reviewing saved screening answers, a JobCard "Auto-apply" button, a Dashboard daily-summary and kill switch, and supporting cleanup work — without inventing a parallel "memory.md" store (the existing `profile_answers` table already plays that role).

**Architecture:** Collapse the existing `mode` × `approval` settings into one `easy_apply_mode` setting. Every path to `runApply` (autonomous queue enqueue, JobCard click) routes through a single gate function that consults persistent rate-limit state (daily count, last-submitted time, consecutive-failure count). The form-fill rule is tightened in `browser-apply/SKILL.md` and enforced in the existing `decideUnresolvedField` + field-resolver loop; we extend the resolver (not replace it) with an EEO/demographic short-circuit. UI changes: two new Settings tiles (Easy Apply, Answers), a JobCard button, a Dashboard summary card, a kill switch. Periodic cleanup task drains stale `task_queue` and resolved alerts.

**Tech Stack:** TypeScript, Node 20+, pnpm workspaces, Fastify, better-sqlite3 (with forward-only SQL migrations), Playwright via managed CDP, LangGraph + LangChain, React 18 + Vite + Tailwind + shadcn/ui + TanStack Query + Zustand, zod, Vitest, Playwright Test.

---

## Phase guide

This plan ships in 11 phases. Each phase is independently committable and produces working software. Tasks within a phase follow TDD. Commit messages are single-line Conventional Commits scoped by package (per `CLAUDE.md`).

| Phase | Scope | Ships |
|---|---|---|
| 1 | Schema + settings collapse | Migration 007, updated shared types, settings repo + route |
| 2 | Apply rate-limit state | New repository tracking daily count / last submission / consecutive failures |
| 3 | Easy Apply gate function | Single gate consulted by every apply path |
| 4 | Apply handler integration | Gate enforcement, rate-limit updates, circuit breaker auto-flip |
| 5 | Skill tightening + EEO + audit | `browser-apply/SKILL.md` rule tightening, EEO short-circuit, per-field source audit |
| 6 | Profile-answers HTTP + UI | List/delete/clear endpoints + Settings AnswersTile |
| 7 | Easy Apply Settings UI | EasyApplyTile + risk disclosure modal |
| 8 | Autonomous + manual entry points | `score` handler autonomy branch, `POST /api/jobs/:id/apply` route, JobCard button |
| 9 | Dashboard summary + kill switch | Daily summary endpoint + Dashboard card + Pause button |
| 10 | Cleanup tasks | `task_queue` periodic prune + alert dismiss/clear-all |
| 11 | Docs | SPEC.md section, ADR-023, build-order note |

---

## Phase 1 — Schema + settings collapse

**Why first:** every other phase reads or writes the new settings/limit fields. Land the schema and TypeScript types so later phases compile cleanly.

### Task 1.1 — Write migration 007

**Files:**
- Create: `packages/server/migrations/007_easy_apply_modes_and_limits.sql`

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/migrations/007.test.ts`:

```typescript
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';

describe('migration 007', () => {
  it('adds easy_apply_mode and limit columns to settings', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('easy_apply_mode');
    expect(names).toContain('autonomous_apply_dry_run');
    expect(names).toContain('apply_daily_cap');
    expect(names).toContain('apply_min_interval_seconds');
    expect(names).toContain('apply_listing_max_age_days');
    expect(names).toContain('apply_consecutive_failure_limit');
    expect(names).not.toContain('mode');
    expect(names).not.toContain('approval');
  });

  it('seeds defaults for new settings columns', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const row = db.prepare(`SELECT * FROM settings WHERE id = 'app'`).get() as Record<string, unknown>;
    expect(row.easy_apply_mode).toBe('manual');
    expect(row.autonomous_apply_dry_run).toBe(0);
    expect(row.apply_daily_cap).toBe(10);
    expect(row.apply_min_interval_seconds).toBe(300);
    expect(row.apply_listing_max_age_days).toBe(14);
    expect(row.apply_consecutive_failure_limit).toBe(5);
  });

  it('creates apply_rate_limit row keyed app', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const row = db.prepare(`SELECT * FROM apply_rate_limit WHERE id = 'app'`).get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.successful_today).toBe(0);
    expect(row?.consecutive_failures).toBe(0);
    expect(row?.last_attempt_at).toBeNull();
    expect(row?.last_success_at).toBeNull();
    expect(row?.day_bucket).toBeTypeOf('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @vina/server test migrations/007`
Expected: FAIL — migration file does not exist.

- [ ] **Step 3: Write the migration**

Create `packages/server/migrations/007_easy_apply_modes_and_limits.sql`:

```sql
-- Collapse `mode` × `approval` into a single `easy_apply_mode` setting.
-- Add gate-config columns + a persistent rate-limit row.
-- No production users yet; we drop the old columns outright instead of
-- migrating values.

ALTER TABLE settings DROP COLUMN mode;
ALTER TABLE settings DROP COLUMN approval;

ALTER TABLE settings
  ADD COLUMN easy_apply_mode TEXT NOT NULL DEFAULT 'manual'
  CHECK (easy_apply_mode IN ('autonomous', 'manual'));

ALTER TABLE settings
  ADD COLUMN autonomous_apply_dry_run INTEGER NOT NULL DEFAULT 0
  CHECK (autonomous_apply_dry_run IN (0, 1));

ALTER TABLE settings
  ADD COLUMN apply_daily_cap INTEGER NOT NULL DEFAULT 10
  CHECK (apply_daily_cap >= 1 AND apply_daily_cap <= 100);

ALTER TABLE settings
  ADD COLUMN apply_min_interval_seconds INTEGER NOT NULL DEFAULT 300
  CHECK (apply_min_interval_seconds >= 0 AND apply_min_interval_seconds <= 3600);

ALTER TABLE settings
  ADD COLUMN apply_listing_max_age_days INTEGER NOT NULL DEFAULT 14
  CHECK (apply_listing_max_age_days >= 1 AND apply_listing_max_age_days <= 365);

ALTER TABLE settings
  ADD COLUMN apply_consecutive_failure_limit INTEGER NOT NULL DEFAULT 5
  CHECK (apply_consecutive_failure_limit >= 1 AND apply_consecutive_failure_limit <= 50);

-- Single-row table mirroring `settings(id='app')`. Tracks runtime state the
-- gate function reads on every apply: today's successful submissions,
-- last attempt + success timestamps (for throttle), consecutive failures
-- (for circuit breaker). `day_bucket` is the YYYY-MM-DD of the local-time
-- day the count belongs to — when a new attempt's day differs, the count
-- rolls.
CREATE TABLE apply_rate_limit (
  id TEXT PRIMARY KEY CHECK (id = 'app'),
  successful_today INTEGER NOT NULL DEFAULT 0 CHECK (successful_today >= 0),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_attempt_at TEXT,
  last_success_at TEXT,
  day_bucket TEXT NOT NULL
);

INSERT INTO apply_rate_limit (id, day_bucket)
VALUES ('app', strftime('%Y-%m-%d', 'now', 'localtime'));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @vina/server test migrations/007`
Expected: PASS — all three test cases.

- [ ] **Step 5: Commit**

```bash
git add packages/server/migrations/007_easy_apply_modes_and_limits.sql packages/server/tests/migrations/007.test.ts
git commit -m "feat(server): migration 007 — easy_apply_mode + apply gate limits"
```

### Task 1.2 — Update shared Settings schema

**Files:**
- Modify: `packages/shared/src/schemas/settings.ts`
- Modify: `packages/shared/src/enums.ts`
- Modify: `packages/shared/tests/schemas.test.ts`

- [ ] **Step 1: Update tests for the new shape**

Find the `SettingsSchema` test in `packages/shared/tests/schemas.test.ts`. Add a new test block at the end of the file:

```typescript
describe('SettingsSchema (autonomous easy apply)', () => {
  it('accepts easy_apply_mode and limit fields', () => {
    const result = SettingsSchema.parse({
      id: 'app',
      easy_apply_mode: 'manual',
      autonomous_apply_dry_run: false,
      apply_daily_cap: 10,
      apply_min_interval_seconds: 300,
      apply_listing_max_age_days: 14,
      apply_consecutive_failure_limit: 5,
      browser_headful: false,
      browser_stealth: false,
      paused: false,
      active_llm_provider_id: null,
      has_serpapi_key: false,
      updated_at: '2026-06-21T00:00:00.000Z',
    });
    expect(result.easy_apply_mode).toBe('manual');
  });

  it('rejects easy_apply_mode outside enum', () => {
    expect(() =>
      SettingsSchema.parse({
        id: 'app',
        easy_apply_mode: 'autopilot',
        autonomous_apply_dry_run: false,
        apply_daily_cap: 10,
        apply_min_interval_seconds: 300,
        apply_listing_max_age_days: 14,
        apply_consecutive_failure_limit: 5,
        browser_headful: false,
        browser_stealth: false,
        paused: false,
        active_llm_provider_id: null,
        has_serpapi_key: false,
        updated_at: '2026-06-21T00:00:00.000Z',
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @vina/shared test schemas`
Expected: FAIL — `easy_apply_mode` is not in the schema, and `mode` / `approval` are required.

- [ ] **Step 3: Update enums.ts**

In `packages/shared/src/enums.ts`, **remove** the `OPERATING_MODES` and `APPROVAL_SETTINGS` exports if they exist (they are no longer referenced after this change). Add:

```typescript
export const EASY_APPLY_MODES = ['autonomous', 'manual'] as const;
export type EasyApplyMode = (typeof EASY_APPLY_MODES)[number];
```

- [ ] **Step 4: Rewrite settings schema**

Replace the contents of `packages/shared/src/schemas/settings.ts`:

```typescript
import { z } from 'zod';
import { EASY_APPLY_MODES } from '../enums.js';

const isoDate = z.iso.datetime();

export const SettingsSchema = z.object({
  id: z.literal('app'),
  easy_apply_mode: z.enum(EASY_APPLY_MODES),
  autonomous_apply_dry_run: z.boolean(),
  apply_daily_cap: z.number().int().min(1).max(100),
  apply_min_interval_seconds: z.number().int().min(0).max(3600),
  apply_listing_max_age_days: z.number().int().min(1).max(365),
  apply_consecutive_failure_limit: z.number().int().min(1).max(50),
  browser_headful: z.boolean(),
  browser_stealth: z.boolean(),
  paused: z.boolean(),
  active_llm_provider_id: z.string().nullable(),
  has_serpapi_key: z.boolean(),
  updated_at: isoDate,
});
export type Settings = z.infer<typeof SettingsSchema>;

export const SettingsUpdateSchema = z.object({
  easy_apply_mode: z.enum(EASY_APPLY_MODES).optional(),
  autonomous_apply_dry_run: z.boolean().optional(),
  apply_daily_cap: z.number().int().min(1).max(100).optional(),
  apply_min_interval_seconds: z.number().int().min(0).max(3600).optional(),
  apply_listing_max_age_days: z.number().int().min(1).max(365).optional(),
  apply_consecutive_failure_limit: z.number().int().min(1).max(50).optional(),
  browser_headful: z.boolean().optional(),
  browser_stealth: z.boolean().optional(),
  paused: z.boolean().optional(),
  active_llm_provider_id: z.string().nullable().optional(),
  serpapi_key: z.string().min(1).nullable().optional(),
});
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;
```

- [ ] **Step 5: Run shared tests**

Run: `pnpm --filter @vina/shared test`
Expected: PASS — both new tests plus the existing settings tests (now updated).

- [ ] **Step 6: Run repo-wide typecheck**

Run: `pnpm -r typecheck`
Expected: Errors in `packages/server` referencing `settings.mode` / `settings.approval` and possibly in `packages/web`. These are addressed by Task 1.3.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/schemas/settings.ts packages/shared/src/enums.ts packages/shared/tests/schemas.test.ts
git commit -m "feat(shared): collapse mode/approval into easy_apply_mode + gate limit fields"
```

### Task 1.3 — Update settings repository and route to read/write new columns

**Files:**
- Modify: `packages/server/src/db/repositories/settings.ts`
- Modify: `packages/server/src/http/routes/settings.ts`
- Modify: any caller that read `settings.mode` or `settings.approval` (see Step 1)

- [ ] **Step 1: Find all callers of the old fields**

Run: `grep -rn "settings.mode\|settings.approval\|\.mode === 'autonomous'\|\.mode === 'supervised'" packages/server/src --include="*.ts"`

Expected: a list of files including `packages/server/src/queue/handlers/score.ts`. Note them — each needs updating below (the score handler change is part of Phase 8, but here we just need things to compile; replace `settings.mode === 'autonomous'` with `settings.easy_apply_mode === 'autonomous'` at every call site temporarily, even if the surrounding logic will change in Phase 8).

- [ ] **Step 2: Write a failing test for `getOrInitSettings`**

Add to `packages/server/tests/db/settings.test.ts` (create if it doesn't exist):

```typescript
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { getOrInitSettings, updateSettings } from '../../src/db/repositories/settings.js';

describe('settings repository (autonomous easy apply)', () => {
  function freshDb() {
    const db = new Database(':memory:');
    runMigrations(db);
    return db;
  }

  it('returns defaults for new fields', () => {
    const db = freshDb();
    const s = getOrInitSettings(db);
    expect(s.easy_apply_mode).toBe('manual');
    expect(s.autonomous_apply_dry_run).toBe(false);
    expect(s.apply_daily_cap).toBe(10);
    expect(s.apply_min_interval_seconds).toBe(300);
    expect(s.apply_listing_max_age_days).toBe(14);
    expect(s.apply_consecutive_failure_limit).toBe(5);
  });

  it('round-trips easy_apply_mode + dry-run + cap updates', () => {
    const db = freshDb();
    updateSettings(db, {
      easy_apply_mode: 'autonomous',
      autonomous_apply_dry_run: true,
      apply_daily_cap: 25,
    });
    const s = getOrInitSettings(db);
    expect(s.easy_apply_mode).toBe('autonomous');
    expect(s.autonomous_apply_dry_run).toBe(true);
    expect(s.apply_daily_cap).toBe(25);
  });
});
```

- [ ] **Step 3: Run it — verify it fails to compile or asserts wrong**

Run: `pnpm --filter @vina/server test db/settings`
Expected: FAIL — repository still returns `mode` / `approval`, missing the new fields.

- [ ] **Step 4: Update the settings repository**

Open `packages/server/src/db/repositories/settings.ts`. Update the SELECT query in `getOrInitSettings` to read the new columns, the INSERT defaults to include them, and `updateSettings` to accept and persist them. Translate boolean columns through `0|1` ↔ `boolean` as the existing code does for `browser_headful`. Mirror the new fields throughout — drop `mode` and `approval` everywhere they appear.

(If the file is short, paste the full replacement; if not, edit the SELECT projection, the INSERT VALUES list, the UPDATE SET clause, and the type-mapping helpers. Search "mode" / "approval" within the file and replace.)

- [ ] **Step 5: Update temporary callers**

For each file from Step 1, replace `settings.mode === 'autonomous'` with `settings.easy_apply_mode === 'autonomous'` and remove any read of `settings.approval`. Specifically in `packages/server/src/queue/handlers/score.ts:108-113`, change the autonomy condition to check `settings.easy_apply_mode === 'autonomous'`. (The branch for `apply_method === 'manual'` keeps its existing behaviour; the `apply_method === 'auto'` branch is added in Phase 8.)

- [ ] **Step 6: Update settings HTTP route**

In `packages/server/src/http/routes/settings.ts`, ensure `SettingsUpdateSchema` is what the PATCH route validates against (it already imports from `@vina/shared`). No structural change should be needed — the route just delegates to the repository.

- [ ] **Step 7: Run all server tests**

Run: `pnpm --filter @vina/server test`
Expected: PASS. Existing settings tests should still pass (they validated `paused` etc); the new test passes; the score-handler test should still pass with the `easy_apply_mode` substitution.

- [ ] **Step 8: Run repo-wide typecheck**

Run: `pnpm -r typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/db/repositories/settings.ts packages/server/src/http/routes/settings.ts packages/server/src/queue/handlers/score.ts packages/server/tests/db/settings.test.ts
git commit -m "feat(server): settings repo reads easy_apply_mode + gate limits"
```

### Task 1.4 — Update web settings types fall-through

**Files:**
- Modify: any web file that previously imported `OPERATING_MODES` or `APPROVAL_SETTINGS` from `@vina/shared`

- [ ] **Step 1: Find web callers**

Run: `grep -rn "OPERATING_MODES\|APPROVAL_SETTINGS\|settings.mode\|settings.approval" packages/web/src`

Expected: a list of UI files (likely `SettingsPage.tsx`). Note them.

- [ ] **Step 2: Replace stale field references with placeholders**

For each file from Step 1, replace `settings.mode` reads with `settings.easy_apply_mode` and remove `settings.approval` usage. If a setting form had `mode`/`approval` inputs, **delete those inputs from the JSX** — they will be replaced by the EasyApplyTile in Phase 7. Leave a placeholder comment `// TODO(phase-7): wire EasyApplyTile` where the controls used to live.

- [ ] **Step 3: Run typecheck**

Run: `pnpm -r typecheck`
Expected: clean.

- [ ] **Step 4: Run web tests**

Run: `pnpm --filter @vina/web test`
Expected: PASS (none of the tests should depend on `mode`/`approval` controls directly; if any do, update them to read `easy_apply_mode`).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src
git commit -m "chore(web): drop legacy mode/approval references ahead of EasyApplyTile"
```

---

## Phase 2 — Apply rate-limit state

**Why next:** the gate function in Phase 3 reads this state; updating it on success/failure is wired into the handler in Phase 4.

### Task 2.1 — Apply rate-limit repository

**Files:**
- Create: `packages/server/src/db/repositories/apply-rate-limit.ts`
- Create: `packages/server/tests/db/apply-rate-limit.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/server/tests/db/apply-rate-limit.test.ts`:

```typescript
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import {
  getRateLimit,
  recordAttempt,
  recordSuccess,
  recordFailure,
  resetConsecutiveFailures,
} from '../../src/db/repositories/apply-rate-limit.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('apply-rate-limit repository', () => {
  it('starts at zeros with today\'s day_bucket', () => {
    const db = freshDb();
    const rl = getRateLimit(db);
    expect(rl.successful_today).toBe(0);
    expect(rl.consecutive_failures).toBe(0);
    expect(rl.last_attempt_at).toBeNull();
    expect(rl.last_success_at).toBeNull();
    expect(rl.day_bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('recordAttempt updates last_attempt_at and rolls the day when needed', () => {
    const db = freshDb();
    db.prepare(`UPDATE apply_rate_limit SET day_bucket = '1999-01-01', successful_today = 7`).run();
    recordAttempt(db, '2026-06-21T10:00:00.000Z', '2026-06-21');
    const rl = getRateLimit(db);
    expect(rl.day_bucket).toBe('2026-06-21');
    expect(rl.successful_today).toBe(0); // rolled
    expect(rl.last_attempt_at).toBe('2026-06-21T10:00:00.000Z');
  });

  it('recordSuccess increments successful_today and resets consecutive_failures', () => {
    const db = freshDb();
    db.prepare(`UPDATE apply_rate_limit SET consecutive_failures = 3`).run();
    recordSuccess(db, '2026-06-21T10:01:00.000Z', '2026-06-21');
    const rl = getRateLimit(db);
    expect(rl.successful_today).toBe(1);
    expect(rl.consecutive_failures).toBe(0);
    expect(rl.last_success_at).toBe('2026-06-21T10:01:00.000Z');
  });

  it('recordFailure increments consecutive_failures', () => {
    const db = freshDb();
    recordFailure(db);
    recordFailure(db);
    const rl = getRateLimit(db);
    expect(rl.consecutive_failures).toBe(2);
  });

  it('resetConsecutiveFailures zeroes the counter', () => {
    const db = freshDb();
    recordFailure(db);
    recordFailure(db);
    resetConsecutiveFailures(db);
    expect(getRateLimit(db).consecutive_failures).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm --filter @vina/server test apply-rate-limit`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the repository**

`packages/server/src/db/repositories/apply-rate-limit.ts`:

```typescript
import type { Database as DatabaseType } from 'better-sqlite3';

export interface ApplyRateLimit {
  id: 'app';
  successful_today: number;
  consecutive_failures: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  day_bucket: string;
}

export function getRateLimit(db: DatabaseType): ApplyRateLimit {
  const row = db
    .prepare(`SELECT * FROM apply_rate_limit WHERE id = 'app'`)
    .get() as ApplyRateLimit | undefined;
  if (!row) throw new Error('apply_rate_limit row missing — migration not applied');
  return row;
}

/**
 * Stamp an attempt. If `day_bucket` differs from `today`, the daily success
 * count rolls to zero before the timestamp is set — keeps the count in sync
 * with the configured "day" regardless of polling cadence.
 */
export function recordAttempt(
  db: DatabaseType,
  nowIso: string,
  today: string,
): void {
  db.prepare(`
    UPDATE apply_rate_limit
       SET successful_today = CASE WHEN day_bucket = ? THEN successful_today ELSE 0 END,
           day_bucket       = ?,
           last_attempt_at  = ?
     WHERE id = 'app'
  `).run(today, today, nowIso);
}

export function recordSuccess(
  db: DatabaseType,
  nowIso: string,
  today: string,
): void {
  db.prepare(`
    UPDATE apply_rate_limit
       SET successful_today      = CASE WHEN day_bucket = ? THEN successful_today + 1 ELSE 1 END,
           day_bucket            = ?,
           consecutive_failures  = 0,
           last_attempt_at       = ?,
           last_success_at       = ?
     WHERE id = 'app'
  `).run(today, today, nowIso, nowIso);
}

export function recordFailure(db: DatabaseType): void {
  db.prepare(`
    UPDATE apply_rate_limit
       SET consecutive_failures = consecutive_failures + 1
     WHERE id = 'app'
  `).run();
}

export function resetConsecutiveFailures(db: DatabaseType): void {
  db.prepare(`UPDATE apply_rate_limit SET consecutive_failures = 0 WHERE id = 'app'`).run();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @vina/server test apply-rate-limit`
Expected: PASS — all five test cases.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/repositories/apply-rate-limit.ts packages/server/tests/db/apply-rate-limit.test.ts
git commit -m "feat(server): apply_rate_limit repository for daily cap + circuit breaker state"
```

---

## Phase 3 — Easy Apply gate function

**Why next:** the single point of truth for "should this apply run." Called by the apply handler (Phase 4) and the manual route + autonomous hook (Phase 8).

### Task 3.1 — Gate function

**Files:**
- Create: `packages/server/src/services/easy-apply-gate.ts`
- Create: `packages/server/tests/services/easy-apply-gate.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/server/tests/services/easy-apply-gate.test.ts`:

```typescript
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { checkEasyApplyGate } from '../../src/services/easy-apply-gate.js';
import { insertJob } from '../../src/db/repositories/jobs.js';
import { updateSettings } from '../../src/db/repositories/settings.js';
import { newId } from '@vina/shared';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function makeJob(db: Database.Database, opts: { posted_at?: string | null; score?: number | null; method?: 'auto' | 'manual' } = {}) {
  return insertJob(db, {
    id: newId(),
    site_id: 'linkedin',
    external_id: newId(),
    url: 'https://example.test/job',
    title: 'Engineer',
    company: 'Acme',
    location: 'Remote',
    description: 'desc',
    posted_at: opts.posted_at ?? '2026-06-20T00:00:00.000Z',
    apply_method: opts.method ?? 'auto',
    external_apply_url: null,
    original_source: null,
    salary_text: null,
    match_score: opts.score ?? 80,
    score_justification: null,
    status: 'scored',
  });
}

describe('checkEasyApplyGate', () => {
  let db: Database.Database;
  const NOW = '2026-06-21T12:00:00.000Z';
  const TODAY = '2026-06-21';

  beforeEach(() => {
    db = freshDb();
  });

  it('allow when all gates pass', () => {
    const job = makeJob(db);
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('allow');
  });

  it('blocks when score below threshold', () => {
    // search_preferences threshold defaults; set a known one
    db.prepare(`UPDATE search_preferences SET score_threshold = 90`).run();
    const job = makeJob(db, { score: 50 });
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('block');
    expect(r.reason).toBe('below_threshold');
  });

  it('blocks when posted_at is older than the configured age cap', () => {
    updateSettings(db, { apply_listing_max_age_days: 7 });
    const job = makeJob(db, { posted_at: '2026-06-01T00:00:00.000Z' });
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('block');
    expect(r.reason).toBe('listing_stale');
  });

  it('blocks when daily cap already met', () => {
    updateSettings(db, { apply_daily_cap: 3 });
    db.prepare(`UPDATE apply_rate_limit SET successful_today = 3, day_bucket = ?`).run(TODAY);
    const job = makeJob(db);
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('block');
    expect(r.reason).toBe('daily_cap_reached');
  });

  it('blocks on velocity throttle when last_attempt is recent', () => {
    updateSettings(db, { apply_min_interval_seconds: 600 });
    db.prepare(`UPDATE apply_rate_limit SET last_attempt_at = ?, day_bucket = ?`).run(
      '2026-06-21T11:55:00.000Z',
      TODAY,
    );
    const job = makeJob(db);
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('block');
    expect(r.reason).toBe('velocity_throttle');
  });

  it('blocks when consecutive failure limit hit (circuit breaker)', () => {
    updateSettings(db, { apply_consecutive_failure_limit: 5 });
    db.prepare(`UPDATE apply_rate_limit SET consecutive_failures = 5`).run();
    const job = makeJob(db);
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('block');
    expect(r.reason).toBe('circuit_breaker_tripped');
  });

  it('blocks when an active apply task already exists for the job (idempotency)', () => {
    const job = makeJob(db);
    db.prepare(`
      INSERT INTO task_queue (id, kind, payload, status, attempts, max_attempts, priority, created_at, updated_at)
      VALUES (?, 'apply', ?, 'pending', 0, 3, 5, ?, ?)
    `).run(newId(), JSON.stringify({ job_id: job.id }), NOW, NOW);
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('block');
    expect(r.reason).toBe('apply_task_in_flight');
  });

  it('returns dry_run when dry-run setting is true (but still allow)', () => {
    updateSettings(db, { autonomous_apply_dry_run: true });
    const job = makeJob(db);
    const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
    expect(r.decision).toBe('dry_run');
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm --filter @vina/server test easy-apply-gate`
Expected: FAIL — `checkEasyApplyGate` does not exist.

- [ ] **Step 3: Implement the gate**

`packages/server/src/services/easy-apply-gate.ts`:

```typescript
import type { Database as DatabaseType } from 'better-sqlite3';
import { findJobById } from '../db/repositories/jobs.js';
import { getOrInitSettings } from '../db/repositories/settings.js';
import { getOrInitSearchPreferences } from '../db/repositories/search-preferences.js';
import { getRateLimit } from '../db/repositories/apply-rate-limit.js';

export type GateBlockReason =
  | 'below_threshold'
  | 'listing_stale'
  | 'daily_cap_reached'
  | 'velocity_throttle'
  | 'circuit_breaker_tripped'
  | 'apply_task_in_flight'
  | 'job_not_found'
  | 'wrong_apply_method';

export type GateDecision =
  | { decision: 'allow' }
  | { decision: 'dry_run' }
  | { decision: 'block'; reason: GateBlockReason; detail?: string };

export interface GateInput {
  jobId: string;
  nowIso: string;
  /** YYYY-MM-DD in the local-time day used for rate-limit bucketing. */
  today: string;
}

/**
 * Single gate function consulted by every path to `runApply`:
 *   - score handler autonomous branch (Phase 8)
 *   - POST /api/jobs/:id/apply (Phase 8)
 *   - apply handler at task pickup (Phase 4)
 *
 * Pure decision — does not mutate state. The handler is responsible for
 * recording attempts / outcomes via the apply-rate-limit repository.
 */
export function checkEasyApplyGate(db: DatabaseType, input: GateInput): GateDecision {
  const job = findJobById(db, input.jobId);
  if (!job) return { decision: 'block', reason: 'job_not_found' };
  if (job.apply_method !== 'auto') {
    return { decision: 'block', reason: 'wrong_apply_method' };
  }

  const prefs = getOrInitSearchPreferences(db);
  if ((job.match_score ?? 0) < prefs.score_threshold) {
    return { decision: 'block', reason: 'below_threshold' };
  }

  const settings = getOrInitSettings(db);

  if (job.posted_at) {
    const posted = Date.parse(job.posted_at);
    const now = Date.parse(input.nowIso);
    const ageDays = (now - posted) / (1000 * 60 * 60 * 24);
    if (ageDays > settings.apply_listing_max_age_days) {
      return { decision: 'block', reason: 'listing_stale' };
    }
  }

  // Idempotency: refuse if an apply task for this job is already pending or running.
  // Failed tasks may be retried via the existing alert-resolve flow.
  const inFlight = db
    .prepare(`
      SELECT id FROM task_queue
       WHERE kind = 'apply'
         AND status IN ('pending', 'running')
         AND json_extract(payload, '$.job_id') = ?
       LIMIT 1
    `)
    .get(input.jobId);
  if (inFlight) return { decision: 'block', reason: 'apply_task_in_flight' };

  const rl = getRateLimit(db);
  if (rl.consecutive_failures >= settings.apply_consecutive_failure_limit) {
    return { decision: 'block', reason: 'circuit_breaker_tripped' };
  }

  if (rl.day_bucket === input.today && rl.successful_today >= settings.apply_daily_cap) {
    return { decision: 'block', reason: 'daily_cap_reached' };
  }

  if (rl.last_attempt_at && settings.apply_min_interval_seconds > 0) {
    const sinceLast = (Date.parse(input.nowIso) - Date.parse(rl.last_attempt_at)) / 1000;
    if (sinceLast < settings.apply_min_interval_seconds) {
      return { decision: 'block', reason: 'velocity_throttle' };
    }
  }

  return settings.autonomous_apply_dry_run ? { decision: 'dry_run' } : { decision: 'allow' };
}

/** Render a stable day bucket from an ISO timestamp using the host's local TZ. */
export function dayBucketFromIso(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
```

- [ ] **Step 4: Check whether job.payload uses job_id in apply tasks**

Run: `grep -rn "kind.*apply\|task_queue" packages/server/src --include="*.ts" | grep -i "payload\|enqueue"` and look at any apply-task payloads. If they use `application_id` instead of `job_id`, change the idempotency query to JOIN through `applications`:

```typescript
const inFlight = db.prepare(`
  SELECT t.id FROM task_queue t
   JOIN applications a ON a.id = json_extract(t.payload, '$.application_id')
   WHERE t.kind = 'apply'
     AND t.status IN ('pending', 'running')
     AND a.job_id = ?
   LIMIT 1
`).get(input.jobId);
```

(Confirm whichever is correct against the actual handler payload in `packages/server/src/queue/handlers/apply.ts:42` — it uses `application_id`. So use the JOIN form. Update the test fixture in Step 1 accordingly: instead of inserting a `task_queue` row with `job_id`, insert an applications row and a `task_queue` row with that application's id.)

- [ ] **Step 5: Adjust test for the JOIN-based idempotency check**

Update the "blocks when an active apply task already exists" test in `easy-apply-gate.test.ts`:

```typescript
it('blocks when an active apply task already exists for the job (idempotency)', () => {
  const job = makeJob(db);
  const appId = newId();
  const cvId = newId();
  db.prepare(`INSERT INTO cvs (id, original_name, original_path, is_default, created_at, updated_at)
              VALUES (?, 'cv.pdf', '/tmp/cv.pdf', 1, ?, ?)`).run(cvId, NOW, NOW);
  db.prepare(`INSERT INTO applications (id, job_id, cv_id, apply_method, status, created_at, updated_at)
              VALUES (?, ?, ?, 'auto', 'queued', ?, ?)`).run(appId, job.id, cvId, NOW, NOW);
  db.prepare(`
    INSERT INTO task_queue (id, kind, payload, status, attempts, max_attempts, priority, created_at, updated_at)
    VALUES (?, 'apply', ?, 'pending', 0, 3, 5, ?, ?)
  `).run(newId(), JSON.stringify({ application_id: appId }), NOW, NOW);
  const r = checkEasyApplyGate(db, { jobId: job.id, nowIso: NOW, today: TODAY });
  expect(r.decision).toBe('block');
  expect(r.reason).toBe('apply_task_in_flight');
});
```

(Sanity-check the exact column lists against `001_init.sql` for `cvs` and `applications` and adjust if they have additional NOT NULL columns. The pattern is "insert minimum row that satisfies constraints.")

- [ ] **Step 6: Run gate tests**

Run: `pnpm --filter @vina/server test easy-apply-gate`
Expected: PASS — all eight cases.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/services/easy-apply-gate.ts packages/server/tests/services/easy-apply-gate.test.ts
git commit -m "feat(server): easy-apply-gate function (cap, throttle, freshness, idempotency, circuit breaker)"
```

---

## Phase 4 — Apply handler integration

**Why next:** the handler is the last line of defence. Even if upstream forgets to gate, the handler refuses to run a disallowed apply, updates rate-limit state on outcome, and trips the circuit breaker by auto-flipping the mode setting.

### Task 4.1 — Gate enforcement at handler entry

**Files:**
- Modify: `packages/server/src/queue/handlers/apply.ts`
- Modify: `packages/server/tests/queue/apply.test.ts` (create if it doesn't exist; or add to an existing harness)

- [ ] **Step 1: Write a failing test**

Add to `packages/server/tests/queue/apply.test.ts`:

```typescript
it('refuses to run when the gate blocks (e.g. circuit_breaker_tripped) and emits an alert', async () => {
  // Arrange: a valid auto-apply job + application, circuit breaker already at limit.
  const { db, bus, handler, jobId, applicationId } = buildHandlerFixture();
  db.prepare(`UPDATE apply_rate_limit SET consecutive_failures = 5`).run();

  // Act
  await handler({ application_id: applicationId });

  // Assert: application status flipped to failed with a clear reason; alert raised.
  const app = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(applicationId) as any;
  expect(app.status).toBe('failed');
  expect(app.failure_reason).toContain('gate_blocked');
  const alert = db.prepare(`SELECT * FROM alerts WHERE application_id = ? ORDER BY created_at DESC`).get(applicationId) as any;
  expect(alert.kind).toBe('apply_failed');
  expect(alert.description).toMatch(/circuit_breaker/);
});
```

You will need a `buildHandlerFixture` helper that wires the handler with stub deps (browserManager mock, adapter mock, model mock). If a similar helper exists for existing apply tests in [packages/server/tests/queue/](packages/server/tests/queue/), reuse it; otherwise write one in the same file. See [packages/server/tests/queue/apply.test.ts](packages/server/tests/queue/apply.test.ts) if it already exists.

- [ ] **Step 2: Run — verify failure**

Run: `pnpm --filter @vina/server test queue/apply`
Expected: FAIL — handler does not consult the gate yet.

- [ ] **Step 3: Wire the gate into the handler**

In `packages/server/src/queue/handlers/apply.ts`, immediately after `const app = findApplicationById(...)` and `const job = findJobById(...)`:

```typescript
import { checkEasyApplyGate, dayBucketFromIso } from '../../services/easy-apply-gate.js';
import {
  recordAttempt,
  recordFailure,
  recordSuccess,
} from '../../db/repositories/apply-rate-limit.js';
import { updateSettings } from '../../db/repositories/settings.js';
import { getOrInitSettings } from '../../db/repositories/settings.js';

// ... within the returned async function, after `if (job.apply_method !== 'auto') { ... }`:

const nowIso = new Date().toISOString();
const today = dayBucketFromIso(nowIso);
const gate = checkEasyApplyGate(deps.db, { jobId: job.id, nowIso, today });
if (gate.decision === 'block') {
  updateApplicationStatus(deps.db, app.id, 'failed', {
    failure_reason: `gate_blocked: ${gate.reason}`,
  });
  insertAlert(deps.db, {
    kind: 'apply_failed',
    severity: 'warning',
    title: `Apply skipped: ${job.title} @ ${job.company}`,
    description: `Gate blocked this apply (${gate.reason}).`,
    application_id: app.id,
    payload: { gate_reason: gate.reason },
  });
  deps.bus.emit('jobs:updated', { ids: [app.job_id] });
  log.info(
    { application_id: app.id, gate_reason: gate.reason },
    'apply skipped by gate',
  );
  return;
}

recordAttempt(deps.db, nowIso, today);

if (gate.decision === 'dry_run') {
  // Dry-run mode: log the would-be apply without launching the browser.
  log.info(
    { application_id: app.id, job_id: job.id },
    'apply dry-run: would have invoked runApply',
  );
  updateApplicationStatus(deps.db, app.id, 'awaiting_user', {
    failure_reason: 'dry_run',
  });
  deps.bus.emit('jobs:updated', { ids: [app.job_id] });
  return;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @vina/server test queue/apply`
Expected: PASS — the circuit-breaker-tripped test passes.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/queue/handlers/apply.ts packages/server/tests/queue/apply.test.ts
git commit -m "feat(server): apply handler consults easy-apply-gate before running"
```

### Task 4.2 — Record success/failure outcomes and trip the breaker

**Files:**
- Modify: `packages/server/src/queue/handlers/apply.ts`
- Modify: `packages/server/tests/queue/apply.test.ts`

- [ ] **Step 1: Write a failing test for the success path**

```typescript
it('records a success when runApply submits', async () => {
  const { db, handler, applicationId } = buildHandlerFixture({ outcome: 'submitted' });
  await handler({ application_id: applicationId });
  const rl = db.prepare(`SELECT * FROM apply_rate_limit`).get() as any;
  expect(rl.successful_today).toBe(1);
  expect(rl.consecutive_failures).toBe(0);
  expect(rl.last_success_at).not.toBeNull();
});
```

- [ ] **Step 2: Write a failing test for the failure path**

```typescript
it('records a failure on apply_failed outcome', async () => {
  const { db, handler, applicationId } = buildHandlerFixture({ outcome: 'failed' });
  await handler({ application_id: applicationId });
  const rl = db.prepare(`SELECT * FROM apply_rate_limit`).get() as any;
  expect(rl.consecutive_failures).toBe(1);
  expect(rl.successful_today).toBe(0);
});
```

- [ ] **Step 3: Write a failing test for the circuit breaker auto-flip**

```typescript
it('flips easy_apply_mode to manual after the configured failure limit', async () => {
  const { db, handler, applicationId } = buildHandlerFixture({ outcome: 'failed' });
  updateSettings(db, { easy_apply_mode: 'autonomous', apply_consecutive_failure_limit: 1 });
  await handler({ application_id: applicationId });
  const s = getOrInitSettings(db);
  expect(s.easy_apply_mode).toBe('manual');
  const alert = db.prepare(`SELECT * FROM alerts WHERE kind = 'apply_failed' ORDER BY created_at DESC`).get() as any;
  expect(alert.title).toMatch(/autonomous paused/i);
});
```

- [ ] **Step 4: Run tests — verify they fail**

Run: `pnpm --filter @vina/server test queue/apply`
Expected: FAIL — outcomes are not yet recorded against rate-limit state.

- [ ] **Step 5: Wire outcomes into the handler**

At the existing branches in `apply.ts`:

After `if (result.outcome === 'submitted') { updateApplicationStatus(...) ... }`, add:
```typescript
recordSuccess(deps.db, new Date().toISOString(), today);
```

In each branch where the outcome is `failed` (the existing `else` block) **and** in the `catch (err)` block before the `throw err`, add:
```typescript
recordFailure(deps.db);
// Circuit breaker: re-read rate-limit + settings; if at limit, auto-flip to manual.
const rl = getRateLimit(deps.db);
const settings = getOrInitSettings(deps.db);
if (
  settings.easy_apply_mode === 'autonomous' &&
  rl.consecutive_failures >= settings.apply_consecutive_failure_limit
) {
  updateSettings(deps.db, { easy_apply_mode: 'manual' });
  insertAlert(deps.db, {
    kind: 'apply_failed',
    severity: 'error',
    title: 'Autonomous Easy Apply paused after consecutive failures',
    description: `${rl.consecutive_failures} apply attempts failed in a row. Mode was flipped to manual. Investigate before re-enabling.`,
    application_id: null,
    payload: { consecutive_failures: rl.consecutive_failures },
  });
}
```

For the `awaiting_approval` / `awaiting_user` branches, neither success nor failure increments — leave them out of the rate-limit update. The throttle's `last_attempt_at` was already stamped in Task 4.1, so a paused application still consumes one throttle slot (intentional — every browser-launching attempt counts toward velocity).

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @vina/server test queue/apply`
Expected: PASS — all three new tests + existing ones.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/queue/handlers/apply.ts packages/server/tests/queue/apply.test.ts
git commit -m "feat(server): apply handler records outcomes + trips circuit breaker"
```

---

## Phase 5 — Skill tightening, EEO short-circuit, source audit

**Why next:** without these, the LLM still guesses on unknown fields and we have no audit trail. This phase makes "never guess" enforceable.

### Task 5.1 — Tighten browser-apply SKILL.md

**Files:**
- Modify: `packages/orchestrator/skills/browser-apply/SKILL.md`
- Modify: any orchestrator skill identity tests that hash the body (search: `grep -rn "browser-apply" packages/orchestrator/tests`)

- [ ] **Step 1: Read the current skill body**

Open `packages/orchestrator/skills/browser-apply/SKILL.md` and review the operating loop. Locate step 3 ("LLM fallback only for the unresolved") and the "Hard rules" section.

- [ ] **Step 2: Update the loop and hard rules**

Replace step 3 in the operating loop with:

```markdown
3. **LLM fallback only for the unresolved, and only with literal evidence.**
   For `unknown` fields, decide one of:
   - `fill` — only when the user's profile, saved answers, or CV text contains
     a literal match for the question (e.g. the question asks "Years of
     experience with TypeScript?" and the CV plainly states "TypeScript: 5
     years"). Quote-or-skip: if you cannot point to the exact source phrase,
     this is **not** a literal match.
   - `skip` — for every other case, including questions you can "reasonably
     infer" or "guess" from general knowledge. Skipping is the safe default.
   Never invent a value to keep the form moving. The caller will pause the
   application and ask the user — that is the correct outcome.
```

Add a new section before "Hard rules":

```markdown
## EEO / demographic questions — always skip

These questions are legally optional in many jurisdictions and the user must
answer them themselves. Detect them by the field's label or options. **Always
emit `skip`, never `fill`, regardless of what the profile contains.**

Signals that mark a question as EEO/demographic:
- Labels mentioning: race, ethnicity, gender, sex, sexual orientation,
  disability status, veteran status, military service, pronouns, or
  questions explicitly tagged as "EEO" / "voluntary self-identification".
- Options that include "Prefer not to answer" alongside protected-class
  values.

Skip these even if the user previously answered one — saved answers may
have been entered under duress or have changed. Pause and let the user
re-confirm each time.
```

Update the "Hard rules" section:

```markdown
## Hard rules

- Never fabricate. If a field needs information not literally present in the
  user's data, `skip` and let the caller pause the application.
- EEO / demographic questions always skip — see the dedicated section above.
- Read attributes rather than clicking when you only need to inspect.
- One action, then observe. Re-snapshot whenever the page may have changed.
- Take a screenshot on every failure path before raising the alert.
```

Bump the frontmatter `version: 2` → `version: 3`.

- [ ] **Step 3: Find tests that pin the skill body**

Run: `grep -rn "browser-apply\|skill\.body\|skill version" packages/orchestrator/tests packages/server/tests`
Expected: tests that load the skill — they should not depend on byte-exact identity, but if they assert the version, update from 2 → 3.

- [ ] **Step 4: Run orchestrator tests**

Run: `pnpm --filter @vina/orchestrator test`
Expected: PASS — if any version-checks fail, update them to `3`. If any tests assert the LLM "guessed" a value for an unknown field, they're testing the old behaviour and need to change to expect `skip`. (These will surface in Task 5.2.)

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/skills/browser-apply/SKILL.md packages/orchestrator/tests
git commit -m "feat(orchestrator): tighten browser-apply skill — literal evidence only + EEO skip"
```

### Task 5.2 — EEO short-circuit in field-resolver

**Files:**
- Modify: `packages/automation/src/forms/field-resolver.ts`
- Create / modify: `packages/automation/tests/forms/field-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/automation/tests/forms/field-resolver.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { resolveField } from '../../src/forms/field-resolver.js';

const profile = {
  full_name: 'Ada Lovelace',
  email: 'ada@example.test',
  phone: '+44 7700 900000',
  location: 'London, UK',
  linkedin_url: 'https://linkedin.com/in/ada',
  website_url: null,
};

describe('field-resolver — EEO short-circuit', () => {
  it('marks gender questions as unknown even with a saved answer', () => {
    const r = resolveField(
      { ref: 'r1', label: 'Gender', kind: 'select', required: false, options: ['Male', 'Female', 'Prefer not to answer'] },
      { profile, answers: [{ key: 'gender', label: 'Gender', value: 'Female' }] },
    );
    expect(r.kind).toBe('unknown');
  });

  it('marks veteran-status questions as unknown', () => {
    const r = resolveField(
      { ref: 'r2', label: 'Veteran status', kind: 'select', required: false, options: ['Yes', 'No', 'Prefer not to answer'] },
      { profile, answers: [] },
    );
    expect(r.kind).toBe('unknown');
  });

  it('still resolves normal questions from profile', () => {
    const r = resolveField(
      { ref: 'r3', label: 'Email address', kind: 'text', required: true },
      { profile, answers: [] },
    );
    expect(r.kind).toBe('resolved');
    if (r.kind === 'resolved') expect(r.value).toBe('ada@example.test');
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm --filter @vina/automation test forms/field-resolver`
Expected: FAIL — EEO questions currently resolve from saved answers.

- [ ] **Step 3: Implement EEO detection**

At the top of `packages/automation/src/forms/field-resolver.ts`, add:

```typescript
const EEO_LABEL_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(race|ethnicit)/i,
  /\b(gender|sex|sexual orientation|pronouns?)\b/i,
  /\b(disability|disabled)\b/i,
  /\b(veteran|military service)\b/i,
  /\beeo\b/i,
  /voluntary self.identif/i,
];

function isEeoQuestion(label: string, options?: readonly string[]): boolean {
  if (EEO_LABEL_PATTERNS.some((re) => re.test(label))) return true;
  // Secondary signal: any option literally including a protected-class
  // phrase + a "prefer not to answer" sibling.
  if (options && options.some((o) => /prefer not to (answer|say|disclose)/i.test(o))) {
    return EEO_LABEL_PATTERNS.some((re) => re.test(label));
  }
  return false;
}
```

In the existing `resolveField` function (top-level, exported), as the **first** check before any profile/answers/cv lookup:

```typescript
if (isEeoQuestion(field.label, field.options)) {
  return { kind: 'unknown' };
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `pnpm --filter @vina/automation test forms/field-resolver`
Expected: PASS — all three test cases.

- [ ] **Step 5: Commit**

```bash
git add packages/automation/src/forms/field-resolver.ts packages/automation/tests/forms/field-resolver.test.ts
git commit -m "feat(automation): EEO/demographic questions short-circuit to unknown"
```

### Task 5.3 — Per-field source audit through application_events

**Files:**
- Modify: `packages/orchestrator/src/graphs/apply.ts`
- Modify: `packages/server/src/queue/handlers/apply.ts` (EVENT_KIND_MAP if `field_filled` payload needs source)
- Modify: `packages/web/src/routes/applications/ApplicationsPage.tsx` (display source)
- Tests as appropriate

- [ ] **Step 1: Check current event emission**

Open `packages/orchestrator/src/graphs/apply.ts` and search for `field_filled` event emissions. The handler's `EVENT_KIND_MAP` already maps `field_filled → field_filled`. Confirm whether the event's `detail` carries the source (`profile` / `answers` / `cv` / `fallback`).

- [ ] **Step 2: Write the failing test**

Add to `packages/orchestrator/tests/graphs/apply.test.ts` (or wherever apply-graph tests live):

```typescript
it('records a source on each field_filled event', async () => {
  // Set up an apply run where one field resolves from profile and another from answers.
  // Assert events: each field_filled event's detail includes { source: 'profile'|'answers'|'cv'|'fallback' }.
  const result = await runApply(/* ... */);
  const fieldFilled = result.events.filter((e) => e.step === 'field_filled');
  expect(fieldFilled.length).toBeGreaterThan(0);
  for (const ev of fieldFilled) {
    expect(['profile', 'answers', 'cv', 'fallback']).toContain(ev.detail?.source);
  }
});
```

Adjust per the existing test scaffolding in the file.

- [ ] **Step 3: Run — verify failure**

Run: `pnpm --filter @vina/orchestrator test graphs/apply`
Expected: FAIL — source is not currently included.

- [ ] **Step 4: Thread source through the graph**

In `packages/orchestrator/src/graphs/apply.ts`, locate where `field_filled` is emitted. Update the event payload to include `source`, taking it from the resolver result (`profile` / `answers` / `cv`) or marking it `fallback` when the value came from `decideUnresolvedField`. The resolver already returns `source: ResolveSource` for resolved fields ([packages/automation/src/forms/field-resolver.ts:42](packages/automation/src/forms/field-resolver.ts#L42)) — thread that through to the event.

For LLM-fallback fields, decideUnresolvedField returns the chosen value; mark `source: 'fallback'` on the event.

- [ ] **Step 5: Run orchestrator tests**

Run: `pnpm --filter @vina/orchestrator test`
Expected: PASS.

- [ ] **Step 6: Display source on the Applications page**

In `packages/web/src/routes/applications/ApplicationsPage.tsx`, locate the event-rendering component. For events of kind `field_filled`, render the source next to the value. Add a small chip ("from profile" / "from saved answers" / "from CV" / "answered by AI fallback").

- [ ] **Step 7: Add a web test for source display (if there's a test scaffold for ApplicationsPage)**

Otherwise, smoke-check with `pnpm --filter @vina/web dev` and visit `/applications`.

- [ ] **Step 8: Commit**

```bash
git add packages/orchestrator/src/graphs/apply.ts packages/orchestrator/tests packages/web/src/routes/applications
git commit -m "feat(orchestrator,web): record + display per-field answer source on applications"
```

---

## Phase 6 — Profile-answers HTTP + UI

**Why next:** the user can now save tightened answers via the resume flow, but cannot review or delete them. This phase exposes the existing repository through HTTP + a Settings tile.

### Task 6.1 — HTTP route for profile_answers

**Files:**
- Create: `packages/server/src/http/routes/profile-answers.ts`
- Modify: `packages/server/src/http/index.ts` (or wherever routes are registered)
- Create: `packages/server/tests/http/profile-answers.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/server/tests/http/profile-answers.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js'; // reuse existing test helper
import { upsertAnswer } from '../../src/db/repositories/profile-answers.js';

describe('GET /api/profile-answers', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    app = await buildTestApp();
    upsertAnswer(app.db, 'years_typescript', 'Years of TypeScript?', '5');
    upsertAnswer(app.db, 'work_authorisation_us', 'Work authorisation in US?', 'No');
  });

  it('lists saved answers sorted by key', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/api/profile-answers' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { answers: Array<{ key: string }> };
    expect(body.answers).toHaveLength(2);
    expect(body.answers[0].key).toBe('work_authorisation_us');
  });

  it('deletes one by key', async () => {
    const res = await app.fastify.inject({
      method: 'DELETE',
      url: '/api/profile-answers/years_typescript',
    });
    expect(res.statusCode).toBe(204);
    const after = await app.fastify.inject({ method: 'GET', url: '/api/profile-answers' });
    expect((after.json() as { answers: unknown[] }).answers).toHaveLength(1);
  });

  it('clears all', async () => {
    const res = await app.fastify.inject({ method: 'DELETE', url: '/api/profile-answers' });
    expect(res.statusCode).toBe(204);
    const after = await app.fastify.inject({ method: 'GET', url: '/api/profile-answers' });
    expect((after.json() as { answers: unknown[] }).answers).toHaveLength(0);
  });

  it('returns 404 when deleting a missing key', async () => {
    const res = await app.fastify.inject({
      method: 'DELETE',
      url: '/api/profile-answers/no-such-key',
    });
    expect(res.statusCode).toBe(404);
  });
});
```

(If `buildTestApp` does not exist in the project test scaffold, find the equivalent helper used by other HTTP route tests like `tests/http/jobs.test.ts` and follow that pattern.)

- [ ] **Step 2: Run — verify failure**

Run: `pnpm --filter @vina/server test http/profile-answers`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement the route**

`packages/server/src/http/routes/profile-answers.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { NotFoundError } from '@vina/shared';
import {
  deleteAnswer,
  listAnswers,
} from '../../db/repositories/profile-answers.js';

export function registerProfileAnswersRoutes(app: FastifyInstance, db: DatabaseType): void {
  app.get('/api/profile-answers', async () => ({ answers: listAnswers(db) }));

  app.delete('/api/profile-answers/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    const ok = deleteAnswer(db, key);
    if (!ok) throw new NotFoundError(`No saved answer with key ${key}`);
    return reply.status(204).send();
  });

  app.delete('/api/profile-answers', async (_req, reply) => {
    db.prepare(`DELETE FROM profile_answers`).run();
    return reply.status(204).send();
  });
}
```

Register it in the HTTP wiring (alongside the other `register*Routes` calls).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @vina/server test http/profile-answers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/routes/profile-answers.ts packages/server/src/http packages/server/tests/http/profile-answers.test.ts
git commit -m "feat(server): /api/profile-answers list + delete + clear-all routes"
```

### Task 6.2 — AnswersTile in Settings

**Files:**
- Create: `packages/web/src/routes/settings/AnswersTile.tsx`
- Modify: `packages/web/src/routes/settings/SettingsPage.tsx` (mount the tile)
- Create: `packages/web/tests/routes/settings/AnswersTile.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/web/tests/routes/settings/AnswersTile.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnswersTile } from '../../../src/routes/settings/AnswersTile.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe('AnswersTile', () => {
  it('lists answers and supports forget + clear all', async () => {
    let answers = [
      { id: '1', key: 'years_typescript', label: 'Years of TypeScript?', value: '5', created_at: '2026-06-21T00:00:00.000Z', updated_at: '2026-06-21T00:00:00.000Z' },
      { id: '2', key: 'work_auth_us', label: 'Work auth in US?', value: 'No', created_at: '2026-06-21T00:00:00.000Z', updated_at: '2026-06-21T00:00:00.000Z' },
    ];
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/profile-answers' && (!opts || opts.method === 'GET')) {
        return new Response(JSON.stringify({ answers }), { status: 200 });
      }
      if (url.startsWith('/api/profile-answers/') && opts?.method === 'DELETE') {
        answers = answers.filter((a) => !url.endsWith(`/${a.key}`));
        return new Response(null, { status: 204 });
      }
      if (url === '/api/profile-answers' && opts?.method === 'DELETE') {
        answers = [];
        return new Response(null, { status: 204 });
      }
      throw new Error(`unmocked: ${url} ${opts?.method}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(wrap(<AnswersTile />));
    expect(await screen.findByText('Years of TypeScript?')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Work auth in US?')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /forget/i })[0]);
    await waitFor(() => expect(screen.queryByText('Years of TypeScript?')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
    // Confirm dialog
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(screen.queryByText('Work auth in US?')).not.toBeInTheDocument());
    expect(screen.getByText(/no saved answers/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm --filter @vina/web test settings/AnswersTile`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the tile**

`packages/web/src/routes/settings/AnswersTile.tsx`:

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/ui/button.js';

interface ProfileAnswer {
  id: string;
  key: string;
  label: string;
  value: string;
  created_at: string;
  updated_at: string;
}

async function fetchAnswers(): Promise<ProfileAnswer[]> {
  const r = await fetch('/api/profile-answers');
  if (!r.ok) throw new Error('Failed to fetch answers');
  const body = (await r.json()) as { answers: ProfileAnswer[] };
  return body.answers;
}

async function forgetAnswer(key: string): Promise<void> {
  const r = await fetch(`/api/profile-answers/${encodeURIComponent(key)}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw new Error('Failed to forget');
}

async function clearAllAnswers(): Promise<void> {
  const r = await fetch('/api/profile-answers', { method: 'DELETE' });
  if (!r.ok) throw new Error('Failed to clear');
}

export function AnswersTile(): JSX.Element {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['profile-answers'], queryFn: fetchAnswers });
  const forget = useMutation({
    mutationFn: forgetAnswer,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile-answers'] }),
  });
  const clearAll = useMutation({
    mutationFn: clearAllAnswers,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile-answers'] });
      setConfirming(false);
    },
  });

  return (
    <section className="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-medium text-ink-primary">Saved screening answers</h2>
        {data && data.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Clear all
          </Button>
        )}
      </header>
      <p className="mb-3 text-sm text-ink-secondary">
        Answers Vina saved from your past Easy Apply runs. They are reused for matching questions
        on future applications. Read-only here — to change an answer, forget it and the next apply
        will prompt you again.
      </p>
      {isLoading && <p className="text-sm text-ink-muted">Loading…</p>}
      {!isLoading && data && data.length === 0 && (
        <p className="text-sm text-ink-muted">No saved answers yet.</p>
      )}
      {data && data.length > 0 && (
        <ul className="divide-y divide-border-subtle">
          {data.map((a) => (
            <li key={a.id} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-primary">{a.label}</p>
                <p className="truncate text-sm text-ink-secondary">{a.value}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => forget.mutate(a.key)}
                disabled={forget.isPending}
              >
                Forget
              </Button>
            </li>
          ))}
        </ul>
      )}
      {confirming && (
        <div className="mt-3 rounded-md border border-warning bg-warning-soft p-3 text-sm">
          <p className="mb-2">Clear all saved answers? Vina will prompt you again the next time it sees each question.</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => clearAll.mutate()} disabled={clearAll.isPending}>
              Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Mount in SettingsPage**

In `packages/web/src/routes/settings/SettingsPage.tsx`, add `<AnswersTile />` alongside the other tiles (PromptsTile, SkillsTile, etc.).

- [ ] **Step 5: Run web tests**

Run: `pnpm --filter @vina/web test settings/AnswersTile`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/routes/settings/AnswersTile.tsx packages/web/src/routes/settings/SettingsPage.tsx packages/web/tests/routes/settings/AnswersTile.test.tsx
git commit -m "feat(web): AnswersTile — review and forget saved screening answers"
```

---

## Phase 7 — Easy Apply Settings UI

### Task 7.1 — EasyApplyTile with mode toggle, limits, and risk disclosure

**Files:**
- Create: `packages/web/src/routes/settings/EasyApplyTile.tsx`
- Create: `packages/web/src/routes/settings/AutonomousRiskDialog.tsx`
- Modify: `packages/web/src/routes/settings/SettingsPage.tsx`
- Create: `packages/web/tests/routes/settings/EasyApplyTile.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/web/tests/routes/settings/EasyApplyTile.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EasyApplyTile } from '../../../src/routes/settings/EasyApplyTile.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const baseSettings = {
  id: 'app',
  easy_apply_mode: 'manual',
  autonomous_apply_dry_run: false,
  apply_daily_cap: 10,
  apply_min_interval_seconds: 300,
  apply_listing_max_age_days: 14,
  apply_consecutive_failure_limit: 5,
  browser_headful: false,
  browser_stealth: false,
  paused: false,
  active_llm_provider_id: null,
  has_serpapi_key: false,
  updated_at: '2026-06-21T00:00:00.000Z',
};

describe('EasyApplyTile', () => {
  it('switching to autonomous opens the risk disclosure dialog before patching', async () => {
    let current = { ...baseSettings };
    let patchedBody: unknown = null;
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/settings' && (!opts || opts.method === 'GET')) {
        return new Response(JSON.stringify(current), { status: 200 });
      }
      if (url === '/api/settings' && opts?.method === 'PATCH') {
        patchedBody = JSON.parse(opts.body as string);
        current = { ...current, ...(patchedBody as object) };
        return new Response(JSON.stringify(current), { status: 200 });
      }
      throw new Error(`unmocked ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(wrap(<EasyApplyTile />));
    await screen.findByRole('radio', { name: /manual/i });

    fireEvent.click(screen.getByRole('radio', { name: /autonomous/i }));

    // Risk dialog must appear; PATCH must not have happened yet
    expect(await screen.findByText(/risks of autonomous mode/i)).toBeInTheDocument();
    expect(patchedBody).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /i understand/i }));

    await waitFor(() => expect(patchedBody).toEqual({ easy_apply_mode: 'autonomous' }));
  });

  it('updates numeric limits when the user changes them', async () => {
    const current = { ...baseSettings };
    let patchedBody: unknown = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') {
        patchedBody = JSON.parse(opts.body as string);
        return new Response(JSON.stringify({ ...current, ...(patchedBody as object) }), { status: 200 });
      }
      return new Response(JSON.stringify(current), { status: 200 });
    }));

    render(wrap(<EasyApplyTile />));
    const capInput = await screen.findByLabelText(/daily easy apply cap/i);
    fireEvent.change(capInput, { target: { value: '25' } });
    fireEvent.blur(capInput);
    await waitFor(() => expect(patchedBody).toEqual({ apply_daily_cap: 25 }));
  });
});
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm --filter @vina/web test settings/EasyApplyTile`
Expected: FAIL.

- [ ] **Step 3: Implement the risk dialog**

`packages/web/src/routes/settings/AutonomousRiskDialog.tsx`:

```tsx
import { Button } from '../../components/ui/button.js';

interface Props {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AutonomousRiskDialog({ open, onConfirm, onCancel }: Props): JSX.Element | null {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-w-lg rounded-lg bg-surface-raised p-6 shadow-lg">
        <h3 className="text-lg font-semibold text-ink-primary">Risks of autonomous mode</h3>
        <ul className="mt-3 space-y-2 text-sm text-ink-secondary">
          <li>
            Easy Apply submissions are <strong>irreversible</strong>. Vina will submit applications
            on your behalf when it scores a job above your threshold and all gates pass.
          </li>
          <li>
            Vina will <strong>never guess</strong> answers — if a screening question has no literal
            answer in your profile or saved answers, Vina pauses the application and alerts you. But
            previously saved answers will be re-used. Review them in the Saved Answers tile.
          </li>
          <li>
            EEO / demographic questions are always skipped and require you to answer manually.
          </li>
          <li>
            Vina caps daily applies (default 10), throttles velocity (default 5 minutes between
            attempts), and auto-pauses after 5 consecutive failures. You can change these limits
            below.
          </li>
          <li>
            High-volume automation may trigger LinkedIn account flags. Keep the cap low until you
            trust the flow.
          </li>
        </ul>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>I understand — enable autonomous</Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement the tile**

`packages/web/src/routes/settings/EasyApplyTile.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Settings, SettingsUpdate } from '@vina/shared';
import { AutonomousRiskDialog } from './AutonomousRiskDialog.js';

async function fetchSettings(): Promise<Settings> {
  const r = await fetch('/api/settings');
  if (!r.ok) throw new Error('Failed to fetch settings');
  return (await r.json()) as Settings;
}

async function patchSettings(update: SettingsUpdate): Promise<Settings> {
  const r = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!r.ok) throw new Error('Failed to update settings');
  return (await r.json()) as Settings;
}

export function EasyApplyTile(): JSX.Element {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
  const mutate = useMutation({
    mutationFn: patchSettings,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const [showRiskDialog, setShowRiskDialog] = useState(false);

  if (!data) return <section className="rounded-lg border p-4">Loading…</section>;

  function setMode(mode: 'autonomous' | 'manual'): void {
    if (mode === 'autonomous' && data?.easy_apply_mode !== 'autonomous') {
      setShowRiskDialog(true);
      return;
    }
    mutate.mutate({ easy_apply_mode: mode });
  }

  function patchNumber(key: keyof SettingsUpdate, value: number): void {
    mutate.mutate({ [key]: value } as SettingsUpdate);
  }

  return (
    <section className="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <header className="mb-3">
        <h2 className="text-base font-medium text-ink-primary">Easy Apply</h2>
      </header>

      <fieldset className="mb-4">
        <legend className="mb-2 text-sm font-medium text-ink-primary">Mode</legend>
        <label className="mr-4 inline-flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="easy_apply_mode"
            value="manual"
            checked={data.easy_apply_mode === 'manual'}
            onChange={() => setMode('manual')}
          />
          Manual — only apply when I click Auto-apply
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="easy_apply_mode"
            value="autonomous"
            checked={data.easy_apply_mode === 'autonomous'}
            onChange={() => setMode('autonomous')}
          />
          Autonomous — apply on my behalf
        </label>
      </fieldset>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <NumberField
          label="Daily Easy Apply cap"
          help="Counts successful submissions. Manual clicks count too."
          value={data.apply_daily_cap}
          min={1}
          max={100}
          onCommit={(v) => patchNumber('apply_daily_cap', v)}
        />
        <NumberField
          label="Minimum minutes between applies"
          help="Velocity throttle in minutes."
          value={Math.round(data.apply_min_interval_seconds / 60)}
          min={0}
          max={60}
          onCommit={(v) => patchNumber('apply_min_interval_seconds', v * 60)}
        />
        <NumberField
          label="Skip listings older than (days)"
          value={data.apply_listing_max_age_days}
          min={1}
          max={365}
          onCommit={(v) => patchNumber('apply_listing_max_age_days', v)}
        />
        <NumberField
          label="Pause after N consecutive failures"
          help="Vina flips back to manual when this is hit."
          value={data.apply_consecutive_failure_limit}
          min={1}
          max={50}
          onCommit={(v) => patchNumber('apply_consecutive_failure_limit', v)}
        />
      </div>

      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={data.autonomous_apply_dry_run}
          onChange={(e) => mutate.mutate({ autonomous_apply_dry_run: e.target.checked })}
        />
        Dry-run — log would-be applies without submitting (recommended for the first week)
      </label>

      <AutonomousRiskDialog
        open={showRiskDialog}
        onCancel={() => setShowRiskDialog(false)}
        onConfirm={() => {
          setShowRiskDialog(false);
          mutate.mutate({ easy_apply_mode: 'autonomous' });
        }}
      />
    </section>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  help?: string;
  onCommit: (n: number) => void;
}): JSX.Element {
  const [v, setV] = useState(String(props.value));
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-ink-primary">{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Number(v);
          if (Number.isInteger(n) && n >= props.min && n <= props.max && n !== props.value) {
            props.onCommit(n);
          } else {
            setV(String(props.value));
          }
        }}
        className="rounded border border-border-subtle bg-surface-sunken px-2 py-1 text-ink-primary"
      />
      {props.help && <span className="text-xs text-ink-muted">{props.help}</span>}
    </label>
  );
}
```

- [ ] **Step 5: Mount in SettingsPage**

In `packages/web/src/routes/settings/SettingsPage.tsx`, add `<EasyApplyTile />` near the top (it's the headline feature now).

- [ ] **Step 6: Run web tests**

Run: `pnpm --filter @vina/web test settings/EasyApplyTile`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/routes/settings/EasyApplyTile.tsx packages/web/src/routes/settings/AutonomousRiskDialog.tsx packages/web/src/routes/settings/SettingsPage.tsx packages/web/tests/routes/settings/EasyApplyTile.test.tsx
git commit -m "feat(web): EasyApplyTile — mode toggle, limits, risk disclosure"
```

---

## Phase 8 — Autonomous + manual entry points

### Task 8.1 — easy-apply-enqueuer service

**Files:**
- Create: `packages/server/src/queue/easy-apply-enqueuer.ts`
- Create: `packages/server/tests/queue/easy-apply-enqueuer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { enqueueEasyApplyForJob } from '../../src/queue/easy-apply-enqueuer.js';
import { EventBus } from '../../src/events/bus.js';
import { insertJob } from '../../src/db/repositories/jobs.js';
import { newId } from '@vina/shared';

function buildFixture() {
  const db = new Database(':memory:');
  runMigrations(db);
  const bus = new EventBus();
  // seed a default CV
  const cvId = newId();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO cvs (id, original_name, original_path, is_default, created_at, updated_at)
              VALUES (?, 'cv.pdf', '/tmp/cv.pdf', 1, ?, ?)`).run(cvId, now, now);
  return { db, bus, cvId };
}

describe('enqueueEasyApplyForJob', () => {
  it('creates an application row + an apply task and returns its id', () => {
    const { db, bus } = buildFixture();
    const job = insertJob(db, { id: newId(), site_id: 'linkedin', external_id: newId(), url: 'https://x', title: 'Eng', company: 'Acme', location: null, description: null, posted_at: new Date().toISOString(), apply_method: 'auto', external_apply_url: null, original_source: null, salary_text: null, match_score: 90, score_justification: null, status: 'scored' });
    const result = enqueueEasyApplyForJob(db, bus, job.id);
    expect(result.deduped).toBe(false);
    const tasks = db.prepare(`SELECT * FROM task_queue WHERE kind = 'apply'`).all();
    expect(tasks).toHaveLength(1);
    const app = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(result.application_id) as any;
    expect(app.apply_method).toBe('auto');
  });

  it('dedupes if an active application already exists', () => {
    const { db, bus } = buildFixture();
    const job = insertJob(db, { /* same shape as above */ } as any);
    const a = enqueueEasyApplyForJob(db, bus, job.id);
    const b = enqueueEasyApplyForJob(db, bus, job.id);
    expect(b.deduped).toBe(true);
    expect(b.application_id).toBe(a.application_id);
  });

  it('refuses manual-apply jobs (ConflictError)', () => {
    const { db, bus } = buildFixture();
    const job = insertJob(db, { /* same shape but apply_method: 'manual' */ } as any);
    expect(() => enqueueEasyApplyForJob(db, bus, job.id)).toThrow();
  });
});
```

(Fill the `insertJob` arg structurally from `manual-apply-enqueuer.test.ts` if such a test exists, or from the `Job` type in shared.)

- [ ] **Step 2: Run — verify failure**

Run: `pnpm --filter @vina/server test easy-apply-enqueuer`
Expected: FAIL.

- [ ] **Step 3: Implement the enqueuer**

`packages/server/src/queue/easy-apply-enqueuer.ts`:

```typescript
import type { Database as DatabaseType } from 'better-sqlite3';
import { ConflictError, ValidationError } from '@vina/shared';
import {
  findActiveApplicationForJob,
  insertApplication,
} from '../db/repositories/applications.js';
import { findJobById } from '../db/repositories/jobs.js';
import { listCvs } from '../db/repositories/cvs.js';
import { enqueue } from '../db/repositories/task-queue.js';
import type { EventBus } from '../events/bus.js';

export interface EnqueueResult {
  application_id: string;
  status: string;
  deduped: boolean;
}

/**
 * Idempotent: if an active application already exists for this auto-apply job,
 * return it without piling up tasks. Used by:
 *   - POST /api/jobs/:id/apply (manual JobCard button)
 *   - score handler in autonomous mode (auto-enqueue)
 *
 * Note: gate checks (cap, throttle, freshness, circuit breaker) are NOT done
 * here — the apply handler performs the authoritative gate check at task
 * pickup. Pre-checks at the call site are advisory only.
 */
export function enqueueEasyApplyForJob(
  db: DatabaseType,
  bus: EventBus,
  jobId: string,
): EnqueueResult {
  const job = findJobById(db, jobId);
  if (!job) throw new ValidationError(`Job ${jobId} not found`);
  if (job.apply_method !== 'auto') {
    throw new ConflictError(`Job ${jobId} is not an Easy Apply job`);
  }

  const existing = findActiveApplicationForJob(db, jobId);
  if (existing) {
    return { application_id: existing.id, status: existing.status, deduped: true };
  }

  const cv = listCvs(db).find((c) => c.is_default);
  if (!cv) throw new ValidationError('Upload a CV in Profile first');

  const app = insertApplication(db, {
    job_id: jobId,
    cv_id: cv.id,
    cover_letter_id: null,
    apply_method: 'auto',
    status: 'queued',
  });

  enqueue(db, { kind: 'apply', payload: { application_id: app.id } });
  bus.emit('jobs:updated', { ids: [jobId] });

  return { application_id: app.id, status: app.status, deduped: false };
}
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @vina/server test easy-apply-enqueuer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/queue/easy-apply-enqueuer.ts packages/server/tests/queue/easy-apply-enqueuer.test.ts
git commit -m "feat(server): easy-apply-enqueuer service (idempotent application + apply task)"
```

### Task 8.2 — POST /api/jobs/:id/apply route

**Files:**
- Modify: `packages/server/src/http/routes/jobs.ts`
- Create / add to: `packages/server/tests/http/jobs.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('POST /api/jobs/:id/apply enqueues an apply task for auto-apply jobs', async () => {
  const app = await buildTestApp();
  const job = await app.seed.autoApplyJob({ score: 90 });
  const res = await app.fastify.inject({ method: 'POST', url: `/api/jobs/${job.id}/apply` });
  expect(res.statusCode).toBe(202);
  const body = res.json() as { application_id: string; deduped: boolean };
  expect(body.deduped).toBe(false);
  const tasks = app.db.prepare(`SELECT * FROM task_queue WHERE kind = 'apply'`).all();
  expect(tasks).toHaveLength(1);
});

it('POST /api/jobs/:id/apply returns 409 for manual-apply jobs', async () => {
  const app = await buildTestApp();
  const job = await app.seed.manualApplyJob();
  const res = await app.fastify.inject({ method: 'POST', url: `/api/jobs/${job.id}/apply` });
  expect(res.statusCode).toBe(409);
});
```

(Add `seed.autoApplyJob` / `seed.manualApplyJob` helpers to the test scaffold if missing.)

- [ ] **Step 2: Run — verify failure**

Run: `pnpm --filter @vina/server test http/jobs`
Expected: FAIL.

- [ ] **Step 3: Add the route**

In `packages/server/src/http/routes/jobs.ts`, near the existing `/prepare` route, add:

```typescript
import { enqueueEasyApplyForJob } from '../../queue/easy-apply-enqueuer.js';

// ...

app.post('/api/jobs/:id/apply', async (req, reply) => {
  const { id } = parse(IdParamsSchema, req.params, 'route params');
  if (!findJobById(db, id)) throw new NotFoundError(`Job ${id} not found`);
  const result = enqueueEasyApplyForJob(db, bus, id);
  return reply.status(202).send({
    application_id: result.application_id,
    status: result.status,
    deduped: result.deduped,
  });
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @vina/server test http/jobs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/routes/jobs.ts packages/server/tests/http/jobs.test.ts
git commit -m "feat(server): POST /api/jobs/:id/apply for Easy Apply"
```

### Task 8.3 — JobCard "Auto-apply" button

**Files:**
- Modify: `packages/web/src/routes/jobs/JobCard.tsx`
- Modify: `packages/web/src/routes/jobs/JobsPage.tsx` (wire the handler)
- Modify or create: `packages/web/tests/routes/jobs/JobCard.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it('renders Auto-apply button for auto-apply jobs and calls onAutoApply', () => {
  const onAutoApply = vi.fn();
  render(<JobCard job={makeJob({ apply_method: 'auto', match_score: 80 })} variant="new" onAutoApply={onAutoApply} onApply={vi.fn()} onMarkApplied={vi.fn()} onSkip={vi.fn()} onReopen={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /auto-apply/i }));
  expect(onAutoApply).toHaveBeenCalledOnce();
});

it('does not render Auto-apply button for manual-apply jobs', () => {
  render(<JobCard job={makeJob({ apply_method: 'manual' })} variant="new" onAutoApply={vi.fn()} onApply={vi.fn()} onMarkApplied={vi.fn()} onSkip={vi.fn()} onReopen={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /auto-apply/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm --filter @vina/web test JobCard`
Expected: FAIL.

- [ ] **Step 3: Add the button**

In `packages/web/src/routes/jobs/JobCard.tsx`:

Add an optional `onAutoApply?: () => void` to `Props`. In the JSX action row (look for where the existing buttons render — `onMarkApplied` / `onSkip` etc), conditionally render:

```tsx
{job.apply_method === 'auto' && variant === 'new' && onAutoApply && (
  <Button size="sm" onClick={onAutoApply}>
    Auto-apply
  </Button>
)}
```

In `JobsPage.tsx`, wire a mutation that calls `POST /api/jobs/:id/apply` and pass it to JobCard:

```tsx
const autoApply = useMutation({
  mutationFn: async (id: string) => {
    const r = await fetch(`/api/jobs/${id}/apply`, { method: 'POST' });
    if (!r.ok) throw new Error('Failed to apply');
    return r.json();
  },
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
});

// in the render:
<JobCard job={job} variant="new" onAutoApply={() => autoApply.mutate(job.id)} /* ... */ />
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @vina/web test JobCard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/jobs
git commit -m "feat(web): Auto-apply button on JobCard for Easy Apply jobs"
```

### Task 8.4 — Score handler autonomy branch for auto-apply

**Files:**
- Modify: `packages/server/src/queue/handlers/score.ts`
- Modify: `packages/server/tests/queue/score.test.ts` (or wherever score handler tests live)

- [ ] **Step 1: Write the failing test**

```typescript
it('autonomous mode + apply_method=auto enqueues an apply task', async () => {
  const fx = buildScoreFixture({ easy_apply_mode: 'autonomous', score_threshold: 70 });
  const job = fx.seed.job({ apply_method: 'auto' });
  // Make the model return score=85
  fx.model.next({ score: 85, justification: 'good fit' });
  await fx.handler({ job_id: job.id });
  const applyTasks = fx.db.prepare(`SELECT * FROM task_queue WHERE kind = 'apply'`).all();
  expect(applyTasks).toHaveLength(1);
});

it('autonomous mode + apply_method=auto does NOT enqueue when gate blocks (e.g. circuit_breaker_tripped)', async () => {
  const fx = buildScoreFixture({ easy_apply_mode: 'autonomous' });
  fx.db.prepare(`UPDATE apply_rate_limit SET consecutive_failures = 99`).run();
  const job = fx.seed.job({ apply_method: 'auto' });
  fx.model.next({ score: 95, justification: 'great' });
  await fx.handler({ job_id: job.id });
  const applyTasks = fx.db.prepare(`SELECT * FROM task_queue WHERE kind = 'apply'`).all();
  expect(applyTasks).toHaveLength(0);
});
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm --filter @vina/server test queue/score`
Expected: FAIL.

- [ ] **Step 3: Update score handler**

In `packages/server/src/queue/handlers/score.ts`, expand the existing autonomy hook block (which only handled `apply_method === 'manual'`) to also handle `apply_method === 'auto'`, but only when the gate allows:

```typescript
import { checkEasyApplyGate, dayBucketFromIso } from '../../services/easy-apply-gate.js';
import { enqueueEasyApplyForJob } from '../easy-apply-enqueuer.js';

// ... within the handler, replace the existing autonomous block with:

const settings = getOrInitSettings(deps.db);
if (settings.easy_apply_mode === 'autonomous' && result.score >= prefs.score_threshold) {
  if (job.apply_method === 'manual') {
    try {
      enqueueManualApplyForJob(deps.db, deps.bus, job.id);
    } catch (err) {
      log.warn({ err, job_id: job.id }, 'autonomous manual enqueue skipped');
    }
  } else if (job.apply_method === 'auto') {
    const nowIso = new Date().toISOString();
    const gate = checkEasyApplyGate(deps.db, {
      jobId: job.id,
      nowIso,
      today: dayBucketFromIso(nowIso),
    });
    if (gate.decision === 'allow' || gate.decision === 'dry_run') {
      try {
        enqueueEasyApplyForJob(deps.db, deps.bus, job.id);
        log.info({ job_id: job.id }, 'autonomous-mode: enqueued apply');
      } catch (err) {
        log.warn({ err, job_id: job.id }, 'autonomous apply enqueue skipped');
      }
    } else {
      log.info(
        { job_id: job.id, gate_reason: gate.reason },
        'autonomous-mode: apply blocked by gate at enqueue time',
      );
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @vina/server test queue/score`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/queue/handlers/score.ts packages/server/tests/queue/score.test.ts
git commit -m "feat(server): autonomous-mode score hook enqueues Easy Apply when gate allows"
```

---

## Phase 9 — Dashboard summary + kill switch

### Task 9.1 — Daily summary endpoint

**Files:**
- Create / modify: `packages/server/src/http/routes/dashboard.ts` (new file if no dashboard route exists)
- Create: `packages/server/tests/http/dashboard.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('GET /api/dashboard/easy-apply returns today\'s submitted count + recent applications', async () => {
  const app = await buildTestApp();
  // Seed two submitted-today applications
  const t = new Date().toISOString();
  app.db.prepare(`UPDATE apply_rate_limit SET successful_today = 2, day_bucket = strftime('%Y-%m-%d', 'now', 'localtime'), last_success_at = ?`).run(t);
  // Plus a couple of recent applications joined with their job titles
  // (use existing seed helpers)
  const res = await app.fastify.inject({ method: 'GET', url: '/api/dashboard/easy-apply' });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { submitted_today: number; recent: Array<{ application_id: string; title: string }>; circuit_breaker_tripped: boolean };
  expect(body.submitted_today).toBe(2);
  expect(body.circuit_breaker_tripped).toBe(false);
});
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm --filter @vina/server test http/dashboard`
Expected: FAIL.

- [ ] **Step 3: Implement the route**

`packages/server/src/http/routes/dashboard.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { getRateLimit } from '../../db/repositories/apply-rate-limit.js';
import { getOrInitSettings } from '../../db/repositories/settings.js';

export function registerDashboardRoutes(app: FastifyInstance, db: DatabaseType): void {
  app.get('/api/dashboard/easy-apply', async () => {
    const rl = getRateLimit(db);
    const settings = getOrInitSettings(db);
    const recent = db
      .prepare(`
        SELECT a.id AS application_id, j.title, j.company, a.status, a.submitted_at, a.updated_at
          FROM applications a
          JOIN jobs j ON j.id = a.job_id
         WHERE a.apply_method = 'auto'
           AND a.updated_at >= datetime('now', '-24 hours')
         ORDER BY a.updated_at DESC
         LIMIT 20
      `)
      .all();
    return {
      submitted_today: rl.successful_today,
      day_bucket: rl.day_bucket,
      circuit_breaker_tripped:
        rl.consecutive_failures >= settings.apply_consecutive_failure_limit,
      consecutive_failures: rl.consecutive_failures,
      easy_apply_mode: settings.easy_apply_mode,
      daily_cap: settings.apply_daily_cap,
      recent,
    };
  });
}
```

Register it where other routes are registered.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @vina/server test http/dashboard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/routes/dashboard.ts packages/server/src/http packages/server/tests/http/dashboard.test.ts
git commit -m "feat(server): /api/dashboard/easy-apply summary endpoint"
```

### Task 9.2 — Dashboard EasyApplyCard with kill switch

**Files:**
- Create: `packages/web/src/routes/dashboard/EasyApplyCard.tsx` (or wherever the dashboard route lives — confirm path; if no dashboard route exists yet, add the card to the existing landing page)
- Create: `packages/web/tests/routes/dashboard/EasyApplyCard.test.tsx`

- [ ] **Step 1: Locate the dashboard route**

Run: `find packages/web/src/routes -maxdepth 2 -name "*.tsx" | head -20`
Pick the file that appears to be the landing page (the home / overview / dashboard route).

- [ ] **Step 2: Write the failing test**

`packages/web/tests/routes/dashboard/EasyApplyCard.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EasyApplyCard } from '../../../src/routes/dashboard/EasyApplyCard.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const summary = {
  submitted_today: 4,
  day_bucket: '2026-06-21',
  circuit_breaker_tripped: false,
  consecutive_failures: 0,
  easy_apply_mode: 'autonomous',
  daily_cap: 10,
  recent: [
    { application_id: 'a1', title: 'Senior Engineer', company: 'Acme', status: 'submitted', submitted_at: '2026-06-21T11:30:00.000Z', updated_at: '2026-06-21T11:30:00.000Z' },
  ],
};

describe('EasyApplyCard', () => {
  it('renders today\'s count and recent applications', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/dashboard/easy-apply') return new Response(JSON.stringify(summary), { status: 200 });
      throw new Error(`unmocked ${url}`);
    }));
    render(wrap(<EasyApplyCard />));
    expect(await screen.findByText(/4 \/ 10/i)).toBeInTheDocument();
    expect(screen.getByText('Senior Engineer')).toBeInTheDocument();
  });

  it('kill switch flips mode to manual', async () => {
    let mode = 'autonomous';
    let patched = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/dashboard/easy-apply') return new Response(JSON.stringify({ ...summary, easy_apply_mode: mode }), { status: 200 });
      if (url === '/api/settings' && opts?.method === 'PATCH') {
        const body = JSON.parse(opts.body as string);
        if (body.easy_apply_mode) mode = body.easy_apply_mode;
        patched = true;
        return new Response(JSON.stringify({ ...summary, easy_apply_mode: mode }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));
    render(wrap(<EasyApplyCard />));
    fireEvent.click(await screen.findByRole('button', { name: /pause autonomous/i }));
    await waitFor(() => expect(patched).toBe(true));
    expect(mode).toBe('manual');
  });
});
```

- [ ] **Step 3: Run — verify failure**

Run: `pnpm --filter @vina/web test EasyApplyCard`
Expected: FAIL.

- [ ] **Step 4: Implement the card**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/button.js';

interface Summary {
  submitted_today: number;
  day_bucket: string;
  circuit_breaker_tripped: boolean;
  consecutive_failures: number;
  easy_apply_mode: 'autonomous' | 'manual';
  daily_cap: number;
  recent: Array<{
    application_id: string;
    title: string;
    company: string;
    status: string;
    submitted_at: string | null;
    updated_at: string;
  }>;
}

async function fetchSummary(): Promise<Summary> {
  const r = await fetch('/api/dashboard/easy-apply');
  if (!r.ok) throw new Error('Failed to fetch summary');
  return (await r.json()) as Summary;
}

async function patchMode(mode: 'autonomous' | 'manual'): Promise<void> {
  const r = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ easy_apply_mode: mode }),
  });
  if (!r.ok) throw new Error('Failed to update mode');
}

export function EasyApplyCard(): JSX.Element {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['dashboard', 'easy-apply'], queryFn: fetchSummary, refetchInterval: 30_000 });
  const pause = useMutation({
    mutationFn: () => patchMode('manual'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard', 'easy-apply'] }),
  });

  if (!data) return <section className="rounded-lg border p-4">Loading…</section>;

  return (
    <section className="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-medium text-ink-primary">Easy Apply (last 24h)</h2>
        <span className="text-xs text-ink-muted">{data.day_bucket}</span>
      </header>
      <div className="flex items-baseline gap-3">
        <span className="text-2xl font-semibold text-ink-primary">
          {data.submitted_today} / {data.daily_cap}
        </span>
        <span className="text-sm text-ink-secondary">submitted today</span>
      </div>
      {data.circuit_breaker_tripped && (
        <p className="mt-2 rounded bg-error-soft p-2 text-sm text-error">
          Circuit breaker tripped after {data.consecutive_failures} consecutive failures — mode
          flipped to manual.
        </p>
      )}
      {data.easy_apply_mode === 'autonomous' && !data.circuit_breaker_tripped && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => pause.mutate()}
          disabled={pause.isPending}
        >
          Pause autonomous now
        </Button>
      )}
      {data.recent.length > 0 && (
        <ul className="mt-4 divide-y divide-border-subtle text-sm">
          {data.recent.map((r) => (
            <li key={r.application_id} className="flex items-baseline justify-between py-1.5">
              <span className="truncate">
                <a className="text-ink-primary hover:underline" href={`/applications#${r.application_id}`}>
                  {r.title}
                </a>
                <span className="ml-1 text-ink-muted">· {r.company}</span>
              </span>
              <span className="text-xs text-ink-secondary">{r.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Mount on the dashboard route**

Add `<EasyApplyCard />` to the landing-page component identified in Step 1.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @vina/web test EasyApplyCard`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/routes/dashboard packages/web/tests/routes/dashboard
git commit -m "feat(web): Easy Apply dashboard card + kill switch"
```

---

## Phase 10 — Cleanup tasks

### Task 10.1 — task_queue periodic prune

**Files:**
- Create: `packages/server/src/queue/maintenance.ts`
- Modify: wherever the worker / daemon boot wires periodic jobs (look for the existing scheduler / cron registration)
- Create: `packages/server/tests/queue/maintenance.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { pruneTaskQueue } from '../../src/queue/maintenance.js';

describe('pruneTaskQueue', () => {
  it('removes completed/failed rows older than 30 days, keeps pending/running', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    db.prepare(`INSERT INTO task_queue (id, kind, payload, status, attempts, max_attempts, priority, created_at, updated_at) VALUES (?, 'apply', '{}', 'completed', 0, 3, 5, ?, ?)`).run('a', old, old);
    db.prepare(`INSERT INTO task_queue (id, kind, payload, status, attempts, max_attempts, priority, created_at, updated_at) VALUES (?, 'apply', '{}', 'failed', 0, 3, 5, ?, ?)`).run('b', old, old);
    db.prepare(`INSERT INTO task_queue (id, kind, payload, status, attempts, max_attempts, priority, created_at, updated_at) VALUES (?, 'apply', '{}', 'completed', 0, 3, 5, ?, ?)`).run('c', fresh, fresh);
    db.prepare(`INSERT INTO task_queue (id, kind, payload, status, attempts, max_attempts, priority, created_at, updated_at) VALUES (?, 'apply', '{}', 'pending', 0, 3, 5, ?, ?)`).run('d', old, old);
    const removed = pruneTaskQueue(db, 30);
    expect(removed).toBe(2);
    const remaining = db.prepare(`SELECT id FROM task_queue ORDER BY id`).all() as Array<{id: string}>;
    expect(remaining.map((r) => r.id)).toEqual(['c', 'd']);
  });
});
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm --filter @vina/server test queue/maintenance`
Expected: FAIL.

- [ ] **Step 3: Implement prune**

`packages/server/src/queue/maintenance.ts`:

```typescript
import type { Database as DatabaseType } from 'better-sqlite3';
import { createLogger } from '@vina/shared';

const log = createLogger('queue.maintenance');

/**
 * Delete terminal task_queue rows (status in completed/failed) older than
 * `maxAgeDays`. Returns the number of rows removed. Safe to run as often as
 * once per hour — the query is indexed on (status, updated_at).
 */
export function pruneTaskQueue(db: DatabaseType, maxAgeDays: number): number {
  const result = db
    .prepare(`
      DELETE FROM task_queue
       WHERE status IN ('completed', 'failed')
         AND updated_at < datetime('now', ?)
    `)
    .run(`-${maxAgeDays} days`);
  if (result.changes > 0) {
    log.info({ removed: result.changes, maxAgeDays }, 'pruned task_queue rows');
  }
  return result.changes;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @vina/server test queue/maintenance`
Expected: PASS.

- [ ] **Step 5: Wire periodic invocation**

In the daemon boot path (look for where node-cron is set up — search `grep -rn "node-cron\|cron.schedule" packages/server/src`), add an hourly cron entry:

```typescript
import cron from 'node-cron';
import { pruneTaskQueue } from './queue/maintenance.js';

cron.schedule('17 * * * *', () => {
  pruneTaskQueue(db, 30);
});
```

Pick a non-zero minute (`17`) to avoid clustering with other cron entries.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/queue/maintenance.ts packages/server/src packages/server/tests/queue/maintenance.test.ts
git commit -m "feat(server): hourly task_queue prune (30-day retention)"
```

### Task 10.2 — Alerts "Clear all read" / auto-dismiss

**Files:**
- Modify: `packages/server/src/http/routes/alerts.ts`
- Modify: `packages/web/src/routes/alerts/*.tsx`
- Tests for the new endpoint

- [ ] **Step 1: Decide between auto-dismiss and "Clear all read"**

Recommend: explicit "Clear all resolved" button. Auto-dismiss-on-time risks silently dropping alerts the user hasn't seen. Manual clear is cheaper to build and harder to mess up.

- [ ] **Step 2: Write the failing test**

```typescript
it('DELETE /api/alerts/resolved deletes all resolved alerts', async () => {
  const app = await buildTestApp();
  app.db.prepare(`INSERT INTO alerts (id, kind, severity, title, status, created_at, updated_at) VALUES (?, 'apply_failed', 'error', 't1', 'resolved', ?, ?)`).run('a1', '2026-06-01', '2026-06-01');
  app.db.prepare(`INSERT INTO alerts (id, kind, severity, title, status, created_at, updated_at) VALUES (?, 'apply_failed', 'error', 't2', 'open', ?, ?)`).run('a2', '2026-06-01', '2026-06-01');
  const res = await app.fastify.inject({ method: 'DELETE', url: '/api/alerts/resolved' });
  expect(res.statusCode).toBe(204);
  const remaining = app.db.prepare(`SELECT id FROM alerts`).all() as Array<{id:string}>;
  expect(remaining.map((r) => r.id)).toEqual(['a2']);
});
```

- [ ] **Step 3: Run — verify failure**

Run: `pnpm --filter @vina/server test http/alerts`
Expected: FAIL.

- [ ] **Step 4: Add the route**

In `packages/server/src/http/routes/alerts.ts`:

```typescript
app.delete('/api/alerts/resolved', async (_req, reply) => {
  db.prepare(`DELETE FROM alerts WHERE status = 'resolved'`).run();
  return reply.status(204).send();
});
```

- [ ] **Step 5: Add "Clear resolved" button in Alerts page**

In `packages/web/src/routes/alerts/*.tsx`, locate the page header, add a button that calls `DELETE /api/alerts/resolved` and invalidates the alerts query.

- [ ] **Step 6: Tests pass + commit**

Run: `pnpm --filter @vina/server test http/alerts` and `pnpm --filter @vina/web test alerts`
Expected: PASS.

```bash
git add packages/server/src/http/routes/alerts.ts packages/server/tests/http/alerts.test.ts packages/web/src/routes/alerts
git commit -m "feat(server,web): DELETE /api/alerts/resolved + Clear resolved button"
```

---

## Phase 11 — Docs

### Task 11.1 — SPEC.md + ADR-023

**Files:**
- Modify: `SPEC.md`
- Modify: `docs/decisions.md`
- Modify: `docs/build-order.md` (note M15-followup status)

- [ ] **Step 1: Update SPEC.md**

Locate the Easy Apply section. Add a subsection describing the autonomous/manual mode, the gate semantics, the "literal evidence only" form-fill rule, the EEO hard-skip, the daily cap / throttle / freshness / circuit breaker, the dry-run safety net, and the Settings UI affordances. Replace any reference to `mode = autonomous | supervised` + `approval = …` with the new `easy_apply_mode` model.

- [ ] **Step 2: Add ADR-023**

In `docs/decisions.md`, add a new ADR entry. Cover:

- **Context.** M15 shipped autonomous Easy Apply primitives but never enabled autonomy end-to-end — the only autonomous branch in the score handler was for manual-apply jobs. Live testing produced six bugfix follow-ups in days; we needed a deliberate decision about whether and how to flip the autonomous-Easy-Apply switch.
- **Decision.**
  - Collapse `mode` × `approval` into a single `easy_apply_mode` setting; the existing complexity of "supervised + review-first" is replaced by an explicit mode choice with risk disclosure at activation.
  - Every path to `runApply` goes through a single gate function (cap, throttle, freshness, idempotency, circuit breaker).
  - The LLM form-fill rule tightens to "literal evidence or skip"; the resolver short-circuits EEO/demographic questions.
  - Persistent rate-limit state in `apply_rate_limit` powers daily cap, velocity throttle, and consecutive-failure circuit breaker.
  - Use the existing `profile_answers` SQLite table for saved screening answers; do **not** introduce a parallel `memory.md` store.
  - Dry-run mode lets the user observe gate behaviour before enabling submissions for real.
- **Consequences.**
  - Autonomous submissions are real and irreversible; we accept this under explicit user disclosure.
  - The circuit breaker means one bad LinkedIn cohort variant pauses autonomy automatically rather than burning the daily cap.
  - Memory is queryable, atomic, and editable via Settings — the markdown alternative gained nothing and lost atomicity.

- [ ] **Step 3: Update build-order.md**

Add a "M15-followup" note (or a new milestone) referencing this plan and the resulting commits. Mark the deferred autonomous-Easy-Apply work shipped.

- [ ] **Step 4: Commit**

```bash
git add SPEC.md docs/decisions.md docs/build-order.md
git commit -m "docs: autonomous Easy Apply — SPEC update + ADR-023 + build-order note"
```

---

## End-to-end smoke test (manual, no commit)

After all phases land, run the daemon and exercise the flow against the LinkedIn fixture site:

1. `pnpm dev` — server + web up.
2. Navigate to Settings. Toggle Easy Apply mode to autonomous. Confirm the risk dialog appears with the bullet list from the design.
3. Confirm the dialog. Tile reflects `autonomous`. EasyApplyCard appears on the dashboard.
4. Trigger a score on a known auto-apply fixture job above threshold. Watch the daemon logs:
   - `autonomous-mode: enqueued apply` from score handler
   - `apply skipped by gate` if any gate blocks
   - `apply task complete` with `outcome: 'submitted'`
5. Verify the dashboard count increments.
6. Force a circuit-breaker scenario: drop a fixture that always fails the submit step. Run 5 in a row. Confirm:
   - Settings flips to manual.
   - High-visibility alert appears: "Autonomous Easy Apply paused after consecutive failures".
   - The next autonomous score does NOT enqueue (mode is now manual).
7. Resolve a `missing_field` alert from the Alerts page with a value. Confirm:
   - The application re-enqueues.
   - The answer appears in the Settings → Saved screening answers tile.
   - Forgetting it from the tile removes it from `/api/profile-answers`.
8. Visit the Saved screening answers tile, click "Clear all" → Confirm. Reload the page; list is empty.

---

## Self-review notes

**Spec coverage check (against the conversation that led to this plan):**

| Requirement | Where addressed |
|---|---|
| Autonomous + manual modes with explicit toggle | Phase 1.2 (schema/types), Phase 7.1 (UI) |
| Risk disclosure on autonomous switch | Phase 7.1 — AutonomousRiskDialog |
| Daily cap (counts successful submissions) | Phase 2.1 + 4.2 + 3.1 |
| Velocity throttle | Phase 2.1 + 3.1 |
| Listing freshness cap | Phase 3.1 |
| Task-queue idempotency | Phase 3.1 |
| Consecutive-failure circuit breaker (N=5) | Phase 4.2 |
| Memory check first → CV literal → pause | Phase 5.1 (skill body) + Phase 5.2 (EEO short-circuit) |
| EEO/demographic hard skip | Phase 5.1 + 5.2 |
| Saved answers via `profile_answers` (not memory.md) | Phase 6 |
| Settings UI for saved answers | Phase 6.2 |
| JobCard Auto-apply button | Phase 8.3 |
| Autonomous score-handler hook | Phase 8.4 |
| Per-field source audit | Phase 5.3 |
| Daily summary on dashboard | Phase 9.2 |
| Kill switch on dashboard | Phase 9.2 |
| Dry-run mode | Phase 1.1 (schema) + Phase 7.1 (toggle) + Phase 4.1 (enforce) |
| task_queue prune | Phase 10.1 |
| Alerts "Clear resolved" | Phase 10.2 |
| SPEC + ADR-023 | Phase 11 |

**Deferred (tracked, not in v1):**
- a11y-tree-based `alreadyApplied()` (still selector-based)
- New-cohort observability (weekly unique-alert-description summary)
- Memory TTL / profile-change invalidation
- Time-of-day gating
- LinkedIn rate-limit response detection
- Submission evidence (screenshot on success)
- Multi-listing dedup (same job posted twice)

**Type consistency check:** the gate function exports `GateBlockReason`, `GateDecision`, `GateInput` and a helper `dayBucketFromIso`. These are imported by both the apply handler (Phase 4) and the score handler (Phase 8). The repository functions `getRateLimit`, `recordAttempt`, `recordSuccess`, `recordFailure`, `resetConsecutiveFailures` from Phase 2 are consumed by the apply handler (Phase 4) only. The enqueuer `enqueueEasyApplyForJob` (Phase 8.1) is consumed by the `/api/jobs/:id/apply` route (Phase 8.2) and the score handler (Phase 8.4). All names match across tasks.

**Placeholder scan:** every code block contains the actual implementation; no `TODO` or `// fill in` remains in any task body except for the deliberate Phase-7 placeholder in the temporary Settings-page cleanup (Task 1.4 Step 2) which is removed by Task 7.1 Step 5.
