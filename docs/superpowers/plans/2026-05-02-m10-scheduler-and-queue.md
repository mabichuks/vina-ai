# M10 — Scheduler and Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the daemon's scheduler + persistent task queue so cron schedules enqueue `search` tasks, the worker dispatches them by kind, and a `score` handler updates `jobs.match_score` automatically. M10 done-criterion: manually inserting a fake job triggers the score handler and updates the row's `match_score`; the system status route reflects real scheduler/queue state.

**Architecture:**

- The `task_queue` repository (`enqueue / claimNext / complete / fail / listPending / resetStaleRunning`) already exists with atomic claim semantics — the worker is a poll loop on top of it.
- A typed in-process event bus (`EventBus`) lives in `packages/server/src/events/bus.ts`. The worker, scheduler, and route handlers emit; the WebSocket gateway subscribes and forwards to clients.
- The worker maintains one `p-queue` per `TaskKind` for in-memory concurrency; persistence is the DB.
- The scheduler reads enabled `schedules` rows at boot, registers `node-cron` jobs, and on fire enqueues a `search` task for each enabled site. Live refresh on schedule mutations is **deferred** — schedule changes take effect at the next daemon restart.
- Two task handlers ship in M10: `search` (stub — emits a synthetic job for now) and `score` (calls the orchestrator). Other kinds (`tailor`, `apply`, `prepare_manual_apply`, `resume`) have no handler yet — the worker marks them `failed` with `unhandled_kind` until later milestones.

**Tech Stack:** TypeScript, `node-cron` (scheduler), `p-queue` (concurrency), `cron-parser` (already a dep, used to compute `next_run_at`), `better-sqlite3` (queue persistence), `@vina/orchestrator` (`runScoreJob`, `buildModel`).

---

## File Structure

| Path                                                              | Responsibility                                                                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/server/src/events/bus.ts`                               | Typed `EventBus` over Node's `EventEmitter`; emit/on/off honouring shared `EVENTS` and payloads      |
| `packages/server/src/queue/concurrency.ts`                        | Default per-kind concurrency limits                                                                  |
| `packages/server/src/queue/handlers/search.ts`                    | M10 stub `search` handler — synthesises one fake job and enqueues a `score` task for it              |
| `packages/server/src/queue/handlers/score.ts`                     | Real `score` handler — loads job/profile/prefs, calls orchestrator, updates `match_score` and status |
| `packages/server/src/queue/worker.ts`                             | Poll loop, dispatches by kind via per-kind `p-queue`, retry/backoff, lifecycle (start/stop/poke)     |
| `packages/server/src/scheduler/scheduler.ts`                      | Reads enabled `schedules`, registers `node-cron` jobs, persists `last_run_at` and `next_run_at`      |
| `packages/server/src/scheduler/cron.ts`                           | Pure helper: `nextRunAt(expr, from)` using `cron-parser`                                             |
| `packages/server/src/services/llm-service.ts` _(modify)_          | Add `getActiveChatModel(db)` — resolves active provider and returns a `BaseChatModel`                |
| `packages/server/src/main.ts` _(modify)_                          | Construct bus, worker, scheduler at boot; tear them down on shutdown                                 |
| `packages/server/src/app.ts` _(modify)_                           | Pass `bus` into `buildApp`; route handlers and WS gateway use it                                     |
| `packages/server/src/http/ws.ts` _(modify)_                       | Subscribe to bus events; forward each as a JSON envelope to all clients                              |
| `packages/server/src/http/routes/system.ts` _(modify)_            | Real queue counts (`pending`/`running`) and `next_run_at` from schedules                             |
| `packages/server/src/http/routes/schedules.ts` _(modify)_         | Compute `next_run_at` on insert/update                                                               |

---

## Task 1: Install runtime deps and add concurrency module

**Files:**
- Modify: `packages/server/package.json`
- Create: `packages/server/src/queue/concurrency.ts`

- [ ] **Step 1: Install `node-cron` and `p-queue`**

```bash
pnpm --filter @vina/server add node-cron p-queue
pnpm --filter @vina/server add -D @types/node-cron
```

- [ ] **Step 2: Verify deps landed**

Run: `grep -E '"(node-cron|p-queue)":' packages/server/package.json`
Expected: both packages listed under `dependencies`; `@types/node-cron` under `devDependencies`.

- [ ] **Step 3: Create the concurrency defaults module**

Write `packages/server/src/queue/concurrency.ts`:

```ts
import type { TaskKind } from '@vina/shared';

/**
 * Per-kind in-memory concurrency. The DB is still the source of truth for
 * persistence; these limits only govern how many same-kind tasks run in
 * parallel inside one daemon process.
 *
 * - `search`: 1 — keeps Playwright pressure per site predictable (we'll
 *   refine to per-site once browser-kind adapters land in M11)
 * - `score`: 4 — LLM-bound, batchable, network-friendly
 * - others: conservative until their handlers ship
 */
export const DEFAULT_CONCURRENCY: Record<TaskKind, number> = {
  search: 1,
  score: 4,
  tailor: 2,
  apply: 1,
  prepare_manual_apply: 2,
  resume: 1,
};
```

- [ ] **Step 4: Confirm typecheck still passes**

Run: `pnpm --filter @vina/server typecheck`
Expected: clean exit (the new module is a small leaf with no consumers yet).

- [ ] **Step 5: Commit**

```bash
git add packages/server/package.json packages/server/src/queue/concurrency.ts pnpm-lock.yaml
git commit -m "feat(server): add node-cron + p-queue deps and queue concurrency defaults"
```

---

## Task 2: Typed event bus

**Files:**
- Create: `packages/server/src/events/bus.ts`
- Test: `packages/server/tests/events/bus.test.ts`

- [ ] **Step 1: Write the failing test**

Write `packages/server/tests/events/bus.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createEventBus } from '../../src/events/bus.js';

describe('EventBus', () => {
  it('delivers a typed payload to subscribers and respects unsubscribe', () => {
    const bus = createEventBus();
    const received: Array<{ pending: number; running: number }> = [];
    const off = bus.on('queue:updated', (payload) => received.push(payload));

    bus.emit('queue:updated', { pending: 3, running: 1 });
    bus.emit('queue:updated', { pending: 0, running: 0 });
    expect(received).toEqual([
      { pending: 3, running: 1 },
      { pending: 0, running: 0 },
    ]);

    off();
    bus.emit('queue:updated', { pending: 9, running: 9 });
    expect(received).toHaveLength(2);
  });

  it('supports multiple subscribers per event', () => {
    const bus = createEventBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.on('jobs:updated', (p) => a.push(...p.ids));
    bus.on('jobs:updated', (p) => b.push(...p.ids));

    bus.emit('jobs:updated', { ids: ['j1', 'j2'] });
    expect(a).toEqual(['j1', 'j2']);
    expect(b).toEqual(['j1', 'j2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/server/tests/events/bus.test.ts`
Expected: FAIL with `Cannot find module '../../src/events/bus.js'`.

- [ ] **Step 3: Create the bus module**

Write `packages/server/src/events/bus.ts`:

```ts
import { EventEmitter } from 'node:events';
import type { EventName, EventPayloadFor } from '@vina/shared';

/**
 * Typed, in-process pub/sub. The shared `EVENTS` enum + `EventPayloadFor`
 * mapping mean emitting an unknown event name or wrong-shaped payload is a
 * type error.
 *
 * Subscribers are not async-aware: handlers should never throw — wrap
 * anything fallible in try/catch at the call site.
 */
export interface EventBus {
  emit<T extends EventName>(name: T, payload: EventPayloadFor<T>): void;
  on<T extends EventName>(name: T, handler: (payload: EventPayloadFor<T>) => void): () => void;
}

export function createEventBus(): EventBus {
  const ee = new EventEmitter();
  // Server has the WS gateway, the route handlers (bootstrap), and the
  // worker all subscribing — bump above the default 10 to silence warnings.
  ee.setMaxListeners(50);

  return {
    emit: (name, payload) => {
      ee.emit(name, payload);
    },
    on: (name, handler) => {
      ee.on(name, handler as (payload: unknown) => void);
      return () => {
        ee.off(name, handler as (payload: unknown) => void);
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/server/tests/events/bus.test.ts`
Expected: PASS, both tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/events/bus.ts packages/server/tests/events/bus.test.ts
git commit -m "feat(server): add typed in-process event bus"
```

---

## Task 3: `search` task handler (M10 stub)

**Files:**
- Create: `packages/server/src/queue/handlers/search.ts`
- Test: `packages/server/tests/queue/handlers/search.test.ts`

- [ ] **Step 1: Write the failing test**

Write `packages/server/tests/queue/handlers/search.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { listJobs } from '../../../src/db/repositories/jobs.js';
import { listPending } from '../../../src/db/repositories/task-queue.js';
import { createEventBus } from '../../../src/events/bus.js';
import { createSearchHandler } from '../../../src/queue/handlers/search.js';
import { closeTestDb, openTestDb } from '../../db/helpers.js';

let db: DatabaseType;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => {
  closeTestDb(db);
});

describe('search handler (M10 stub)', () => {
  it('inserts a synthetic job for the requested site and enqueues a score task', async () => {
    const bus = createEventBus();
    const handler = createSearchHandler({ db, bus });

    await handler({ site_id: 'linkedin' });

    const jobs = listJobs(db, { site_id: 'linkedin' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      site_id: 'linkedin',
      apply_method: 'auto',
      status: 'new',
    });

    const pending = listPending(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe('score');
    expect(JSON.parse(pending[0]!.payload)).toEqual({ job_id: jobs[0]!.id });
  });

  it('rejects unknown site ids', async () => {
    const handler = createSearchHandler({ db, bus: createEventBus() });
    await expect(handler({ site_id: 'unknown' })).rejects.toThrow(/site/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/server/tests/queue/handlers/search.test.ts`
Expected: FAIL — handler module does not exist.

- [ ] **Step 3: Implement the handler**

Write `packages/server/src/queue/handlers/search.ts`:

```ts
import type { Database as DatabaseType } from 'better-sqlite3';
import { createLogger, ValidationError, type SiteKind } from '@vina/shared';
import { findSiteById } from '../../db/repositories/sites.js';
import { insertJob } from '../../db/repositories/jobs.js';
import { enqueue } from '../../db/repositories/task-queue.js';
import type { EventBus } from '../../events/bus.js';

const log = createLogger('handler.search');

export interface SearchHandlerDeps {
  db: DatabaseType;
  bus: EventBus;
}

export interface SearchPayload {
  site_id: string;
}

/**
 * M10 stub. Real adapters land in M11 (LinkedIn), M12 (Indeed), and M13
 * (Google Jobs via SerpAPI). Until then, this handler synthesises a single
 * job per invocation so the rest of the pipeline (score, eventually tailor)
 * can be wired and tested end-to-end.
 *
 * The synthetic job has `apply_method='auto'` for browser-kind sites and
 * `'manual'` for api-kind sites, mirroring what the real adapters will do.
 */
export function createSearchHandler(
  deps: SearchHandlerDeps,
): (payload: SearchPayload) => Promise<void> {
  return async (payload) => {
    const site = findSiteById(deps.db, payload.site_id);
    if (!site) {
      throw new ValidationError(`Unknown site_id: ${payload.site_id}`);
    }

    const apply_method = site.kind === ('browser' satisfies SiteKind) ? 'auto' : 'manual';
    const externalId = `m10-stub-${Date.now()}`;

    const job = insertJob(deps.db, {
      site_id: site.id,
      external_id: externalId,
      url: `https://example.invalid/${site.id}/${externalId}`,
      apply_method,
      title: 'Senior Software Engineer (synthetic)',
      company: 'Example Corp',
      location: 'Remote',
      description:
        'Synthetic listing emitted by the M10 search-handler stub so the score pipeline can be tested. Real listings land with the M11+ adapters.',
    });

    enqueue(deps.db, { kind: 'score', payload: { job_id: job.id } });
    deps.bus.emit('jobs:updated', { ids: [job.id] });
    log.info({ site: site.id, job_id: job.id }, 'synthesised stub job for M10');
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/server/tests/queue/handlers/search.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/queue/handlers/search.ts packages/server/tests/queue/handlers/search.test.ts
git commit -m "feat(server): add M10 stub search task handler"
```

---

## Task 4: `score` task handler

**Files:**
- Modify: `packages/server/src/services/llm-service.ts` — add `getActiveChatModel`
- Create: `packages/server/src/queue/handlers/score.ts`
- Test: `packages/server/tests/queue/handlers/score.test.ts`

- [ ] **Step 1: Add `getActiveChatModel` to the LLM service**

In `packages/server/src/services/llm-service.ts`, add (preserving existing imports):

```ts
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { buildModel } from '@vina/orchestrator';
import { ConflictError } from '@vina/shared';
import { getOrInitSettings } from '../db/repositories/settings.js';

// ... existing code ...

/**
 * Resolves the user-selected active LLM provider, decrypts its key, and
 * returns a configured LangChain chat model. Throws ConflictError if no
 * provider is selected (a clear "configure provider first" UX) or
 * NotFoundError if the selected id has been deleted under us.
 */
export async function getActiveChatModel(db: DatabaseType): Promise<BaseChatModel> {
  const settings = getOrInitSettings(db);
  if (!settings.active_llm_provider_id) {
    throw new ConflictError('No active LLM provider configured');
  }
  const row = findLlmProviderById(db, settings.active_llm_provider_id);
  if (!row) {
    throw new NotFoundError(`Active LLM provider ${settings.active_llm_provider_id} not found`);
  }
  const apiKey = row.encrypted_api_key ? decrypt(row.encrypted_api_key) : null;
  return buildModel({
    kind: row.kind,
    model: row.model,
    ...(apiKey !== null && { apiKey }),
    ...(row.base_url !== null && { baseUrl: row.base_url }),
  });
}
```

- [ ] **Step 2: Write the failing handler test**

Write `packages/server/tests/queue/handlers/score.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { ScoreMessages, StructuredScorer } from '@vina/orchestrator';
import { ScoreSchema } from '@vina/orchestrator';
import { findJobById, insertJob } from '../../../src/db/repositories/jobs.js';
import { insertProfile } from '../../../src/db/repositories/profile.js';
import { upsertSearchPreferences } from '../../../src/db/repositories/search-preferences.js';
import { createEventBus } from '../../../src/events/bus.js';
import { createScoreHandler } from '../../../src/queue/handlers/score.js';
import { closeTestDb, openTestDb } from '../../db/helpers.js';

function fakeScorer(score: number, justification = 'fake'): StructuredScorer {
  return {
    withStructuredOutput: () => ({
      invoke: async (_messages: ScoreMessages) => {
        ScoreSchema.parse({ score, justification }); // sanity
        return { score, justification };
      },
    }) as never,
  };
}

let db: DatabaseType;
beforeEach(() => {
  db = openTestDb();
  insertProfile(db, { full_name: 'Ada Lovelace', email: 'ada@x.com', bio: 'Engineer' });
  upsertSearchPreferences(db, {
    description: 'TS backend',
    keywords: ['typescript'],
    locations: ['Remote'],
    work_models: ['remote'],
    seniority: ['senior'],
    excluded_companies: [],
  });
});
afterEach(() => closeTestDb(db));

describe('score handler', () => {
  it('writes match_score + justification and transitions status to scored', async () => {
    const job = insertJob(db, {
      site_id: 'linkedin',
      external_id: 'ext1',
      url: 'https://x',
      apply_method: 'auto',
      title: 'Senior TS Engineer',
      company: 'Acme',
      description: 'TS backend role',
    });

    const handler = createScoreHandler({
      db,
      bus: createEventBus(),
      buildModel: async () => fakeScorer(82, 'Strong title and skill match'),
    });

    await handler({ job_id: job.id });

    const fresh = findJobById(db, job.id);
    expect(fresh?.match_score).toBe(82);
    expect(fresh?.match_justification).toBe('Strong title and skill match');
    expect(fresh?.status).toBe('scored');
  });

  it('clamps + rounds out-of-range model output before persisting', async () => {
    const job = insertJob(db, {
      site_id: 'linkedin',
      external_id: 'ext2',
      url: 'https://x',
      apply_method: 'auto',
      title: 'Junior dev',
      company: 'Acme',
      description: 'Junior',
    });

    const handler = createScoreHandler({
      db,
      bus: createEventBus(),
      buildModel: async () => fakeScorer(150, 'over'),
    });

    await handler({ job_id: job.id });
    expect(findJobById(db, job.id)?.match_score).toBe(100);
  });

  it('throws if the job no longer exists', async () => {
    const handler = createScoreHandler({
      db,
      bus: createEventBus(),
      buildModel: async () => fakeScorer(50),
    });
    await expect(handler({ job_id: 'missing' })).rejects.toThrow(/missing/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/server/tests/queue/handlers/score.test.ts`
Expected: FAIL — handler module does not exist.

- [ ] **Step 4: Implement the handler**

Write `packages/server/src/queue/handlers/score.ts`:

```ts
import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { runScoreJob, type ScoreInput } from '@vina/orchestrator';
import { createLogger, NotFoundError } from '@vina/shared';
import { findJobById, updateJobScore, updateJobStatus } from '../../db/repositories/jobs.js';
import { findProfile } from '../../db/repositories/profile.js';
import { getOrInitSearchPreferences } from '../../db/repositories/search-preferences.js';
import type { EventBus } from '../../events/bus.js';

const log = createLogger('handler.score');

export interface ScoreHandlerDeps {
  db: DatabaseType;
  bus: EventBus;
  /**
   * Factory rather than a singleton because the active provider can change
   * between task runs (the user may pick a different provider mid-session).
   */
  buildModel: () => Promise<BaseChatModel>;
}

export interface ScorePayload {
  job_id: string;
}

export function createScoreHandler(
  deps: ScoreHandlerDeps,
): (payload: ScorePayload) => Promise<void> {
  return async (payload) => {
    const job = findJobById(deps.db, payload.job_id);
    if (!job) throw new NotFoundError(`Job ${payload.job_id} not found`);

    const profile = findProfile(deps.db);
    if (!profile) throw new NotFoundError('Profile not configured — cannot score');

    const prefs = getOrInitSearchPreferences(deps.db);

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
      prefs: {
        description: prefs.description,
        keywords: prefs.keywords,
        locations: prefs.locations,
        work_models: prefs.work_models,
        seniority: prefs.seniority,
        excluded_companies: prefs.excluded_companies,
      },
    };

    const model = await deps.buildModel();
    const result = await runScoreJob(input, model);

    updateJobScore(deps.db, job.id, result.score, result.justification);
    updateJobStatus(deps.db, job.id, 'scored');
    deps.bus.emit('jobs:updated', { ids: [job.id] });
    log.info({ job_id: job.id, score: result.score }, 'job scored');
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/tests/queue/handlers/score.test.ts packages/server/tests/services/llm-service.test.ts`
Expected: PASS — three new score-handler cases plus existing llm-service tests.

If `getOrInitSearchPreferences` doesn't already exist on the search-preferences repo, add it analogously to `getOrInitSettings` (read-or-init pattern). If `upsertSearchPreferences` doesn't exist, use whichever `PUT` route helper does — open `packages/server/src/db/repositories/search-preferences.ts` and adapt the test.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/queue/handlers/score.ts \
        packages/server/src/services/llm-service.ts \
        packages/server/tests/queue/handlers/score.test.ts
git commit -m "feat(server): add score task handler that calls the orchestrator"
```

---

## Task 5: Worker (poll loop, dispatch, retry/backoff)

**Files:**
- Create: `packages/server/src/queue/worker.ts`
- Test: `packages/server/tests/queue/worker.test.ts`

- [ ] **Step 1: Write the failing test**

Write `packages/server/tests/queue/worker.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { enqueue, listPending } from '../../src/db/repositories/task-queue.js';
import { createEventBus } from '../../src/events/bus.js';
import { createWorker, type TaskHandlers } from '../../src/queue/worker.js';
import { closeTestDb, openTestDb } from '../db/helpers.js';

let db: DatabaseType;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => closeTestDb(db));

function harness(handlers: Partial<TaskHandlers>) {
  return createWorker({
    db,
    bus: createEventBus(),
    handlers: {
      search: handlers.search ?? (async () => undefined),
      score: handlers.score ?? (async () => undefined),
    } as TaskHandlers,
    pollIntervalMs: 5,
  });
}

describe('worker', () => {
  it('claims a pending task, runs the handler, and marks it completed', async () => {
    const handler = vi.fn(async () => undefined);
    const worker = harness({ score: handler });
    enqueue(db, { kind: 'score', payload: { job_id: 'j1' } });

    worker.start();
    worker.poke();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1), { timeout: 1_000 });
    await worker.stop();

    expect(listPending(db)).toHaveLength(0);
  });

  it('retries on handler failure with backoff until max_attempts, then marks failed', async () => {
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    const worker = harness({ score: handler });
    enqueue(db, { kind: 'score', payload: {}, max_attempts: 2 });

    worker.start();
    await vi.waitFor(
      () => {
        // Two attempts, then the row stays in `failed` (out of pending).
        const failedRow = db
          .prepare(`SELECT status, attempts, failed_reason FROM task_queue`)
          .get() as { status: string; attempts: number; failed_reason: string | null };
        expect(failedRow.status).toBe('failed');
        expect(failedRow.attempts).toBe(2);
        expect(failedRow.failed_reason).toMatch(/boom/);
      },
      { timeout: 5_000, interval: 50 },
    );
    await worker.stop();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('marks tasks of unknown kind as failed without retry', async () => {
    const worker = harness({});
    enqueue(db, { kind: 'tailor', payload: {} }); // no handler in M10
    worker.start();
    await vi.waitFor(
      () => {
        const row = db.prepare(`SELECT status, failed_reason FROM task_queue`).get() as {
          status: string;
          failed_reason: string | null;
        };
        expect(row.status).toBe('failed');
        expect(row.failed_reason).toMatch(/unhandled_kind/);
      },
      { timeout: 1_000 },
    );
    await worker.stop();
  });

  it('emits queue:updated after each transition', async () => {
    const bus = createEventBus();
    const counts: Array<{ pending: number; running: number }> = [];
    bus.on('queue:updated', (p) => counts.push(p));

    const worker = createWorker({
      db,
      bus,
      handlers: {
        search: async () => undefined,
        score: async () => undefined,
        tailor: async () => undefined,
        apply: async () => undefined,
        prepare_manual_apply: async () => undefined,
        resume: async () => undefined,
      },
      pollIntervalMs: 5,
    });
    enqueue(db, { kind: 'score', payload: {} });
    worker.start();
    await vi.waitFor(() => expect(counts.some((c) => c.pending === 0)).toBe(true), {
      timeout: 1_000,
    });
    await worker.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/server/tests/queue/worker.test.ts`
Expected: FAIL — worker module does not exist.

- [ ] **Step 3: Implement the worker**

Write `packages/server/src/queue/worker.ts`:

```ts
import PQueue from 'p-queue';
import type { Database as DatabaseType } from 'better-sqlite3';
import { createLogger, type Task, type TaskKind } from '@vina/shared';
import {
  claimNext,
  complete,
  fail,
  listPending,
} from '../db/repositories/task-queue.js';
import type { EventBus } from '../events/bus.js';
import { DEFAULT_CONCURRENCY } from './concurrency.js';

const log = createLogger('worker');

/** A handler is any async function from a parsed payload to nothing. */
export type TaskHandler<P = unknown> = (payload: P) => Promise<void>;
export type TaskHandlers = Record<TaskKind, TaskHandler>;

export interface WorkerOptions {
  db: DatabaseType;
  bus: EventBus;
  handlers: TaskHandlers;
  /** Poll cadence when idle. Defaults to 1000ms. */
  pollIntervalMs?: number;
  /** Override concurrency per kind (sparse map). */
  concurrency?: Partial<Record<TaskKind, number>>;
}

export interface WorkerHandle {
  start(): void;
  /** Wake the loop immediately (skip the next poll wait). */
  poke(): void;
  /**
   * Stop polling and wait up to `timeoutMs` for in-flight tasks to drain.
   * Idempotent.
   */
  stop(timeoutMs?: number): Promise<void>;
}

const BACKOFF_MS = [30_000, 60_000, 120_000];

function nextAttemptAtIso(attempts: number): string {
  const idx = Math.min(attempts - 1, BACKOFF_MS.length - 1);
  // Negative index would be an internal bug, but guard cheaply.
  const ms = idx < 0 ? BACKOFF_MS[0]! : BACKOFF_MS[idx]!;
  return new Date(Date.now() + ms).toISOString();
}

function emitCounts(db: DatabaseType, bus: EventBus): void {
  const pending = listPending(db).length;
  const running = (
    db.prepare(`SELECT COUNT(*) AS n FROM task_queue WHERE status = 'running'`).get() as {
      n: number;
    }
  ).n;
  bus.emit('queue:updated', { pending, running });
}

export function createWorker(options: WorkerOptions): WorkerHandle {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const queues = new Map<TaskKind, PQueue>();
  const KINDS: TaskKind[] = [
    'search',
    'score',
    'tailor',
    'apply',
    'prepare_manual_apply',
    'resume',
  ];
  for (const kind of KINDS) {
    queues.set(
      kind,
      new PQueue({ concurrency: options.concurrency?.[kind] ?? DEFAULT_CONCURRENCY[kind] }),
    );
  }

  let timer: NodeJS.Timeout | null = null;
  let stopping = false;

  async function runOne(task: Task): Promise<void> {
    const handler = options.handlers[task.kind];
    if (!handler) {
      fail(options.db, task.id, 'unhandled_kind', false);
      emitCounts(options.db, options.bus);
      return;
    }
    try {
      const payload: unknown = JSON.parse(task.payload);
      await handler(payload);
      complete(options.db, task.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const willRetry = task.attempts < task.max_attempts;
      if (willRetry) {
        // `fail(..., retry=true)` flips the row back to `pending`. Push the
        // next-attempt time forward so we don't busy-loop on a flaky task.
        fail(options.db, task.id, reason, true);
        options.db
          .prepare(`UPDATE task_queue SET next_attempt_at = ? WHERE id = ?`)
          .run(nextAttemptAtIso(task.attempts), task.id);
      } else {
        fail(options.db, task.id, reason, false);
      }
      log.warn({ task_id: task.id, kind: task.kind, attempts: task.attempts, err }, 'task failed');
    }
    emitCounts(options.db, options.bus);
  }

  async function tick(): Promise<void> {
    // Drain up to N tasks per tick — N higher than total concurrency so each
    // p-queue can fill its lanes. The atomic claim in the repo ensures we
    // never double-process even if a poke arrived mid-tick.
    const totalCap = [...queues.values()].reduce((acc, q) => acc + q.concurrency, 0);
    for (let i = 0; i < totalCap * 2; i++) {
      const task = claimNext(options.db);
      if (!task) break;
      const q = queues.get(task.kind);
      if (!q) {
        fail(options.db, task.id, 'unhandled_kind', false);
        continue;
      }
      void q.add(() => runOne(task));
    }
    emitCounts(options.db, options.bus);
  }

  function scheduleNext(delay: number): void {
    if (stopping) return;
    timer = setTimeout(() => {
      tick()
        .catch((err: unknown) => log.error({ err }, 'tick threw'))
        .finally(() => scheduleNext(pollIntervalMs));
    }, delay);
  }

  return {
    start(): void {
      if (timer || stopping) return;
      scheduleNext(0);
    },
    poke(): void {
      if (stopping) return;
      if (timer) clearTimeout(timer);
      scheduleNext(0);
    },
    async stop(timeoutMs = 30_000): Promise<void> {
      stopping = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const drained = Promise.all([...queues.values()].map((q) => q.onIdle()));
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref());
      await Promise.race([drained, timeout]);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/tests/queue/worker.test.ts`
Expected: PASS — all four cases.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/queue/worker.ts packages/server/tests/queue/worker.test.ts
git commit -m "feat(server): add task-queue worker with retry/backoff and per-kind concurrency"
```

---

## Task 6: Cron helper + scheduler

**Files:**
- Create: `packages/server/src/scheduler/cron.ts`
- Create: `packages/server/src/scheduler/scheduler.ts`
- Test: `packages/server/tests/scheduler/cron.test.ts`
- Test: `packages/server/tests/scheduler/scheduler.test.ts`

- [ ] **Step 1: Write failing tests for the cron helper**

Write `packages/server/tests/scheduler/cron.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextRunAt } from '../../src/scheduler/cron.js';

describe('nextRunAt', () => {
  it('returns the next ISO timestamp after the reference time', () => {
    const ref = new Date('2026-05-02T12:00:00Z');
    // every day at 18:00 UTC
    const next = nextRunAt('0 18 * * *', ref);
    expect(next).toBe('2026-05-02T18:00:00.000Z');
  });

  it('throws on a syntactically invalid expression', () => {
    expect(() => nextRunAt('not a cron', new Date())).toThrow();
  });
});
```

- [ ] **Step 2: Implement the cron helper**

Write `packages/server/src/scheduler/cron.ts`:

```ts
import { CronExpressionParser } from 'cron-parser';

/**
 * Compute the next firing time for a cron expression, formatted as an ISO
 * UTC timestamp. Used both by the scheduler (after a fire) and by the
 * schedule-route handlers (on insert/update) so the DB always reflects the
 * canonical next time.
 *
 * Throws if the expression is invalid — the route layer validates the same
 * way before persisting, so this is a defensive check.
 */
export function nextRunAt(expression: string, from: Date = new Date()): string {
  const it = CronExpressionParser.parse(expression, { currentDate: from });
  return it.next().toDate().toISOString();
}
```

- [ ] **Step 3: Run cron-helper tests**

Run: `pnpm vitest run packages/server/tests/scheduler/cron.test.ts`
Expected: PASS, both cases.

- [ ] **Step 4: Write failing scheduler tests**

Write `packages/server/tests/scheduler/scheduler.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { insertSchedule } from '../../src/db/repositories/schedules.js';
import { updateSiteEnabled } from '../../src/db/repositories/sites.js';
import { listPending } from '../../src/db/repositories/task-queue.js';
import { createEventBus } from '../../src/events/bus.js';
import { createScheduler } from '../../src/scheduler/scheduler.js';
import { closeTestDb, openTestDb } from '../db/helpers.js';

let db: DatabaseType;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => closeTestDb(db));

describe('scheduler', () => {
  it('on fire, enqueues a search task per enabled site and updates last/next_run_at', async () => {
    updateSiteEnabled(db, 'linkedin', true);
    updateSiteEnabled(db, 'indeed', true);
    // google stays disabled
    const schedule = insertSchedule(db, { cron_expression: '0 0 * * *' });

    const sched = createScheduler({ db, bus: createEventBus(), poke: () => undefined });
    // Synthetic fire — bypasses node-cron timing
    sched.fireNow(schedule.id);

    const pending = listPending(db);
    expect(pending.map((t) => t.kind)).toEqual(['search', 'search']);
    const sites = pending.map((t) => JSON.parse(t.payload).site_id).sort();
    expect(sites).toEqual(['indeed', 'linkedin']);

    const refreshed = db
      .prepare(`SELECT last_run_at, next_run_at FROM schedules WHERE id = ?`)
      .get(schedule.id) as { last_run_at: string | null; next_run_at: string | null };
    expect(refreshed.last_run_at).toMatch(/^\d{4}-/);
    expect(refreshed.next_run_at).toMatch(/^\d{4}-/);
  });

  it('skips disabled schedules at boot', () => {
    insertSchedule(db, { cron_expression: '* * * * *', enabled: false });
    const sched = createScheduler({ db, bus: createEventBus(), poke: () => undefined });
    sched.start();
    expect(sched.activeJobCount()).toBe(0);
    sched.stop();
  });

  it('pokes the worker on fire so tasks run promptly', () => {
    updateSiteEnabled(db, 'linkedin', true);
    const schedule = insertSchedule(db, { cron_expression: '0 0 * * *' });

    const poke = vi.fn();
    const sched = createScheduler({ db, bus: createEventBus(), poke });
    sched.fireNow(schedule.id);

    expect(poke).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 5: Run scheduler tests to verify they fail**

Run: `pnpm vitest run packages/server/tests/scheduler/scheduler.test.ts`
Expected: FAIL — scheduler module does not exist.

- [ ] **Step 6: Implement the scheduler**

Write `packages/server/src/scheduler/scheduler.ts`:

```ts
import cron, { type ScheduledTask } from 'node-cron';
import type { Database as DatabaseType } from 'better-sqlite3';
import { createLogger } from '@vina/shared';
import {
  findScheduleById,
  listSchedules,
  updateSchedule,
} from '../db/repositories/schedules.js';
import { listSites } from '../db/repositories/sites.js';
import { enqueue } from '../db/repositories/task-queue.js';
import type { EventBus } from '../events/bus.js';
import { nextRunAt } from './cron.js';

const log = createLogger('scheduler');

export interface SchedulerOptions {
  db: DatabaseType;
  bus: EventBus;
  /** Called after enqueuing tasks so the worker wakes immediately. */
  poke: () => void;
}

export interface SchedulerHandle {
  start(): void;
  stop(): void;
  /** Test seam — synthesise a fire without waiting for cron to tick. */
  fireNow(scheduleId: string): void;
  /** Test/inspection helper — count of active node-cron jobs. */
  activeJobCount(): number;
}

export function createScheduler(options: SchedulerOptions): SchedulerHandle {
  const jobs = new Map<string, ScheduledTask>();

  function fire(scheduleId: string): void {
    const schedule = findScheduleById(options.db, scheduleId);
    if (!schedule) {
      log.warn({ scheduleId }, 'fire on missing schedule');
      return;
    }
    const enabledSites = listSites(options.db).filter((s) => s.enabled);
    if (enabledSites.length === 0) {
      log.info({ scheduleId }, 'no enabled sites; skipping fire');
    }
    for (const site of enabledSites) {
      enqueue(options.db, { kind: 'search', payload: { site_id: site.id } });
    }
    const now = new Date().toISOString();
    updateSchedule(options.db, scheduleId, {
      last_run_at: now,
      next_run_at: nextRunAt(schedule.cron_expression, new Date(now)),
    });
    options.bus.emit('queue:updated', { pending: -1, running: -1 });
    options.poke();
  }

  return {
    start(): void {
      for (const schedule of listSchedules(options.db)) {
        if (!schedule.enabled) continue;
        if (!cron.validate(schedule.cron_expression)) {
          log.error({ scheduleId: schedule.id, expr: schedule.cron_expression }, 'invalid cron');
          continue;
        }
        const task = cron.schedule(schedule.cron_expression, () => fire(schedule.id));
        jobs.set(schedule.id, task);
        log.info({ scheduleId: schedule.id, expr: schedule.cron_expression }, 'registered cron');
      }
    },
    stop(): void {
      for (const [, task] of jobs) task.stop();
      jobs.clear();
    },
    fireNow(scheduleId: string): void {
      fire(scheduleId);
    },
    activeJobCount(): number {
      return jobs.size;
    },
  };
}
```

- [ ] **Step 7: Run all scheduler tests**

Run: `pnpm vitest run packages/server/tests/scheduler/`
Expected: PASS — five total cases (two cron helper + three scheduler).

> Note on the bus emit inside `fire()`: the `{ pending: -1, running: -1 }` payload is a placeholder so the type-check passes; the worker emits real counts after each transition. If the test in Task 5 step 1 already pins exact `queue:updated` shapes, change this emit to compute counts via `listPending(db).length` and the running-count query (lift to a shared helper) — see Task 5 `emitCounts` and reuse.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/scheduler packages/server/tests/scheduler
git commit -m "feat(server): add scheduler that registers node-cron jobs and enqueues search tasks"
```

---

## Task 7: Wire bus + worker + scheduler into bootServer; WS gateway forwards events

**Files:**
- Modify: `packages/server/src/main.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/http/ws.ts`
- Test: `packages/server/tests/integration/server.smoke.test.ts` (extend existing)

- [ ] **Step 1: Extend `app.ts` to accept and propagate the bus**

Modify `packages/server/src/app.ts`:

```ts
// Add to BuildAppDeps
export interface BuildAppDeps {
  db: DatabaseType;
  config: ServerConfig;
  version: string;
  startedAt: string;
  bus: EventBus; // NEW
}
```

Pass `bus` into `registerWebSocket(app, deps.config, deps.bus)`.

- [ ] **Step 2: Modify the WS gateway to forward bus events**

Rewrite the body of `registerWebSocket` in `packages/server/src/http/ws.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { createLogger, EVENTS, type EventName } from '@vina/shared';
import type { ServerConfig } from '../config.js';
import type { EventBus } from '../events/bus.js';

const log = createLogger('ws');

export async function registerWebSocket(
  app: FastifyInstance,
  config: ServerConfig,
  bus: EventBus,
): Promise<void> {
  await app.register(websocket);

  // Track connected sockets so bus events can fan out.
  const sockets = new Set<import('ws').WebSocket>();

  // Subscribe once per event name. Subscribers stay alive for the
  // process lifetime — the bus is owned by main.ts.
  for (const name of Object.values(EVENTS) as EventName[]) {
    bus.on(name, (payload) => {
      const envelope = JSON.stringify({ type: name, payload, timestamp: new Date().toISOString() });
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) socket.send(envelope);
      }
    });
  }

  app.get('/ws', { websocket: true }, (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (token !== config.bearerToken) {
      socket.close(4401, 'unauthorized');
      return;
    }

    sockets.add(socket);
    log.debug({ ip: req.ip }, 'ws client connected');

    socket.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as { type?: unknown };
        if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      } catch {
        // ignore malformed frames
      }
    });

    socket.on('close', () => {
      sockets.delete(socket);
      log.debug('ws client disconnected');
    });
  });
}
```

- [ ] **Step 3: Construct bus + worker + scheduler in `main.ts`**

Modify the body of `bootServer` in `packages/server/src/main.ts` so the boot sequence becomes:

```ts
const db = getDb({ filename: path.join(config.dataDir, 'vina.db') });
migrate(db, { migrationsDir: MIGRATIONS_DIR });
await initVault(config.dataDir);

// Recover from a hard crash mid-task — anything left `running` returns to
// `pending`. Idempotent on a clean shutdown.
const stale = resetStaleRunning(db);
if (stale > 0) log.warn({ count: stale }, 'reset stale running tasks at boot');

const bus = createEventBus();

const handlers: TaskHandlers = {
  search: createSearchHandler({ db, bus }),
  score: createScoreHandler({
    db,
    bus,
    buildModel: () => getActiveChatModel(db),
  }),
  // Other kinds intentionally unhandled — worker marks them failed with `unhandled_kind`
  // until M14+. Cast keeps the strict-record type happy.
  tailor: async () => undefined,
  apply: async () => undefined,
  prepare_manual_apply: async () => undefined,
  resume: async () => undefined,
};

const worker = createWorker({ db, bus, handlers });
const scheduler = createScheduler({ db, bus, poke: () => worker.poke() });

const startedAt = new Date().toISOString();
const app = await buildApp({ db, config, version, startedAt, bus });

const address = await app.listen({ port: config.port, host: '127.0.0.1' });
const port = Number.parseInt(new URL(address).port, 10);
writeStatusFile(config, port, version);

worker.start();
scheduler.start();

log.info({ port, url: address, version }, 'ready');

const shutdown = async (): Promise<void> => {
  scheduler.stop();
  await worker.stop();
  await app.close();
  closeDb();
  deleteStatusFile(config);
};
```

Add the imports:

```ts
import { resetStaleRunning } from './db/repositories/task-queue.js';
import { createEventBus } from './events/bus.js';
import { createSearchHandler } from './queue/handlers/search.js';
import { createScoreHandler } from './queue/handlers/score.js';
import { createWorker, type TaskHandlers } from './queue/worker.js';
import { createScheduler } from './scheduler/scheduler.js';
import { getActiveChatModel } from './services/llm-service.js';
```

- [ ] **Step 4: Update the existing server-smoke integration test**

Open `packages/server/tests/integration/server.smoke.test.ts`. After the existing assertions, add:

```ts
it('boot wires up worker and scheduler without throwing', async () => {
  // The fact that `bootServer()` returned without error and the
  // `/api/system/status` route below responds is the assertion. We don't
  // exercise actual task execution here — that's covered by Task 9.
  const res = await fetch(`${url}/api/system/status`, {
    headers: { authorization: `Bearer ${booted.config.bearerToken}` },
  });
  expect(res.status).toBe(200);
});
```

(If the existing smoke test already covers the boot path, you can skip this — the goal is just to confirm we didn't break startup.)

- [ ] **Step 5: Run the full server suite**

Run: `pnpm --filter @vina/server test`
Expected: PASS — all existing 130+ tests plus the M10 additions.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/main.ts packages/server/src/app.ts packages/server/src/http/ws.ts \
        packages/server/tests/integration/server.smoke.test.ts
git commit -m "feat(server): wire event bus, worker, and scheduler into boot/shutdown; WS forwards bus events"
```

---

## Task 8: System status route returns real queue + scheduler state

**Files:**
- Modify: `packages/server/src/http/routes/system.ts`
- Test: `packages/server/tests/http/api.test.ts` (extend existing system-status test)

- [ ] **Step 1: Update the failing assertion in the existing test**

Open `packages/server/tests/http/api.test.ts`. Find the `GET /api/system/status` test. Add assertions for the new shape:

```ts
it('GET /api/system/status returns the documented shape with all three sources', async () => {
  // ... existing setup ...
  const json = res.json();

  // NEW assertions
  expect(json.scheduler).toMatchObject({
    running: expect.any(Boolean),
  });
  // next_run_at is null until a schedule fires (no schedules in the test fixture)
  expect(json.scheduler.next_run_at === null || typeof json.scheduler.next_run_at === 'string').toBe(true);
  expect(json.queue).toMatchObject({
    pending: expect.any(Number),
    running: expect.any(Number),
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (or passes if loosely-typed)**

Run: `pnpm vitest run packages/server/tests/http/api.test.ts`
Expected: FAIL (or PASS if the test is already loose) — drive the next step regardless.

- [ ] **Step 3: Update the system-status handler**

In `packages/server/src/http/routes/system.ts`, replace the `/api/system/status` body. Add imports:

```ts
import { listSchedules } from '../../db/repositories/schedules.js';
import { nextRunAt } from '../../scheduler/cron.js';
```

Replace the handler:

```ts
app.get('/api/system/status', async () => {
  const settings = getOrInitSettings(db);
  const provider = settings.active_llm_provider_id
    ? findLlmProviderById(db, settings.active_llm_provider_id)
    : null;

  const pending = listPending(db).length;
  const running = (
    db.prepare(`SELECT COUNT(*) AS n FROM task_queue WHERE status = 'running'`).get() as {
      n: number;
    }
  ).n;

  // The earliest next_run_at across all enabled schedules is the system's
  // overall "next run" — or null when nothing is scheduled.
  const enabled = listSchedules(db).filter((s) => s.enabled);
  let earliest: string | null = null;
  for (const s of enabled) {
    const next = s.next_run_at ?? nextRunAt(s.cron_expression);
    if (earliest === null || next < earliest) earliest = next;
  }

  return {
    version,
    started_at: startedAt,
    scheduler: { running: !settings.paused, next_run_at: earliest },
    queue: { pending, running },
    active_provider: provider ? { kind: provider.kind, model: provider.model } : null,
    sources: listSites(db).map((s) => ({
      id: s.id,
      kind: s.kind,
      enabled: s.enabled,
      ok: s.kind === 'browser' ? s.session_valid_at !== null : null,
    })),
  };
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/server/tests/http/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/routes/system.ts packages/server/tests/http/api.test.ts
git commit -m "feat(server): system status returns real queue counts and earliest next_run_at"
```

---

## Task 9: Schedule routes persist `next_run_at` on insert/update

**Files:**
- Modify: `packages/server/src/http/routes/schedules.ts`
- Test: `packages/server/tests/http/schedules.test.ts` (extend)

- [ ] **Step 1: Add an assertion to the existing schedules test**

Open `packages/server/tests/http/schedules.test.ts`. After a successful POST, add:

```ts
expect(typeof body.next_run_at).toBe('string');
expect(body.next_run_at && body.next_run_at > new Date().toISOString()).toBe(true);
```

After a successful PATCH that changes the cron expression, assert `next_run_at` was recomputed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/tests/http/schedules.test.ts`
Expected: FAIL — current routes leave `next_run_at` null.

- [ ] **Step 3: Update the routes**

In `packages/server/src/http/routes/schedules.ts`, modify the POST and PATCH handlers to compute and persist `next_run_at`:

```ts
import { nextRunAt } from '../../scheduler/cron.js';

// ...

app.post('/api/schedules', async (req) => {
  const input = parse(CreateScheduleSchema, req.body);
  assertValidCron(input.cron_expression);
  const created = insertSchedule(db, input);
  return updateSchedule(db, created.id, {
    next_run_at: nextRunAt(input.cron_expression),
  });
});

app.patch('/api/schedules/:id', async (req) => {
  const { id } = parse(IdParamsSchema, req.params, 'route params');
  const input = parse(UpdateScheduleSchema, req.body);
  if (input.cron_expression) assertValidCron(input.cron_expression);
  const patch = {
    ...input,
    ...(input.cron_expression && { next_run_at: nextRunAt(input.cron_expression) }),
  };
  return updateSchedule(db, id, patch);
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/server/tests/http/schedules.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http/routes/schedules.ts packages/server/tests/http/schedules.test.ts
git commit -m "feat(server): persist schedules.next_run_at on insert and cron change"
```

---

## Task 10: End-to-end integration test — fake job → score → match_score updated

**Files:**
- Create: `packages/server/tests/integration/m10-pipeline.test.ts`

- [ ] **Step 1: Write the integration test**

Write `packages/server/tests/integration/m10-pipeline.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { ScoreMessages, StructuredScorer } from '@vina/orchestrator';
import { findJobById, insertJob } from '../../src/db/repositories/jobs.js';
import { insertProfile } from '../../src/db/repositories/profile.js';
import { upsertSearchPreferences } from '../../src/db/repositories/search-preferences.js';
import { enqueue } from '../../src/db/repositories/task-queue.js';
import { createEventBus } from '../../src/events/bus.js';
import { createSearchHandler } from '../../src/queue/handlers/search.js';
import { createScoreHandler } from '../../src/queue/handlers/score.js';
import { createWorker } from '../../src/queue/worker.js';
import { closeTestDb, openTestDb } from '../db/helpers.js';

function fakeScorer(score: number): StructuredScorer {
  return {
    withStructuredOutput: () => ({
      invoke: async (_m: ScoreMessages) => ({ score, justification: 'ok' }),
    }) as never,
  };
}

let db: DatabaseType;
beforeEach(() => {
  db = openTestDb();
  insertProfile(db, { full_name: 'Ada', email: 'ada@x.com', bio: 'Engineer' });
  upsertSearchPreferences(db, {
    description: 'TS backend',
    keywords: ['typescript'],
    locations: ['Remote'],
    work_models: ['remote'],
    seniority: ['senior'],
    excluded_companies: [],
  });
});
afterEach(() => closeTestDb(db));

describe('M10 pipeline', () => {
  it('fake job + score task → match_score updated end-to-end', async () => {
    const bus = createEventBus();
    const job = insertJob(db, {
      site_id: 'linkedin',
      external_id: 'fake-1',
      url: 'https://x',
      apply_method: 'auto',
      title: 'Senior TS Engineer',
      company: 'Acme',
      description: 'TS backend role',
    });

    const worker = createWorker({
      db,
      bus,
      handlers: {
        search: createSearchHandler({ db, bus }),
        score: createScoreHandler({
          db,
          bus,
          buildModel: async () => fakeScorer(77),
        }),
        tailor: async () => undefined,
        apply: async () => undefined,
        prepare_manual_apply: async () => undefined,
        resume: async () => undefined,
      },
      pollIntervalMs: 5,
    });

    enqueue(db, { kind: 'score', payload: { job_id: job.id } });
    worker.start();
    await vi.waitFor(
      () => {
        const fresh = findJobById(db, job.id);
        expect(fresh?.match_score).toBe(77);
        expect(fresh?.status).toBe('scored');
      },
      { timeout: 2_000, interval: 25 },
    );
    await worker.stop();
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `pnpm vitest run packages/server/tests/integration/m10-pipeline.test.ts`
Expected: PASS — proves the full M10 happy path.

- [ ] **Step 3: Run the entire repository test + lint suite**

Run: `pnpm test && pnpm lint`
Expected: All previous tests still pass; no lint errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/tests/integration/m10-pipeline.test.ts
git commit -m "test(server): M10 end-to-end pipeline (enqueue → score → match_score updated)"
```

---

## Self-review

**Spec coverage check:** Build-order M10 enumerates six requirements:

| Spec line                                                                             | Covered by              |
| ------------------------------------------------------------------------------------- | ----------------------- |
| `scheduler.ts` registers `node-cron` jobs from the `schedules` table                  | Task 6                  |
| `queue.ts` — `p-queue` per kind, persisted to `task_queue`                            | Tasks 1, 5              |
| `runner.ts` picks pending rows, dispatches by kind, retries with backoff              | Task 5 (in `worker.ts`) |
| `search` task handler (stub, just logs)                                               | Task 3                  |
| `score` task handler that calls `runScoreJob`                                         | Task 4                  |
| WebSocket gateway emits `queue:updated` and `jobs:updated`                            | Tasks 2, 5, 7           |
| Done-when: fake job → score → `match_score` updated                                   | Task 10                 |
| Done-when: Dashboard "next run at" reflects schedule                                  | Tasks 8, 9              |

The plan combines `queue.ts` and `runner.ts` from the build-order into a single `worker.ts` because the M10 surface is small enough that splitting them creates two thin files passing state to each other. If the worker grows past ~250 lines, extract `runner.ts` then.

**Placeholder scan:** None — every step shows the actual code or command.

**Type consistency:**

- `TaskHandlers` is `Record<TaskKind, TaskHandler>` in Task 5 and used identically in Tasks 3, 4, 7, 10
- `EventBus` is the interface from Task 2; emit signatures match the shared `EVENT_PAYLOADS` contract throughout
- `nextRunAt(expression, from?)` — same signature in cron.ts (Task 6), used in scheduler.ts (Task 6), routes/schedules.ts (Task 9), and routes/system.ts (Task 8)
- `getActiveChatModel(db)` returns `BaseChatModel`, which structurally satisfies the `StructuredScorer` interface that `runScoreJob` accepts

**Known assumption to verify on first run:** the score handler test imports `getOrInitSearchPreferences` and `upsertSearchPreferences` from the search-preferences repository. Confirm these names exist (or rename in the test to whatever the repo actually exports — the README's `GET /api/search-preferences` endpoint already returns a default row, so a similar helper almost certainly exists).
