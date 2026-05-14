# Google Jobs Source via SerpAPI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Google Jobs online as the second job source per `docs/superpowers/specs/2026-05-13-google-jobs-source-design.md`. HTTP-only (no Playwright). Every listing flows into the existing Jobs page as `apply_method='manual'` with `original_source` ("via Greenhouse") rendered under the company name and a smart-link Apply that points at `external_apply_url`. Tailored materials and a dedicated "Ready to Apply" page stay deferred to Phase B.

**Architecture:** Fill in the existing `serpapi-service.ts` stub with a real Google Jobs client (key validation + paginated async iterator with retry-once on 5xx and a 3-page soft cap). Refactor the existing LinkedIn-only `search` queue handler to dispatch on `site.id`/`site.kind`: keep the LinkedIn pipeline untouched and add a SerpAPI branch that inserts listings with `apply_method='manual'`, `external_apply_url=apply_options[0].link`, `original_source=via`. Add a wizard `google-jobs` step (optional, with Skip), a Google Jobs row in Settings → Sites, a JobCard caption for `original_source`, CLI updates, and one end-to-end integration test against a small Fastify fixture under `tests/fixtures/sites/google/`. Schema gets one forward-only migration (`003_serpapi_alert_kinds.sql`) widening `alerts.kind` to include three new SerpAPI alert kinds.

**Tech Stack:** TypeScript, Node ≥20, pnpm workspaces, Fastify + `@fastify/websocket`, better-sqlite3, React 18 + Vite + Tailwind + TanStack Query + Zustand, Vitest. No new third-party dependencies — SerpAPI is reached via `fetch`. The existing LinkedIn fixture pattern (`tests/fixtures/sites/linkedin/server.ts`) is mirrored for the SerpAPI fixture so the e2e test never touches the public SerpAPI endpoint.

**Status notes from the codebase audit:**

- The `serpapi-service.ts` stub in `packages/server/src/services/` already exports `validateSerpApiKey(plaintext)` returning `ValidateResult`. This plan keeps that function (the wizard already calls it) and **adds** a `searchGoogleJobs` async iterator plus a typed error taxonomy alongside. The legacy `validateSerpApiKey` export is preserved to avoid churning the M6 callers.
- The `sites` table seed in `001_init.sql` already contains `('google', 'Google Jobs', 'api', 0, …)`. No migration is needed to introduce the site row — Phase 3's handler dispatch just reads it.
- `alerts.kind` CHECK constraint was last widened in `002_linkedin_e2e_schema.sql`. The next migration is `003_serpapi_alert_kinds.sql` and must rebuild the table because SQLite cannot ALTER a CHECK constraint in place.
- `packages/shared/src/enums.ts` defines `ALERT_KINDS` — the three new kinds (`serpapi_key_missing`, `serpapi_key_invalid`, `serpapi_quota_exhausted`) must mirror the migration.
- `POST /api/sites/:id/test` already exists in `packages/server/src/http/routes/sites.ts` and calls `validateSerpApiKey(getDecryptedSerpApiKey(db))`. That endpoint reads the **stored** key — the wizard also needs to validate a **candidate** key from the request body before persisting. We add a body-aware path that takes precedence when a `key` field is present.
- `POST /api/searches/run-now` already exists; verify it doesn't hard-code `site_id='linkedin'`. If it does, generalise (see Task 4 note).
- The current `search` handler hard-codes a LinkedIn flow (page navigation, session expiry probe, selector cache). The refactor extracts a thin dispatcher that picks the per-site implementation by `site.kind` (`browser` → existing LinkedIn flow; `api` → new SerpAPI flow), keeping all existing tests green.
- Wizard step order today: `welcome → profile → cv → llm-provider → preferences → schedule → connect-linkedin → done`. The new order is `welcome → profile → cv → llm-provider → google-jobs → preferences → schedule → connect-linkedin → done`. `google-jobs` is **optional** — it does not gate `REQUIRED_STEPS` in `use-wizard.ts`.
- The existing JobCard already smart-links Apply via `applyHref(job)`. We adjust the button **label** based on `original_source` (e.g. "Apply on Greenhouse") rather than re-routing the href.

**Coding conventions reminder (from CLAUDE.md):**

- Strict TypeScript; `kebab-case.ts` for modules, `PascalCase.tsx` for components.
- No default exports except React pages and Vite entrypoints.
- Comment _why_, not _what_; prefer no comments.
- Conventional Commits scoped by package: `feat(server): …`, `feat(web): …`, etc.
- One commit per task; **never** include "Claude" or "Co-Authored-By Claude" in commit messages (per user memory).
- SerpAPI keys are PII-adjacent secrets. The service must never log the key, and any URL surfaced to logs/errors has the `api_key` query parameter redacted.

---

## Phase 1 — Schema, Shared Types, Events

### Task 1: Forward-only migration `003_serpapi_alert_kinds.sql`

**Files:**
- Create: `packages/server/migrations/003_serpapi_alert_kinds.sql`
- Test: `packages/server/tests/db/migrations.test.ts` (extend the existing file)

- [ ] **Step 1: Read existing migration tests for conventions**

Run: `pnpm --filter @vina/server test -- migrations --reporter=verbose` to see the existing describe blocks and reuse the `freshTestDb` helper.

Expected: confirm the file at `packages/server/tests/db/migrations.test.ts` already covers `002_linkedin_e2e_schema` and shows the assertion idiom used in Task 1 of the LinkedIn plan (inserting `alerts` rows for each new kind and asserting the INSERT does not throw).

- [ ] **Step 2: Write the failing test**

Append a new `describe` block to `packages/server/tests/db/migrations.test.ts`:

```ts
describe('003_serpapi_alert_kinds', () => {
  it('widens alerts.kind to include the three SerpAPI kinds', () => {
    const db = freshTestDb();
    for (const kind of [
      'serpapi_key_missing',
      'serpapi_key_invalid',
      'serpapi_quota_exhausted',
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

  it('preserves the previously-allowed alert kinds from 002', () => {
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
          .run(`b-${kind}`, kind, new Date().toISOString()),
      ).not.toThrow();
    }
    db.close();
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- migrations`
Expected: FAIL on the new `serpapi_*` inserts (the CHECK rejects them).

- [ ] **Step 4: Write the migration SQL**

```sql
-- 003_serpapi_alert_kinds.sql
-- Widens alerts.kind to include the three SerpAPI kinds for the Google Jobs slice.
-- Forward-only. SQLite cannot ALTER a CHECK constraint, so we rebuild `alerts`.

CREATE TABLE alerts_new (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'missing_field', 'captcha', 'session_expired',
                     'awaiting_approval', 'apply_failed',
                     'ready_for_manual_apply', 'general',
                     'linkedin_session_expired', 'search_failed',
                     'score_failed', 'schedule_paused', 'provider_failed',
                     'serpapi_key_missing', 'serpapi_key_invalid',
                     'serpapi_quota_exhausted'
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

Verify the migration runner (`packages/server/src/db/migrate.ts`) wraps each file in a transaction; the rebuild dropping `alerts` is destructive if a partial failure escapes. Existing migrations follow this pattern — confirm before committing.

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm --filter @vina/server test -- migrations`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/migrations/003_serpapi_alert_kinds.sql \
        packages/server/tests/db/migrations.test.ts
git commit -m "feat(server): add migration 003 for SerpAPI alert kinds"
```

---

### Task 2: Add the three SerpAPI alert kinds to `@vina/shared`

**Files:**
- Modify: `packages/shared/src/enums.ts`
- Test: `packages/shared/tests/enums.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/tests/enums.test.ts`:

```ts
import { ALERT_KINDS } from '../src/enums.js';

describe('ALERT_KINDS — google jobs slice additions', () => {
  it.each([
    'serpapi_key_missing',
    'serpapi_key_invalid',
    'serpapi_quota_exhausted',
  ])('includes %s', (kind) => {
    expect(ALERT_KINDS as readonly string[]).toContain(kind);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @vina/shared test -- enums`
Expected: FAIL.

- [ ] **Step 3: Extend the enum**

In `packages/shared/src/enums.ts`, append the three new kinds to the `ALERT_KINDS` array (after `'provider_failed'`):

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
  'serpapi_key_missing',
  'serpapi_key_invalid',
  'serpapi_quota_exhausted',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
```

- [ ] **Step 4: Run the test + build, expect pass**

Run: `pnpm --filter @vina/shared test -- enums && pnpm --filter @vina/shared build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/enums.ts packages/shared/tests/enums.test.ts
git commit -m "feat(shared): add serpapi alert kinds"
```

---

## Phase 2 — SerpAPI Service

### Task 3: Implement `searchGoogleJobs` async iterator + error taxonomy

**Files:**
- Modify: `packages/server/src/services/serpapi-service.ts`
- Create: `packages/server/src/services/serpapi-service.errors.ts` (optional — can co-locate in the same file; the test below imports from `serpapi-service.ts`)
- Test: `packages/server/tests/services/serpapi-service.test.ts` (create)

**Approach.** The existing `validateSerpApiKey(plaintext)` export stays. We add:

1. A typed error taxonomy: `SerpapiKeyInvalidError`, `SerpapiQuotaExhaustedError`, `SerpapiTransientError`.
2. `searchGoogleJobs(input, opts?): AsyncIterable<GoogleJobsListing>` — paginates via `next_page_token` up to a soft cap (default 3 pages, exposed as `opts.maxPages` for tests), retries once on 5xx with a 2s backoff, surfaces 403 / 429 as the typed errors above.
3. A `mapJobResult(raw)` helper that normalises one SerpAPI `jobs_results[]` entry to `GoogleJobsListing`, dropping entries that lack `apply_options[0].link` (returns `null` — caller skips).
4. A `redactKey(url)` helper for safe log lines.

Test seam: the iterator uses an injectable `fetchImpl` (defaults to global `fetch`) so the test can drive the pagination across synthetic pages and the error branches without standing up a real HTTP server.

- [ ] **Step 1: Read the existing stub**

Run: `cat packages/server/src/services/serpapi-service.ts` — confirm `validateSerpApiKey`, `ValidateResult`, and the `SERPAPI_BASE` constant. The new code lives alongside.

- [ ] **Step 2: Write the failing test**

Create `packages/server/tests/services/serpapi-service.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  searchGoogleJobs,
  SerpapiKeyInvalidError,
  SerpapiQuotaExhaustedError,
  SerpapiTransientError,
  type GoogleJobsListing,
} from '../../src/services/serpapi-service.js';

interface FakePage {
  jobs_results: Array<Record<string, unknown>>;
  serpapi_pagination?: { next_page_token?: string };
}

function fakeFetch(pages: Record<string, FakePage | { status: number; body?: unknown }>) {
  return async (input: URL | string): Promise<Response> => {
    const url = typeof input === 'string' ? new URL(input) : input;
    const token = url.searchParams.get('next_page_token') ?? 'page-1';
    const entry = pages[token];
    if (!entry) return new Response('{}', { status: 200 });
    if ('status' in entry) {
      return new Response(JSON.stringify(entry.body ?? {}), { status: entry.status });
    }
    return new Response(JSON.stringify(entry), { status: 200 });
  };
}

const job = (id: string) => ({
  job_id: id,
  title: `Engineer ${id}`,
  company_name: 'Acme',
  location: 'Remote',
  via: 'via Greenhouse',
  description: 'Build things.',
  detected_extensions: { salary: '$180K' },
  apply_options: [{ title: 'Apply on Greenhouse', link: `https://gh.io/${id}` }],
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe('searchGoogleJobs', () => {
  it('iterates across pages until next_page_token is absent', async () => {
    const fetchImpl = fakeFetch({
      'page-1': { jobs_results: [job('a'), job('b')], serpapi_pagination: { next_page_token: 'p2' } },
      p2: { jobs_results: [job('c')] },
    });
    const out = await collect(
      searchGoogleJobs(
        { keywords: 'typescript', location: 'Remote' },
        { apiKey: 'k', fetchImpl, maxPages: 5 },
      ),
    );
    expect(out.map((l) => l.external_id)).toEqual(['a', 'b', 'c']);
    expect(out[0]).toMatchObject({
      title: 'Engineer a',
      company: 'Acme',
      via: 'via Greenhouse',
      apply_url: 'https://gh.io/a',
    });
  });

  it('honours the soft maxPages cap', async () => {
    const fetchImpl = fakeFetch({
      'page-1': { jobs_results: [job('a')], serpapi_pagination: { next_page_token: 'p2' } },
      p2: { jobs_results: [job('b')], serpapi_pagination: { next_page_token: 'p3' } },
      p3: { jobs_results: [job('c')] },
    });
    const out = await collect(
      searchGoogleJobs({ keywords: 'x' }, { apiKey: 'k', fetchImpl, maxPages: 2 }),
    );
    expect(out.map((l) => l.external_id)).toEqual(['a', 'b']);
  });

  it('drops listings without apply_options[0].link', async () => {
    const bad = { ...job('z'), apply_options: [] };
    const fetchImpl = fakeFetch({ 'page-1': { jobs_results: [bad, job('y')] } });
    const out = await collect(
      searchGoogleJobs({ keywords: 'x' }, { apiKey: 'k', fetchImpl, maxPages: 1 }),
    );
    expect(out.map((l) => l.external_id)).toEqual(['y']);
  });

  it('throws SerpapiKeyInvalidError on 403', async () => {
    const fetchImpl = fakeFetch({ 'page-1': { status: 403, body: { error: 'Invalid API key' } } });
    await expect(
      collect(searchGoogleJobs({ keywords: 'x' }, { apiKey: 'k', fetchImpl })),
    ).rejects.toBeInstanceOf(SerpapiKeyInvalidError);
  });

  it('throws SerpapiQuotaExhaustedError on 429', async () => {
    const fetchImpl = fakeFetch({ 'page-1': { status: 429 } });
    await expect(
      collect(searchGoogleJobs({ keywords: 'x' }, { apiKey: 'k', fetchImpl })),
    ).rejects.toBeInstanceOf(SerpapiQuotaExhaustedError);
  });

  it('retries once on 5xx then succeeds', async () => {
    let n = 0;
    const fetchImpl = async (): Promise<Response> => {
      n += 1;
      if (n === 1) return new Response('', { status: 502 });
      return new Response(
        JSON.stringify({ jobs_results: [job('a')] }),
        { status: 200 },
      );
    };
    const out = await collect(
      searchGoogleJobs(
        { keywords: 'x' },
        { apiKey: 'k', fetchImpl, maxPages: 1, retryDelayMs: 1 },
      ),
    );
    expect(n).toBe(2);
    expect(out.map((l) => l.external_id)).toEqual(['a']);
  });

  it('throws SerpapiTransientError when 5xx persists after retry', async () => {
    let n = 0;
    const fetchImpl = async (): Promise<Response> => {
      n += 1;
      return new Response('', { status: 500 });
    };
    await expect(
      collect(
        searchGoogleJobs(
          { keywords: 'x' },
          { apiKey: 'k', fetchImpl, maxPages: 1, retryDelayMs: 1 },
        ),
      ),
    ).rejects.toBeInstanceOf(SerpapiTransientError);
    expect(n).toBe(2);
  });

  it('aborts mid-pagination when signal is triggered', async () => {
    const fetchImpl = fakeFetch({
      'page-1': { jobs_results: [job('a')], serpapi_pagination: { next_page_token: 'p2' } },
      p2: { jobs_results: [job('b')] },
    });
    const ac = new AbortController();
    const out: GoogleJobsListing[] = [];
    for await (const l of searchGoogleJobs(
      { keywords: 'x' },
      { apiKey: 'k', fetchImpl, maxPages: 5, signal: ac.signal },
    )) {
      out.push(l);
      ac.abort();
    }
    expect(out.map((l) => l.external_id)).toEqual(['a']);
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- serpapi-service`
Expected: FAIL — symbols don't exist.

- [ ] **Step 4: Fill in the service**

In `packages/server/src/services/serpapi-service.ts`, add (alongside the existing `validateSerpApiKey`):

Types and errors:

```ts
export interface GoogleJobsSearchInput {
  keywords: string;
  location?: string;
  num?: number;
}

export interface GoogleJobsListing {
  external_id: string;
  title: string;
  company: string;
  location: string | null;
  description: string;
  via: string | null;
  apply_url: string;
  salary_text: string | null;
}

export interface SearchGoogleJobsOpts {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Default 3. Caps total HTTP calls per invocation. */
  maxPages?: number;
  /** Default 2000ms. Backoff before the single 5xx retry. Test seam. */
  retryDelayMs?: number;
  signal?: AbortSignal;
}

export class SerpapiKeyInvalidError extends Error {
  readonly code = 'serpapi_key_invalid' as const;
  constructor(detail: string) {
    super(`SerpAPI rejected the key: ${detail}`);
  }
}
export class SerpapiQuotaExhaustedError extends Error {
  readonly code = 'serpapi_quota_exhausted' as const;
  constructor() {
    super('SerpAPI monthly quota exhausted (HTTP 429)');
  }
}
export class SerpapiTransientError extends Error {
  readonly code = 'serpapi_transient' as const;
  constructor(detail: string) {
    super(`SerpAPI transient failure: ${detail}`);
  }
}
```

Mapping helper and salary regex (parse `extensions[]` when `detected_extensions.salary` is absent):

```ts
const SALARY_RE = /\$[\d,]+(?:\.\d+)?[KMk]?(?:\s*[-–]\s*\$[\d,]+(?:\.\d+)?[KMk]?)?/;

interface RawJob {
  job_id?: string;
  title?: string;
  company_name?: string;
  location?: string;
  description?: string;
  via?: string;
  extensions?: string[];
  detected_extensions?: { salary?: string };
  apply_options?: Array<{ title?: string; link?: string }>;
}

function mapJobResult(raw: RawJob): GoogleJobsListing | null {
  const link = raw.apply_options?.[0]?.link;
  if (!link) return null;
  const externalId = raw.job_id ?? link;
  const salary =
    raw.detected_extensions?.salary ??
    raw.extensions?.find((e) => SALARY_RE.test(e)) ??
    null;
  return {
    external_id: externalId,
    title: raw.title ?? '(untitled)',
    company: raw.company_name ?? '(unknown)',
    location: raw.location ?? null,
    description: raw.description ?? '',
    via: raw.via ?? null,
    apply_url: link,
    salary_text: salary,
  };
}

function redactKey(url: URL): string {
  const u = new URL(url.toString());
  if (u.searchParams.has('api_key')) u.searchParams.set('api_key', 'REDACTED');
  return u.toString();
}
```

Iterator:

```ts
export async function* searchGoogleJobs(
  input: GoogleJobsSearchInput,
  opts: SearchGoogleJobsOpts,
): AsyncIterable<GoogleJobsListing> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxPages ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 2000;

  let pageIdx = 0;
  let nextPageToken: string | null = null;

  while (pageIdx < maxPages) {
    if (opts.signal?.aborted) return;
    const url = new URL(SERPAPI_BASE);
    url.searchParams.set('engine', 'google_jobs');
    url.searchParams.set('q', input.keywords);
    if (input.location) url.searchParams.set('location', input.location);
    if (input.num) url.searchParams.set('num', String(input.num));
    if (nextPageToken) url.searchParams.set('next_page_token', nextPageToken);
    url.searchParams.set('api_key', opts.apiKey);

    const res = await fetchOnceWithRetry(fetchImpl, url, retryDelayMs);

    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      throw new SerpapiKeyInvalidError(
        typeof body?.error === 'string' ? body.error : `HTTP 403 at ${redactKey(url)}`,
      );
    }
    if (res.status === 429) throw new SerpapiQuotaExhaustedError();
    if (!res.ok) {
      throw new SerpapiTransientError(`HTTP ${res.status} at ${redactKey(url)}`);
    }

    const payload = (await res.json()) as {
      jobs_results?: RawJob[];
      serpapi_pagination?: { next_page_token?: string };
      error?: string;
    };
    if (payload.error) {
      const lower = payload.error.toLowerCase();
      if (lower.includes('invalid api key') || lower.includes('unauthorized')) {
        throw new SerpapiKeyInvalidError(payload.error);
      }
      if (lower.includes('limit') || lower.includes('exceeded')) {
        throw new SerpapiQuotaExhaustedError();
      }
      throw new SerpapiTransientError(payload.error);
    }

    for (const raw of payload.jobs_results ?? []) {
      if (opts.signal?.aborted) return;
      const mapped = mapJobResult(raw);
      if (mapped) yield mapped;
    }

    nextPageToken = payload.serpapi_pagination?.next_page_token ?? null;
    if (!nextPageToken) return;
    pageIdx += 1;
  }
}

async function fetchOnceWithRetry(
  fetchImpl: typeof fetch,
  url: URL,
  retryDelayMs: number,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    res = new Response('', { status: 502 });
  }
  if (res.status < 500) return res;
  await new Promise((r) => setTimeout(r, retryDelayMs));
  try {
    return await fetchImpl(url);
  } catch {
    return new Response('', { status: 502 });
  }
}
```

Note: the existing `validateSerpApiKey` is **unchanged**. The wizard / settings route continues to call it; only the search-handler branch uses the new iterator.

- [ ] **Step 5: Run the test + build, expect pass**

Run: `pnpm --filter @vina/server test -- serpapi-service && pnpm --filter @vina/server build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/serpapi-service.ts \
        packages/server/tests/services/serpapi-service.test.ts
git commit -m "feat(server): add SerpAPI search iterator and error taxonomy"
```

---

## Phase 3 — Search Task Dispatch

### Task 4: Refactor `search` handler to dispatch on `site.kind`

**Files:**
- Modify: `packages/server/src/queue/handlers/search.ts`
- Test: `packages/server/tests/queue/handlers/search.google.test.ts` (create)
- Verify: existing LinkedIn handler tests still pass without modification

**Approach.** The current `createSearchHandler` is a single ~325-line function with a LinkedIn-specific body. We split it into:

1. The exported `createSearchHandler` keeps its signature and remains the entry point. The first thing it does after resolving `site` is dispatch on `site.kind`:
   - `site.kind === 'browser'` → existing LinkedIn body (extracted unchanged into `runBrowserSearch(...)`).
   - `site.kind === 'api'` → new `runGoogleSearch(...)`.
2. `runGoogleSearch` reads the decrypted SerpAPI key, iterates `searchGoogleJobs`, inserts jobs as manual-apply, enqueues `score` tasks, and emits the same `search:*` events. Per-listing failures are caught locally — one bad row never aborts the run.
3. The handler dependency object gains an injectable `serpapiSearch` test seam (defaults to the real `searchGoogleJobs` import) so the new test can fake fetch behaviour without re-driving the full `fetch`-mocking dance from Phase 2.

This keeps the LinkedIn path bit-for-bit identical and additive — none of the existing tests need to change.

- [ ] **Step 1: Read the current handler shape**

Read `packages/server/src/queue/handlers/search.ts` end-to-end. Identify the `try/finally` block running from the `getContext` call to the `closeAll`. Plan to lift it into a private `runBrowserSearch(deps, site, payload, prefs)` that returns `{ listingsAdded, scoredEnqueued }` and re-throws on session expiry. Do not change LinkedIn behaviour.

- [ ] **Step 2: Write the failing test**

Create `packages/server/tests/queue/handlers/search.google.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { createSearchHandler } from '../../../src/queue/handlers/search.js';
import { createEventBus } from '../../../src/events/bus.js';
import { listJobs } from '../../../src/db/repositories/jobs.js';
import { listPending } from '../../../src/db/repositories/task-queue.js';
import { listAlerts } from '../../../src/db/repositories/alerts.js';
import { setSerpApiKey } from '../../../src/services/settings-service.js';
import { upsertSearchPreferences } from '../../../src/db/repositories/search-preferences.js';
import {
  SerpapiKeyInvalidError,
  SerpapiQuotaExhaustedError,
  type GoogleJobsListing,
} from '../../../src/services/serpapi-service.js';
import { freshTestDb } from '../../db/helpers.js';

let db: DatabaseType;
beforeEach(() => {
  db = freshTestDb();
  upsertSearchPreferences(db, {
    description: 'Senior backend',
    keywords: ['typescript'],
    locations: ['Remote'],
    work_models: ['remote'],
    seniority: ['senior'],
    excluded_companies: [],
  });
});
afterEach(() => db.close());

const FAKE_BM = { getContext: async () => ({ newPage: async () => ({}) }), closeAll: async () => {} } as never;

const listing = (id: string, overrides: Partial<GoogleJobsListing> = {}): GoogleJobsListing => ({
  external_id: id,
  title: `Engineer ${id}`,
  company: 'Acme',
  location: 'Remote',
  description: 'Build things.',
  via: 'via Greenhouse',
  apply_url: `https://gh.io/${id}`,
  salary_text: '$180K',
  ...overrides,
});

async function* iterListings(...items: GoogleJobsListing[]): AsyncIterable<GoogleJobsListing> {
  for (const x of items) yield x;
}

describe('search handler — google branch', () => {
  it('inserts listings as manual-apply with original_source and enqueues score tasks', async () => {
    setSerpApiKey(db, 'fake-key');
    const handler = createSearchHandler({
      db,
      bus: createEventBus(),
      browserManager: FAKE_BM,
      adapters: {},
      serpapiSearch: () => iterListings(listing('a'), listing('b')),
    });

    await handler({ site_id: 'google' });

    const jobs = listJobs(db, { site_id: 'google' });
    expect(jobs.map((j) => j.external_id).sort()).toEqual(['a', 'b']);
    expect(jobs[0]!.apply_method).toBe('manual');
    expect(jobs[0]!.external_apply_url).toMatch(/^https:\/\/gh\.io\//);
    expect(jobs[0]!.original_source).toBe('via Greenhouse');

    const pending = listPending(db).filter((p) => p.kind === 'score');
    expect(pending.length).toBe(2);
  });

  it('emits a serpapi_key_missing alert and fails fast when no key configured', async () => {
    const handler = createSearchHandler({
      db,
      bus: createEventBus(),
      browserManager: FAKE_BM,
      adapters: {},
      serpapiSearch: () => {
        throw new Error('should not be called');
      },
    });

    await expect(handler({ site_id: 'google' })).rejects.toThrow();

    const alerts = listAlerts(db, { status: 'open' });
    expect(alerts.some((a) => a.kind === 'serpapi_key_missing')).toBe(true);
  });

  it('maps SerpapiKeyInvalidError to a serpapi_key_invalid alert', async () => {
    setSerpApiKey(db, 'bad-key');
    const handler = createSearchHandler({
      db,
      bus: createEventBus(),
      browserManager: FAKE_BM,
      adapters: {},
      serpapiSearch: () => {
        // eslint-disable-next-line require-yield
        async function* boom(): AsyncIterable<GoogleJobsListing> {
          throw new SerpapiKeyInvalidError('Invalid API key');
        }
        return boom();
      },
    });

    await expect(handler({ site_id: 'google' })).rejects.toBeInstanceOf(SerpapiKeyInvalidError);
    const alerts = listAlerts(db, { status: 'open' });
    expect(alerts.some((a) => a.kind === 'serpapi_key_invalid')).toBe(true);
  });

  it('maps SerpapiQuotaExhaustedError to a serpapi_quota_exhausted alert', async () => {
    setSerpApiKey(db, 'good-but-tapped-out');
    const handler = createSearchHandler({
      db,
      bus: createEventBus(),
      browserManager: FAKE_BM,
      adapters: {},
      serpapiSearch: () => {
        // eslint-disable-next-line require-yield
        async function* boom(): AsyncIterable<GoogleJobsListing> {
          throw new SerpapiQuotaExhaustedError();
        }
        return boom();
      },
    });

    await expect(handler({ site_id: 'google' })).rejects.toBeInstanceOf(SerpapiQuotaExhaustedError);
    const alerts = listAlerts(db, { status: 'open' });
    expect(alerts.some((a) => a.kind === 'serpapi_quota_exhausted')).toBe(true);
  });

  it('quota-exhausted increments schedule consecutive_failures when schedule_id is set', async () => {
    setSerpApiKey(db, 'k');
    // Insert a schedule row directly; helpers come from repositories/schedules.ts.
    const { insertSchedule, findScheduleById } = await import('../../../src/db/repositories/schedules.js');
    const sched = insertSchedule(db, { cron_expression: '*/15 * * * *' });

    const handler = createSearchHandler({
      db,
      bus: createEventBus(),
      browserManager: FAKE_BM,
      adapters: {},
      serpapiSearch: () => {
        async function* boom(): AsyncIterable<GoogleJobsListing> {
          throw new SerpapiQuotaExhaustedError();
        }
        return boom();
      },
    });

    await expect(handler({ site_id: 'google', schedule_id: sched.id })).rejects.toBeInstanceOf(
      SerpapiQuotaExhaustedError,
    );
    expect(findScheduleById(db, sched.id)?.consecutive_failures).toBe(1);
  });
});
```

Verify exact export names of `listAlerts` / `insertSchedule` / `findScheduleById` when implementing — adjust imports if the repos use slightly different names. The `freshTestDb` helper seeds the `sites` table from `001_init.sql`, so the `google` site row is already present.

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- search.google`
Expected: FAIL — `serpapiSearch` is not in `SearchHandlerDeps`; `google` branch returns "No adapter registered".

- [ ] **Step 4: Refactor the handler**

In `packages/server/src/queue/handlers/search.ts`:

1. Extend the deps interface:

```ts
import {
  searchGoogleJobs as defaultSearchGoogleJobs,
  SerpapiKeyInvalidError,
  SerpapiQuotaExhaustedError,
  type GoogleJobsListing,
  type GoogleJobsSearchInput,
} from '../../services/serpapi-service.js';
import { getDecryptedSerpApiKey } from '../../services/settings-service.js';

export interface SearchHandlerDeps {
  // … existing fields …
  /** Test seam — defaults to the live SerpAPI client. */
  serpapiSearch?: (
    input: GoogleJobsSearchInput,
    opts: { apiKey: string; signal?: AbortSignal },
  ) => AsyncIterable<GoogleJobsListing>;
}
```

2. Allow the `adapters` lookup to be optional for api-kind sites:

```ts
return async (payload) => {
  const site = findSiteById(deps.db, payload.site_id);
  if (!site) throw new ValidationError(`Unknown site_id: ${payload.site_id}`);

  if (site.kind === 'api') {
    return runApiSearch(deps, site, payload);
  }

  const adapter = deps.adapters[site.id];
  if (!adapter) throw new ValidationError(`No adapter registered for site: ${site.id}`);
  return runBrowserSearch(deps, site, adapter, payload);
};
```

3. Extract the existing body verbatim into `runBrowserSearch(deps, site, adapter, payload)`. No behaviour change — this is purely a move.

4. Add `runApiSearch(deps, site, payload)`:

```ts
async function runApiSearch(
  deps: SearchHandlerDeps,
  site: Site,
  payload: SearchPayload,
): Promise<void> {
  const prefs = getOrInitSearchPreferences(deps.db);
  deps.bus.emit('search:started', { task_id: payload.task_id ?? 'unknown', site_id: site.id });

  const apiKey = getDecryptedSerpApiKey(deps.db);
  if (!apiKey) {
    insertAlert(deps.db, {
      kind: 'serpapi_key_missing',
      severity: 'action_required',
      title: 'SerpAPI key missing',
      description:
        'Google Jobs is enabled but no SerpAPI key is configured. Add one in Settings → Sites.',
      site_id: site.id,
    });
    deps.bus.emit('search:failed', {
      task_id: payload.task_id ?? 'unknown',
      site_id: site.id,
      error_kind: 'unknown',
    });
    if (payload.schedule_id) incrementScheduleFailures(deps.db, payload.schedule_id);
    throw new ValidationError('SerpAPI key not configured');
  }

  const searchImpl = deps.serpapiSearch ?? defaultSearchGoogleJobs;
  const input: GoogleJobsSearchInput = {
    keywords: [...prefs.keywords, prefs.description].filter(Boolean).join(' '),
    location: prefs.locations[0],
  };

  let listingsAdded = 0;
  let scoredEnqueued = 0;
  const inFlightScoreIds = getInFlightScoreJobIds(deps.db);
  const updatedJobIds: string[] = [];

  try {
    for await (const listing of searchImpl(input, { apiKey })) {
      try {
        const job = insertJob(deps.db, {
          site_id: site.id,
          external_id: listing.external_id,
          url: listing.apply_url,
          external_apply_url: listing.apply_url,
          apply_method: 'manual',
          original_source: listing.via,
          title: listing.title,
          company: listing.company,
          location: listing.location,
          description: listing.description,
          salary_text: listing.salary_text,
        });
        listingsAdded += 1;
        updatedJobIds.push(job.id);
        if (job.status !== 'new') continue;
        if (inFlightScoreIds.has(job.id)) continue;
        enqueue(deps.db, { kind: 'score', payload: { job_id: job.id } });
        inFlightScoreIds.add(job.id);
        scoredEnqueued += 1;
      } catch (err) {
        log.warn({ err, external_id: listing.external_id }, 'google: insertJob failed; skipping');
      }
    }

    if (updatedJobIds.length > 0) {
      deps.bus.emit('jobs:updated', { ids: updatedJobIds });
    }
    if (payload.schedule_id) resetScheduleFailures(deps.db, payload.schedule_id);
    updateSiteSession(deps.db, site.id, {
      session_path: null,
      session_valid_at: null,
      last_search_at: new Date().toISOString(),
    });
    deps.bus.emit('search:completed', {
      task_id: payload.task_id ?? 'unknown',
      site_id: site.id,
      listings_added: listingsAdded,
      scored: scoredEnqueued,
    });
  } catch (err) {
    const alertKind =
      err instanceof SerpapiKeyInvalidError ? 'serpapi_key_invalid' :
      err instanceof SerpapiQuotaExhaustedError ? 'serpapi_quota_exhausted' :
      'search_failed';
    const severity = err instanceof SerpapiQuotaExhaustedError ? 'info' : 'action_required';
    insertAlert(deps.db, {
      kind: alertKind,
      severity,
      title:
        err instanceof SerpapiKeyInvalidError ? 'SerpAPI key rejected' :
        err instanceof SerpapiQuotaExhaustedError ? 'SerpAPI quota exhausted' :
        'Google Jobs search failed',
      description: err instanceof Error ? err.message : String(err),
      site_id: site.id,
    });
    deps.bus.emit('search:failed', {
      task_id: payload.task_id ?? 'unknown',
      site_id: site.id,
      error_kind: 'unknown',
    });
    if (payload.schedule_id) {
      incrementScheduleFailures(deps.db, payload.schedule_id);
      const schedule = findScheduleById(deps.db, payload.schedule_id);
      if (schedule && schedule.consecutive_failures >= STRIKE_LIMIT) {
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
    throw err;
  }
}
```

Verify the `Site` type import path when implementing (it lives in `packages/server/src/db/repositories/sites.ts`). The `last_search_at` write uses `session_path: null, session_valid_at: null` because api-kind sites have no session — confirm `updateSiteSession` tolerates that shape, otherwise add a smaller `updateSiteLastSearchAt(db, id, when)` helper in the same task.

5. Verify `POST /api/searches/run-now` is site-agnostic. Read `packages/server/src/http/routes/searches.ts`; if it hard-codes `linkedin`, accept any `site_id` from the body and pass it through. (Should already be the case from M6 — confirm.)

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm --filter @vina/server test -- search`
Expected: PASS for both `search.google.test.ts` and the existing `search.test.ts` (LinkedIn path untouched).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/queue/handlers/search.ts \
        packages/server/tests/queue/handlers/search.google.test.ts
git commit -m "feat(server): dispatch search handler by site.kind and add SerpAPI branch"
```

---

## Phase 4 — HTTP Routes

### Task 5: Body-aware `POST /api/sites/google/test`

**Files:**
- Modify: `packages/server/src/http/routes/sites.ts`
- Test: `packages/server/tests/http/sites.google.test.ts` (create — or extend the existing sites test)

**Why a new path.** The existing `/api/sites/:id/test` validates the **stored** key (`getDecryptedSerpApiKey`). The wizard step needs to validate a **candidate** key the user just typed, **before** persisting it. Spec §4.2 routes the wizard through this endpoint with the typed-in key. We extend the same handler: when the body contains `{ key: string }`, validate that; otherwise fall back to the stored key for the Settings → Sites "Test connection" affordance.

Behaviour:

- `POST /api/sites/google/test { key: "..." }` → calls `validateSerpApiKey(body.key)`; if `ok: true`, persists via `setSerpApiKey(db, body.key)` and flips `sites.google.enabled=1`.
- `POST /api/sites/google/test {}` (or no body) → existing path: validates the stored key, returns `{ ok: true, latency_ms }` or `{ ok: false, reason }`. Does **not** mutate anything.

- [ ] **Step 1: Read the existing route**

Read `packages/server/src/http/routes/sites.ts` lines 91–106. Confirm the current `/test` reads the decrypted key.

- [ ] **Step 2: Write the failing test**

Create `packages/server/tests/http/sites.google.test.ts` (use the existing test harness helpers from `packages/server/tests/http/helpers.ts`):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppHandle } from './helpers.js';
import * as serpapiService from '../../src/services/serpapi-service.js';
import { hasSerpApiKey } from '../../src/services/settings-service.js';
import { findSiteById } from '../../src/db/repositories/sites.js';

let app: TestAppHandle;
beforeEach(async () => {
  app = await buildTestApp();
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('POST /api/sites/google/test', () => {
  it('with a body key, validates and persists on success and enables the site', async () => {
    vi.spyOn(serpapiService, 'validateSerpApiKey').mockResolvedValue({ ok: true, latency_ms: 42 });

    const res = await app.request('POST', '/api/sites/google/test', { key: 'live-key' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(hasSerpApiKey(app.db)).toBe(true);
    expect(findSiteById(app.db, 'google')?.enabled).toBe(true);
  });

  it('with a body key, returns ok:false and does NOT persist on failure', async () => {
    vi.spyOn(serpapiService, 'validateSerpApiKey').mockResolvedValue({
      ok: false,
      reason: 'auth_failed',
    });

    const res = await app.request('POST', '/api/sites/google/test', { key: 'bad' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'auth_failed' });
    expect(hasSerpApiKey(app.db)).toBe(false);
    expect(findSiteById(app.db, 'google')?.enabled).toBe(false);
  });

  it('with no body key and no stored key, returns no_key_configured', async () => {
    const res = await app.request('POST', '/api/sites/google/test', {});
    expect(res.json()).toMatchObject({ ok: false, reason: 'no_key_configured' });
  });
});
```

Verify the exact name/shape of `buildTestApp` / `TestAppHandle` against `packages/server/tests/http/helpers.ts` when implementing; the LinkedIn slice's HTTP tests already use it, so the pattern is established.

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- sites.google`
Expected: FAIL — current route ignores the body.

- [ ] **Step 4: Update the route**

In `packages/server/src/http/routes/sites.ts`, change the `/api/sites/:id/test` handler to:

```ts
const TestKeyBodySchema = z
  .object({ key: z.string().min(1).optional() })
  .optional();

app.post('/api/sites/:id/test', async (req, reply) => {
  const { id } = parse(IdParamsSchema, req.params, 'route params');
  const site = findSiteById(db, id);
  if (!site) throw new NotFoundError(`Site ${id} not found`);
  if (site.kind === 'browser') {
    return reply.status(405).send({
      code: 'method_not_allowed',
      message: 'Browser-kind sites authenticate via /login, not /test',
    });
  }

  const body = parse(TestKeyBodySchema, req.body ?? {}, 'request body');
  if (body?.key) {
    const result = await validateSerpApiKey(body.key);
    if (result.ok) {
      setSerpApiKey(db, body.key);
      updateSiteEnabled(db, id, true);
    }
    return result;
  }

  const stored = getDecryptedSerpApiKey(db);
  if (!stored) return { ok: false as const, reason: 'no_key_configured' as const };
  return validateSerpApiKey(stored);
});
```

Add `setSerpApiKey` to the imports at the top of the file (already exported from `settings-service.ts`).

- [ ] **Step 5: Run the test + build, expect pass**

Run: `pnpm --filter @vina/server test -- sites && pnpm --filter @vina/server build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/http/routes/sites.ts \
        packages/server/tests/http/sites.google.test.ts
git commit -m "feat(server): accept candidate key on POST /api/sites/google/test"
```

---

## Phase 5 — Wizard SerpAPI Step

### Task 6: Web API hooks for Google Jobs

**Files:**
- Modify: `packages/web/src/api/resources.ts`
- Test: `packages/web/tests/api/resources.google.test.tsx` (create, light)

**Approach.** Add three hooks:

- `useValidateSerpapiKey()` — mutation that POSTs `{ key }` to `/api/sites/google/test`, returning the same `ValidateResult` shape used server-side. Used by the wizard step.
- `useGoogleJobsStatus({ pollMs })` — query that fetches `/api/sites` and projects the `google` row into a richer shape (`connected | not_configured | key_invalid | quota_exhausted | last_search_at`). The "key invalid / quota exhausted" projection is derived from the latest open alerts for site `google`. Used by the Settings tile.
- `useDisconnectGoogleJobs()` — mutation that DELETEs `/api/sites/google/session` plus PATCHes `/api/sites/google { enabled: false }`. (No new server route — both already exist.)

The validation hook can re-use the existing typed `ValidateResult` from `@vina/shared` if exported, otherwise define a local interface that mirrors the server shape.

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/api/resources.google.test.tsx` (mirror an existing resources test — the LinkedIn slice added similar tests for `useLinkedInStatus`):

```tsx
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useValidateSerpapiKey, useGoogleJobsStatus } from '../../src/api/resources.js';

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useValidateSerpapiKey', () => {
  it('POSTs to /api/sites/google/test with the candidate key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, latency_ms: 12 }), { status: 200 }),
    );
    const qc = new QueryClient();
    const { result } = renderHook(() => useValidateSerpapiKey(), { wrapper: wrapper(qc) });

    const res = await result.current.mutate('candidate-key');
    expect(res).toMatchObject({ ok: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/sites/google/test'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('useGoogleJobsStatus', () => {
  it('returns not_configured when /api/sites google row has no session', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/sites')) {
        return new Response(
          JSON.stringify([
            { id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: false,
              has_session: false, session_valid_at: null, last_search_at: null },
          ]),
          { status: 200 },
        );
      }
      if (u.includes('/api/alerts')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response('{}', { status: 200 });
    });

    const qc = new QueryClient();
    const { result } = renderHook(() => useGoogleJobsStatus(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.data?.state).toBe('not_configured'));
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @vina/web test -- resources.google`
Expected: FAIL — hooks don't exist.

- [ ] **Step 3: Add the hooks**

Append to `packages/web/src/api/resources.ts`:

```ts
/* ------------------------------------------------------------------ */
/* Google Jobs                                                          */
/* ------------------------------------------------------------------ */

export interface SerpapiValidateResult {
  ok: boolean;
  reason?: 'auth_failed' | 'rate_limited' | 'network' | 'other' | 'no_key_configured';
  detail?: string;
  latency_ms?: number;
}

export function useValidateSerpapiKey(): {
  mutate: (key: string) => Promise<SerpapiValidateResult>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<SerpapiValidateResult, Error, string>({
    mutationFn: (key) =>
      api<SerpapiValidateResult>('/api/sites/google/test', { method: 'POST', body: { key } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sites'] });
      void qc.invalidateQueries({ queryKey: ['google-status'] });
    },
  });
  return { mutate: (key) => mut.mutateAsync(key), isPending: mut.isPending };
}

export type GoogleJobsState = 'not_configured' | 'connected' | 'key_invalid' | 'quota_exhausted';
export interface GoogleJobsStatus {
  state: GoogleJobsState;
  enabled: boolean;
  last_search_at: string | null;
}

export function useGoogleJobsStatus(opts: { pollMs?: number } = {}): {
  data: GoogleJobsStatus | null;
  isLoading: boolean;
} {
  const sites = useSites();
  const alerts = useAlerts();
  if (sites.isLoading) return { data: null, isLoading: true };
  const row = sites.data.find((s) => s.id === 'google') ?? null;
  if (!row) return { data: null, isLoading: false };

  const hasInvalid = alerts.data.some(
    (a) => a.site_id === 'google' && a.kind === 'serpapi_key_invalid' && a.status === 'open',
  );
  const hasQuota = alerts.data.some(
    (a) => a.site_id === 'google' && a.kind === 'serpapi_quota_exhausted' && a.status === 'open',
  );

  const state: GoogleJobsState = hasInvalid
    ? 'key_invalid'
    : hasQuota
    ? 'quota_exhausted'
    : row.session_valid_at || row.enabled
    ? 'connected'
    : 'not_configured';

  // reason: we want pollMs to drive both queries; both are React Query keys
  // already configured with their own intervals elsewhere. The pollMs param is
  // currently unused — wire it through if/when poll-tuning matters.
  void opts.pollMs;

  return {
    data: { state, enabled: row.enabled, last_search_at: row.last_search_at },
    isLoading: false,
  };
}

export function useEnableGoogleJobs(): {
  mutate: () => Promise<unknown>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<unknown, Error, void>({
    mutationFn: () =>
      api(`/api/sites/google`, { method: 'PATCH', body: { enabled: true } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sites'] });
      void qc.invalidateQueries({ queryKey: ['google-status'] });
    },
  });
  return { mutate: () => mut.mutateAsync(), isPending: mut.isPending };
}

export function useDisconnectGoogleJobs(): {
  mutate: () => Promise<unknown>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      await api(`/api/sites/google`, { method: 'PATCH', body: { enabled: false } });
      // Clearing the key requires a backend endpoint — see Task 7 follow-up note.
      // For now, disabling the site is sufficient; the key persists and can be
      // re-used by re-enabling. Setting → Sites "Forget key" hits the explicit
      // DELETE /api/settings/serpapi-key route added in Task 7.
      return null;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sites'] });
      void qc.invalidateQueries({ queryKey: ['google-status'] });
    },
  });
  return { mutate: () => mut.mutateAsync(), isPending: mut.isPending };
}
```

Note the inline comment about `DELETE /api/settings/serpapi-key`: Task 7 adds the explicit "forget key" route (clearSerpApiKey + disable). Until then `useDisconnectGoogleJobs` only flips the enabled flag.

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @vina/web test -- resources.google`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/resources.ts packages/web/tests/api/resources.google.test.tsx
git commit -m "feat(web): add Google Jobs API hooks"
```

---

### Task 7: Settings "forget SerpAPI key" endpoint

**Files:**
- Modify: `packages/server/src/http/routes/sites.ts`
- Test: extend `packages/server/tests/http/sites.google.test.ts`

**Why.** The Disconnect affordance in the Settings → Sites tile needs to **clear** the stored key, not just disable the site. Add a small surface:

`DELETE /api/sites/google` — clears the SerpAPI key (via `clearSerpApiKey`) **and** sets `sites.google.enabled=0`. Returns `204`. Browser-kind sites already have their own delete shape (`DELETE /api/sites/linkedin`); this is the api-kind analogue.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/tests/http/sites.google.test.ts`:

```ts
describe('DELETE /api/sites/google', () => {
  it('clears the stored key and disables the site', async () => {
    // Persist a key first via the test endpoint.
    vi.spyOn(serpapiService, 'validateSerpApiKey').mockResolvedValue({ ok: true, latency_ms: 1 });
    await app.request('POST', '/api/sites/google/test', { key: 'live' });
    expect(hasSerpApiKey(app.db)).toBe(true);

    const res = await app.request('DELETE', '/api/sites/google');
    expect(res.statusCode).toBe(204);
    expect(hasSerpApiKey(app.db)).toBe(false);
    expect(findSiteById(app.db, 'google')?.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- sites.google`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Add the route**

In `packages/server/src/http/routes/sites.ts`, after the `DELETE /api/sites/linkedin` block:

```ts
app.delete('/api/sites/google', async (_req, reply) => {
  clearSerpApiKey(db);
  updateSiteEnabled(db, 'google', false);
  updateSiteSession(db, 'google', { session_path: null, session_valid_at: null });
  return reply.status(204).send();
});
```

Add `clearSerpApiKey` to the import block at the top.

- [ ] **Step 4: Update the disconnect hook**

In `packages/web/src/api/resources.ts`, update `useDisconnectGoogleJobs` to call `DELETE /api/sites/google`:

```ts
mutationFn: async () => {
  await api(`/api/sites/google`, { method: 'DELETE' });
  return null;
},
```

- [ ] **Step 5: Run the test, expect pass**

Run: `pnpm --filter @vina/server test -- sites.google`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/http/routes/sites.ts \
        packages/server/tests/http/sites.google.test.ts \
        packages/web/src/api/resources.ts
git commit -m "feat(server): add DELETE /api/sites/google to forget the SerpAPI key"
```

---

### Task 8: `GoogleJobs` wizard step component

**Files:**
- Create: `packages/web/src/routes/onboarding/steps/GoogleJobs.tsx`
- Modify: `packages/web/src/routes/onboarding/use-wizard.ts` (step order + label; **not** `REQUIRED_STEPS`)
- Modify: `packages/web/src/routes/onboarding/index.tsx` (lazy import + route)
- Test: `packages/web/tests/routes/onboarding/GoogleJobs.test.tsx` (create)

**UX states (spec §4.2):**

| State | What the user sees |
|---|---|
| `initial` | Title, 2-line explanation, key `<input>`, "Enable Google Jobs" + "Skip for now" |
| `validating` | Disabled input + spinner on the primary button |
| `valid` | ✓ "Connected to SerpAPI", auto-advance after 1s |
| `invalid` | Red banner with the reason; user stays on step; can edit + retry |

The step is **not** added to `REQUIRED_STEPS` — skipping leaves `sites.google.enabled=0` and the wizard finishes when the LinkedIn step is connected.

- [ ] **Step 1: Read the ConnectLinkedIn step for shell + state-machine idiom**

Read `packages/web/src/routes/onboarding/steps/ConnectLinkedIn.tsx`. Mirror the `inferUiState` pattern, the `WizardShell` / `WizardFooter` / `PrimaryButton` / `TextButton` imports, and the auto-advance `useEffect`.

- [ ] **Step 2: Write the failing test**

Create `packages/web/tests/routes/onboarding/GoogleJobs.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GoogleJobs } from '../../../src/routes/onboarding/steps/GoogleJobs.js';

function renderStep() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/onboarding/google-jobs']}>
        <Routes>
          <Route path="/onboarding/google-jobs" element={<GoogleJobs />} />
          <Route path="/onboarding/preferences" element={<div>PREFS</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('GoogleJobs wizard step', () => {
  it('renders an initial state with key input and Skip', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    renderStep();
    expect(screen.getByRole('button', { name: /enable google jobs/i })).toBeInTheDocument();
    expect(screen.getByText(/skip for now/i)).toBeInTheDocument();
  });

  it('on Enable, validates the key and advances to /preferences on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/api/sites/google/test')) {
        return new Response(JSON.stringify({ ok: true, latency_ms: 5 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    renderStep();
    await userEvent.type(screen.getByLabelText(/serpapi key/i), 'live-key');
    fireEvent.click(screen.getByRole('button', { name: /enable google jobs/i }));
    await waitFor(() => expect(screen.getByText('PREFS')).toBeInTheDocument(), { timeout: 3000 });
  });

  it('shows a red banner on invalid key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, reason: 'auth_failed' }), { status: 200 }),
    );
    renderStep();
    await userEvent.type(screen.getByLabelText(/serpapi key/i), 'bad');
    fireEvent.click(screen.getByRole('button', { name: /enable google jobs/i }));
    await waitFor(() => expect(screen.getByText(/we couldn.t verify/i)).toBeInTheDocument());
  });

  it('Skip routes to /preferences without calling /test', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    renderStep();
    fireEvent.click(screen.getByText(/skip for now/i));
    await waitFor(() => expect(screen.getByText('PREFS')).toBeInTheDocument());
    const calls = spy.mock.calls.filter((c) => String(c[0]).includes('/api/sites/google/test'));
    expect(calls.length).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/web test -- GoogleJobs`
Expected: FAIL — step file does not exist.

- [ ] **Step 4: Implement the step**

Create `packages/web/src/routes/onboarding/steps/GoogleJobs.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useValidateSerpapiKey } from '../../../api/resources.js';
import {
  PrimaryButton,
  TextButton,
  WizardFooter,
  WizardShell,
} from '../WizardShell.js';
import { usePrevStep } from '../use-wizard.js';

type UiState = 'initial' | 'validating' | 'valid' | 'invalid';

export function GoogleJobs(): JSX.Element {
  const navigate = useNavigate();
  const prev = usePrevStep();
  const validate = useValidateSerpapiKey();

  const [key, setKey] = useState('');
  const [ui, setUi] = useState<UiState>('initial');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ui === 'valid') {
      const t = setTimeout(() => navigate('/onboarding/preferences'), 1000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [ui, navigate]);

  const onEnable = async (): Promise<void> => {
    setUi('validating');
    setError(null);
    try {
      const res = await validate.mutate(key);
      if (res.ok) {
        setUi('valid');
      } else {
        setUi('invalid');
        setError(
          res.reason === 'auth_failed'
            ? 'We couldn’t verify that key with SerpAPI. Double-check it and try again.'
            : res.reason === 'rate_limited'
            ? 'SerpAPI says you’ve hit your monthly quota. Try again next cycle or use a different key.'
            : res.detail ?? 'Validation failed. Please try again.',
        );
      }
    } catch (err) {
      setUi('invalid');
      setError((err as Error).message);
    }
  };

  const skip = (): void => navigate('/onboarding/preferences');

  return (
    <WizardShell
      step="google-jobs"
      title="Enable Google Jobs (optional)"
      subtitle="Connect a SerpAPI key to pull listings from Google Jobs. Skip if you want to set it up later in Settings."
      footer={
        <WizardFooter
          onBack={() => prev('google-jobs')}
          onSkip={{ label: 'Skip for now', onClick: skip }}
          primary={
            ui === 'valid' ? (
              <PrimaryButton disabled>✓ Connected</PrimaryButton>
            ) : (
              <PrimaryButton
                onClick={onEnable}
                disabled={ui === 'validating' || key.trim().length === 0}
              >
                {ui === 'validating' ? 'Validating…' : 'Enable Google Jobs'}
              </PrimaryButton>
            )
          }
        />
      }
    >
      <div className="space-y-4 text-sm text-ink-secondary">
        <p>
          Vina uses SerpAPI’s Google Jobs endpoint to discover listings. The free tier covers
          ~250 searches per month — enough for the default schedule.
        </p>
        <label className="block">
          <span className="block text-xs text-ink-muted">SerpAPI key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="SerpAPI key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={ui === 'validating' || ui === 'valid'}
            className="mt-1 w-full rounded-md border border-border-subtle bg-surface-raised px-3 py-2 text-ink-primary"
          />
          <span className="mt-1 block text-xs text-ink-muted">
            Get one at serpapi.com — stored encrypted on this machine.
          </span>
        </label>

        {ui === 'valid' && (
          <p className="text-success">✓ Connected to SerpAPI. Moving on…</p>
        )}
        {ui === 'invalid' && error && (
          <div className="rounded-md border border-danger-soft bg-danger-soft/50 px-3 py-2 text-danger">
            {error}
          </div>
        )}
      </div>
    </WizardShell>
  );
}
```

Update `packages/web/src/routes/onboarding/use-wizard.ts`:

```ts
export const STEPS = [
  'welcome',
  'profile',
  'cv',
  'llm-provider',
  'google-jobs',
  'preferences',
  'schedule',
  'connect-linkedin',
  'done',
] as const;

export const STEP_LABELS: Record<StepId, string> = {
  welcome: 'Welcome',
  profile: 'Profile',
  cv: 'CV',
  'llm-provider': 'LLM Provider',
  'google-jobs': 'Google Jobs',
  preferences: 'Search preferences',
  schedule: 'Schedule',
  'connect-linkedin': 'Connect LinkedIn',
  done: 'Done',
};
```

`REQUIRED_STEPS` and `firstIncompleteStep` are unchanged — `google-jobs` is optional.

Update `packages/web/src/routes/onboarding/index.tsx` to lazy-load the new step and route it:

```tsx
const GoogleJobs = lazy(() =>
  import('./steps/GoogleJobs.js').then((m) => ({ default: m.GoogleJobs })),
);

// … inside <Routes>:
<Route
  path="google-jobs"
  element={
    <StepGuard step="google-jobs">
      <GoogleJobs />
    </StepGuard>
  }
/>
```

- [ ] **Step 5: Run the test + build, expect pass**

Run: `pnpm --filter @vina/web test -- GoogleJobs && pnpm --filter @vina/web build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/routes/onboarding/steps/GoogleJobs.tsx \
        packages/web/src/routes/onboarding/use-wizard.ts \
        packages/web/src/routes/onboarding/index.tsx \
        packages/web/tests/routes/onboarding/GoogleJobs.test.tsx
git commit -m "feat(web): add Google Jobs wizard step"
```

---

## Phase 6 — Settings → Sites Tile

### Task 9: Google Jobs row in `SitesTile`

**Files:**
- Modify: `packages/web/src/routes/settings/SitesTile.tsx`
- Test: `packages/web/tests/routes/settings/SitesTile.google.test.tsx` (create)

**Approach.** Replace the existing "Google Jobs · Coming soon" pill with a real row backed by `useGoogleJobsStatus`. States:

| State | UI |
|---|---|
| `not_configured` | "Not configured" muted text, primary "Add SerpAPI key" CTA (opens an inline edit-key form) |
| `connected` | `● Connected` + "Last search 14m ago" caption, "Edit key" and "Disconnect" affordances |
| `key_invalid` | `⚠ Key invalid` warning + "Update key" CTA (same inline form, primed with the existing key field cleared) |
| `quota_exhausted` | `⚠ Quota exhausted` info + caption "Resolves on the next successful tick"; "Disconnect" affordance |

The inline edit-key form is a small `<input>` + Save/Cancel pair gated by local state (`editing: boolean`). On save it calls `useValidateSerpapiKey` and, on success, snaps back to the connected state via React Query invalidation.

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/routes/settings/SitesTile.google.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SitesTile } from '../../../src/routes/settings/SitesTile.js';

function harness(siteOverride: Record<string, unknown>, alerts: unknown[] = []) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/sites') && !init?.method)
      return new Response(JSON.stringify([
        { id: 'linkedin', display_name: 'LinkedIn', kind: 'browser', enabled: true,
          has_session: true, session_valid_at: '2026-05-13T10:00:00Z', last_search_at: null },
        { id: 'google', display_name: 'Google Jobs', kind: 'api',
          enabled: false, has_session: false, session_valid_at: null, last_search_at: null,
          ...siteOverride },
      ]), { status: 200 });
    if (u.endsWith('/api/sites/linkedin/status'))
      return new Response(JSON.stringify({ connected: true, attempting: false, last_success_at: null, error: null }), { status: 200 });
    if (u.includes('/api/alerts'))
      return new Response(JSON.stringify({ items: alerts }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, latency_ms: 1 }), { status: 200 });
  });

  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <SitesTile />
    </QueryClientProvider>,
  );
}

describe('SitesTile — Google Jobs', () => {
  it('renders Not configured by default', async () => {
    harness({});
    await waitFor(() => expect(screen.getByText(/google jobs/i)).toBeInTheDocument());
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add serpapi key/i })).toBeInTheDocument();
  });

  it('renders Connected with last_search_at', async () => {
    harness({ enabled: true, has_session: true, last_search_at: '2026-05-13T10:00:00Z' });
    await waitFor(() => expect(screen.getByText(/google jobs/i)).toBeInTheDocument());
    expect(screen.getByText(/connected/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
  });

  it('renders Key invalid when an open serpapi_key_invalid alert is present', async () => {
    harness(
      { enabled: true },
      [{ id: 'a1', site_id: 'google', kind: 'serpapi_key_invalid', status: 'open',
         severity: 'action_required', title: 'x', description: 'y', created_at: '2026-05-13T10:00:00Z' }],
    );
    await waitFor(() => expect(screen.getByText(/key invalid/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /update key/i })).toBeInTheDocument();
  });

  it('Save under the edit-key form POSTs candidate and switches back to connected', async () => {
    harness({});
    await waitFor(() => screen.getByRole('button', { name: /add serpapi key/i }));
    fireEvent.click(screen.getByRole('button', { name: /add serpapi key/i }));
    await userEvent.type(screen.getByLabelText(/serpapi key/i), 'live');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    // Fetch interceptor returns ok:true; expect input to disappear (back to row state).
    await waitFor(() => expect(screen.queryByLabelText(/serpapi key/i)).not.toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @vina/web test -- SitesTile.google`
Expected: FAIL — the current tile shows "Coming soon".

- [ ] **Step 3: Implement the row**

In `packages/web/src/routes/settings/SitesTile.tsx`, replace the existing Google Jobs `<li>` with a component that uses `useGoogleJobsStatus`, `useValidateSerpapiKey`, and `useDisconnectGoogleJobs`. The shape:

```tsx
function GoogleJobsRow(): JSX.Element {
  const status = useGoogleJobsStatus({ pollMs: 5000 });
  const validate = useValidateSerpapiKey();
  const disconnect = useDisconnectGoogleJobs();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSave = async (): Promise<void> => {
    setError(null);
    const res = await validate.mutate(key);
    if (res.ok) {
      setKey('');
      setEditing(false);
    } else {
      setError(res.detail ?? res.reason ?? 'Validation failed');
    }
  };

  const label = (() => {
    switch (status.data?.state) {
      case 'connected':
        return (
          <span className="text-success">
            ● Connected
            {status.data.last_search_at && (
              <span className="ml-2 text-ink-muted">
                · last search {new Date(status.data.last_search_at).toLocaleString()}
              </span>
            )}
          </span>
        );
      case 'key_invalid':
        return <span className="text-warning">⚠ Key invalid</span>;
      case 'quota_exhausted':
        return <span className="text-warning">⚠ Quota exhausted</span>;
      default:
        return <span className="text-ink-muted">○ Not configured</span>;
    }
  })();

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium text-ink-primary">Google Jobs</p>
          <p className="text-xs text-ink-secondary">{label}</p>
        </div>
        <div className="flex gap-2">
          {status.data?.state === 'not_configured' && (
            <Button size="sm" onClick={() => setEditing(true)}>Add SerpAPI key</Button>
          )}
          {status.data?.state === 'connected' && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit key</Button>
              <Button variant="ghost" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
                Disconnect
              </Button>
            </>
          )}
          {status.data?.state === 'key_invalid' && (
            <Button size="sm" onClick={() => setEditing(true)}>Update key</Button>
          )}
          {status.data?.state === 'quota_exhausted' && (
            <Button variant="ghost" size="sm" onClick={() => disconnect.mutate()}>Disconnect</Button>
          )}
        </div>
      </div>
      {editing && (
        <div className="space-y-2 rounded-md border border-border-subtle bg-surface-sunken p-3">
          <label className="block text-xs text-ink-muted">SerpAPI key
            <input
              type="password"
              autoComplete="off"
              aria-label="SerpAPI key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="mt-1 w-full rounded-md border border-border-subtle bg-surface-raised px-2 py-1 text-ink-primary"
            />
          </label>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={onSave} disabled={validate.isPending || key.trim().length === 0}>
              {validate.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setKey(''); setError(null); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
```

Add the necessary `useState` import + the new hook imports at the top of `SitesTile.tsx`. The Indeed row remains as "Coming soon" (out of scope per ADR-019).

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @vina/web test -- SitesTile`
Expected: PASS (the existing LinkedIn-row tests still pass).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/settings/SitesTile.tsx \
        packages/web/tests/routes/settings/SitesTile.google.test.tsx
git commit -m "feat(web): wire Google Jobs row in Settings sites tile"
```

---

## Phase 7 — JobCard Tweaks

### Task 10: Show `original_source` caption and tweak Apply label

**Files:**
- Modify: `packages/web/src/routes/jobs/JobCard.tsx`
- Test: `packages/web/tests/routes/jobs/JobCard.test.tsx` (extend; create if missing)

**Approach.** Two tiny changes:

1. Add a one-line caption under the `<header>` showing the `original_source` value (e.g. `via Greenhouse`) when present.
2. The Apply button currently reads "Apply on LinkedIn" hard-coded. Compute the label:
   - If `apply_method === 'auto'` → `Apply on LinkedIn` (unchanged).
   - Else if `original_source` is set → `Apply on ${stripVia(original_source)}` (e.g. `Apply on Greenhouse`).
   - Else → `Apply externally`.

`stripVia(s)` = `s.replace(/^via\s+/i, '')`.

- [ ] **Step 1: Write the failing test**

Append to (or create) `packages/web/tests/routes/jobs/JobCard.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JobCard } from '../../../src/routes/jobs/JobCard.js';
import type { Job } from '@vina/shared';

const baseManual: Job = {
  id: 'j1',
  site_id: 'google',
  external_id: 'ex',
  url: 'https://gh.io/x',
  external_apply_url: 'https://gh.io/x',
  apply_method: 'manual',
  original_source: 'via Greenhouse',
  title: 'Engineer',
  company: 'Acme',
  location: 'Remote',
  description: 'd',
  salary_text: null,
  posted_at: null,
  discovered_at: '2026-05-13T10:00:00Z',
  match_score: 85,
  match_justification: 'good',
  status: 'scored',
};

const noop = (): void => undefined;

describe('JobCard original_source', () => {
  it('renders the via caption under the header', () => {
    render(<JobCard job={baseManual} variant="new" onApply={noop} onMarkApplied={noop} onSkip={noop} onReopen={noop} />);
    expect(screen.getByText('via Greenhouse')).toBeInTheDocument();
  });

  it('uses original_source for the apply button label, stripped of the via prefix', () => {
    render(<JobCard job={baseManual} variant="new" onApply={noop} onMarkApplied={noop} onSkip={noop} onReopen={noop} />);
    expect(screen.getByRole('button', { name: 'Apply on Greenhouse' })).toBeInTheDocument();
  });

  it('falls back to Apply externally when original_source is null on a manual job', () => {
    render(
      <JobCard
        job={{ ...baseManual, original_source: null }}
        variant="new"
        onApply={noop} onMarkApplied={noop} onSkip={noop} onReopen={noop}
      />,
    );
    expect(screen.getByRole('button', { name: 'Apply externally' })).toBeInTheDocument();
  });

  it('keeps Apply on LinkedIn for auto-apply jobs', () => {
    render(
      <JobCard
        job={{ ...baseManual, apply_method: 'auto', site_id: 'linkedin', original_source: null }}
        variant="new"
        onApply={noop} onMarkApplied={noop} onSkip={noop} onReopen={noop}
      />,
    );
    expect(screen.getByRole('button', { name: 'Apply on LinkedIn' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @vina/web test -- JobCard`
Expected: FAIL — caption missing, label hard-coded.

- [ ] **Step 3: Update the component**

In `packages/web/src/routes/jobs/JobCard.tsx`:

```tsx
function applyLabel(job: Job): string {
  if (job.apply_method === 'auto') return 'Apply on LinkedIn';
  if (job.original_source) return `Apply on ${job.original_source.replace(/^via\s+/i, '')}`;
  return 'Apply externally';
}
```

Inside the `<header>` block, after the location span, render:

```tsx
{job.original_source && (
  <p className="basis-full text-xs text-ink-muted">{job.original_source}</p>
)}
```

(`basis-full` forces the caption onto its own line within the flex-wrap header.)

Replace the hard-coded button text:

```tsx
<Button variant="default" size="sm" onClick={onApply}>
  {applyLabel(job)}
</Button>
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm --filter @vina/web test -- JobCard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/jobs/JobCard.tsx \
        packages/web/tests/routes/jobs/JobCard.test.tsx
git commit -m "feat(web): show original_source caption and dynamic Apply label"
```

---

## Phase 8 — CLI Updates

### Task 11: `vina status` reports Google Jobs

**Files:**
- Modify: `packages/server/src/http/routes/system.ts` (extend `SystemStatus` payload)
- Modify: `packages/cli/src/commands/status.ts`
- Test: `packages/server/tests/http/system.google.test.ts` (create) + `packages/cli/tests/commands/status.test.ts` (extend if exists)

**Approach.** The `SystemStatus` payload at `GET /api/system/status` currently exposes `linkedin_connected` + `linkedin_last_search_at`. Add:

- `google_state: 'not_configured' | 'connected' | 'key_invalid' | 'quota_exhausted'`
- `google_last_search_at: string | null`

Derive from `sites` + `alerts` exactly the same way the web hook does. Update the CLI to print one line:

- `not_configured` → `Google Jobs: not configured`
- `connected` → `Google Jobs: connected (last search 14m ago)`
- `key_invalid` → `Google Jobs: key invalid`
- `quota_exhausted` → `Google Jobs: quota exhausted`

- [ ] **Step 1: Write the failing test**

Create `packages/server/tests/http/system.google.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppHandle } from './helpers.js';
import { setSerpApiKey } from '../../src/services/settings-service.js';
import { updateSiteEnabled, updateSiteSession } from '../../src/db/repositories/sites.js';
import { insertAlert } from '../../src/db/repositories/alerts.js';

let app: TestAppHandle;
beforeEach(async () => { app = await buildTestApp(); });
afterEach(async () => { await app.close(); });

describe('GET /api/system/status — google fields', () => {
  it('returns not_configured by default', async () => {
    const res = await app.request('GET', '/api/system/status');
    expect(res.json()).toMatchObject({ google_state: 'not_configured', google_last_search_at: null });
  });

  it('returns connected when key is set, enabled, and last_search_at present', async () => {
    setSerpApiKey(app.db, 'k');
    updateSiteEnabled(app.db, 'google', true);
    updateSiteSession(app.db, 'google', { session_path: null, session_valid_at: null, last_search_at: '2026-05-13T10:00:00Z' });
    const res = await app.request('GET', '/api/system/status');
    expect(res.json()).toMatchObject({ google_state: 'connected', google_last_search_at: '2026-05-13T10:00:00Z' });
  });

  it('returns key_invalid when an open serpapi_key_invalid alert exists', async () => {
    setSerpApiKey(app.db, 'k');
    updateSiteEnabled(app.db, 'google', true);
    insertAlert(app.db, {
      kind: 'serpapi_key_invalid',
      severity: 'action_required',
      title: 'x',
      description: 'y',
      site_id: 'google',
    });
    const res = await app.request('GET', '/api/system/status');
    expect(res.json()).toMatchObject({ google_state: 'key_invalid' });
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm --filter @vina/server test -- system.google`
Expected: FAIL — fields missing.

- [ ] **Step 3: Extend the route**

In `packages/server/src/http/routes/system.ts`, where `/api/system/status` is built, add:

```ts
const sitesList = listSites(db);
const google = sitesList.find((s) => s.id === 'google');
const openAlerts = listAlerts(db, { status: 'open' });
const hasGoogleAlert = (kind: string): boolean =>
  openAlerts.some((a) => a.site_id === 'google' && a.kind === kind);

const google_state: 'not_configured' | 'connected' | 'key_invalid' | 'quota_exhausted' =
  hasGoogleAlert('serpapi_key_invalid') ? 'key_invalid' :
  hasGoogleAlert('serpapi_quota_exhausted') ? 'quota_exhausted' :
  google?.enabled && hasSerpApiKey(db) ? 'connected' :
  'not_configured';

return {
  // existing fields …
  google_state,
  google_last_search_at: google?.last_search_at ?? null,
};
```

- [ ] **Step 4: Update the CLI**

In `packages/cli/src/commands/status.ts`, extend the `SystemStatus` interface and add:

```ts
google_state: 'not_configured' | 'connected' | 'key_invalid' | 'quota_exhausted';
google_last_search_at: string | null;
```

Inside `statusCommand`, after the LinkedIn line:

```ts
const googleLabel = (() => {
  switch (detail.google_state) {
    case 'connected':
      return detail.google_last_search_at
        ? `connected (last search ${detail.google_last_search_at})`
        : 'connected';
    case 'key_invalid': return 'key invalid';
    case 'quota_exhausted': return 'quota exhausted';
    default: return 'not configured';
  }
})();
process.stdout.write(`Google Jobs: ${googleLabel}\n`);
```

- [ ] **Step 5: Run the tests + build, expect pass**

Run: `pnpm --filter @vina/server test -- system && pnpm --filter @vina/cli build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/http/routes/system.ts \
        packages/server/tests/http/system.google.test.ts \
        packages/cli/src/commands/status.ts
git commit -m "feat(cli): add Google Jobs status line"
```

---

### Task 12: `vina doctor` adds SerpAPI checks

**Files:**
- Modify: `packages/cli/src/commands/doctor.ts`
- Test: extend an existing doctor test if present, otherwise create `packages/cli/tests/commands/doctor.test.ts`

**Approach.** Add two checks, both skipped gracefully when the daemon isn't running:

1. `SerpAPI key configured` — informational; **never** fails. Reports "configured" or "not configured (skipped)".
2. `SerpAPI key valid` — calls `POST /api/sites/google/test` with **no body** (validates the stored key). If `ok: true`, passes; if `ok: false`, fails with the `reason` as remediation; if no key configured, skipped (not a failure).

These slot between `checkLinkedInProfileDir` and `checkLlmProvider` in the `doctorCommand` array.

- [ ] **Step 1: Read the existing doctor pattern**

Read the existing `checkLinkedInProfileDir` and `checkLlmProvider` for the `CheckResult` shape conventions (skipped = `ok: true` with a `remediation: "skipped"` hint).

- [ ] **Step 2: Write the failing test**

Create or extend `packages/cli/tests/commands/doctor.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { doctorCommand } from '../../src/commands/doctor.js';

// The doctor command writes lines to stdout; capture them.
function captureStdout(fn: () => Promise<number>): Promise<{ rc: number; out: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // reason: doctor uses process.stdout.write directly (no logger); patch it
  process.stdout.write = ((chunk: string) => { chunks.push(chunk); return true; }) as never;
  return fn().then((rc) => {
    process.stdout.write = orig;
    return { rc, out: chunks.join('') };
  });
}

// Stub the readStatus + authedRequest layer per existing test idiom (re-use whatever
// the LinkedIn slice's doctor tests used; verify exact mock surface in `lib/api.ts`).

describe('doctorCommand — SerpAPI checks', () => {
  it('reports SerpAPI key not configured (skipped) when daemon present but no key', async () => {
    // Mocks: readStatus returns a daemon, /api/system/status reports no google config,
    // /api/sites/google/test {} → { ok:false, reason:'no_key_configured' }.
    const { out } = await captureStdout(doctorCommand);
    expect(out).toMatch(/SerpAPI key configured/);
    expect(out).toMatch(/SerpAPI key valid/);
    expect(out).toMatch(/skipped/i);
  });

  it('reports valid when daemon validates the stored key', async () => {
    // Mocks: /test → { ok:true, latency_ms: 5 }
    const { out } = await captureStdout(doctorCommand);
    expect(out).toMatch(/\[PASS\] SerpAPI key valid/);
  });
});
```

Fill in the mock plumbing per the existing doctor test idiom — the LinkedIn slice has a working example you can copy verbatim. Verify the exact module-mock pattern when implementing.

- [ ] **Step 3: Run the test, expect failure**

Run: `pnpm --filter @vina/cli test -- doctor`
Expected: FAIL — checks absent.

- [ ] **Step 4: Add the checks**

In `packages/cli/src/commands/doctor.ts`:

```ts
async function checkSerpApiKeyConfigured(): Promise<CheckResult> {
  const status = readStatus();
  if (!status) return { name: 'SerpAPI key configured', ok: true, remediation: 'daemon not running (skipped)' };
  try {
    const sys = await authedRequest<{ google_state: string }>(status.port, 'GET', '/api/system/status');
    return sys.google_state === 'not_configured'
      ? { name: 'SerpAPI key configured', ok: true, remediation: 'not configured (skipped)' }
      : { name: 'SerpAPI key configured', ok: true };
  } catch (err) {
    return { name: 'SerpAPI key configured', ok: false, remediation: (err as Error).message };
  }
}

interface ValidateResp { ok: boolean; reason?: string; detail?: string; latency_ms?: number }

async function checkSerpApiKeyValid(): Promise<CheckResult> {
  const status = readStatus();
  if (!status) return { name: 'SerpAPI key valid', ok: true, remediation: 'daemon not running (skipped)' };
  try {
    const sys = await authedRequest<{ google_state: string }>(status.port, 'GET', '/api/system/status');
    if (sys.google_state === 'not_configured') {
      return { name: 'SerpAPI key valid', ok: true, remediation: 'no key configured (skipped)' };
    }
    const res = await authedRequest<ValidateResp>(status.port, 'POST', '/api/sites/google/test', {});
    return res.ok
      ? { name: 'SerpAPI key valid', ok: true }
      : { name: 'SerpAPI key valid', ok: false, remediation: res.reason ?? res.detail ?? 'invalid' };
  } catch (err) {
    return { name: 'SerpAPI key valid', ok: false, remediation: (err as Error).message };
  }
}
```

Add both to the `checks` array inside `doctorCommand`, slotted after `checkLinkedInProfileDir`.

Verify the `authedRequest` signature supports a body argument (the existing usage is GET-only — extend the helper if needed, or use `fetch` directly here for the POST).

- [ ] **Step 5: Run the test + build, expect pass**

Run: `pnpm --filter @vina/cli test -- doctor && pnpm --filter @vina/cli build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/doctor.ts \
        packages/cli/tests/commands/doctor.test.ts
git commit -m "feat(cli): add SerpAPI doctor checks"
```

---

## Phase 9 — Integration Test

### Task 13: End-to-end Google Jobs slice against a SerpAPI fixture

**Files:**
- Create: `tests/fixtures/sites/google/server.ts`
- Create: `tests/fixtures/sites/google/pages.ts`
- Create: `packages/server/tests/integration/google-jobs-e2e.test.ts`

**Approach.** Mirror the LinkedIn fixture pattern. The fixture is a tiny Fastify server that returns canned `jobs_results` for `GET /search.json?engine=google_jobs&…`. The test:

1. Boots the fixture.
2. Builds a search handler with a custom `serpapiSearch` that calls `searchGoogleJobs` against the **fixture URL** rather than the real SerpAPI endpoint. (Easiest path: pass a wrapped iterator that swaps `SERPAPI_BASE` at call time. Simplest implementation: export an internal `createSearchGoogleJobs(baseUrl)` factory from the service so the test can inject the fixture URL — or, simpler still, have the test call `searchGoogleJobs` with a `fetchImpl` that rewrites the URL host.)
3. Seeds a profile, CV, search preferences, and stores a fake key via `setSerpApiKey`.
4. Runs the search handler, asserts jobs land with `apply_method='manual'`, `original_source='via Greenhouse'`, `external_apply_url` set.
5. Runs the score handler with a fake structured chat model, asserts jobs flip to `scored`.

The URL-rewriting approach keeps `serpapi-service.ts` clean — no new public knob needed.

- [ ] **Step 1: Build the fixture**

Create `tests/fixtures/sites/google/pages.ts`:

```ts
export const FIXTURE_JOBS_PAGE_1 = {
  jobs_results: [
    {
      job_id: 'g-1',
      title: 'Senior TypeScript Engineer',
      company_name: 'Acme Corp',
      location: 'Remote',
      via: 'via Greenhouse',
      description: 'Build TypeScript APIs.',
      detected_extensions: { salary: '$180K' },
      apply_options: [{ title: 'Apply on Greenhouse', link: 'https://gh.io/g-1' }],
    },
    {
      job_id: 'g-2',
      title: 'Staff Backend Engineer',
      company_name: 'Globex',
      location: 'New York',
      via: 'via Lever',
      description: 'Lead backend services.',
      apply_options: [{ title: 'Apply on Lever', link: 'https://lever.co/g-2' }],
    },
  ],
  serpapi_pagination: { next_page_token: 'pg2' },
};

export const FIXTURE_JOBS_PAGE_2 = {
  jobs_results: [
    {
      job_id: 'g-3',
      title: 'Junior Frontend Engineer',
      company_name: 'Initech',
      location: 'Remote',
      via: 'via Workday',
      description: 'Frontend work.',
      apply_options: [{ title: 'Apply', link: 'https://workday.com/g-3' }],
    },
  ],
};
```

Create `tests/fixtures/sites/google/server.ts`:

```ts
import Fastify from 'fastify';
import { FIXTURE_JOBS_PAGE_1, FIXTURE_JOBS_PAGE_2 } from './pages.js';

export interface GoogleFixtureHandle {
  url: string;
  close: () => Promise<void>;
}

export async function startGoogleJobsFixture(): Promise<GoogleFixtureHandle> {
  const app = Fastify({ logger: false });
  app.get('/search.json', async (req) => {
    const q = req.query as { next_page_token?: string };
    return q.next_page_token === 'pg2' ? FIXTURE_JOBS_PAGE_2 : FIXTURE_JOBS_PAGE_1;
  });
  const addr = await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    url: typeof addr === 'string' ? addr : `http://127.0.0.1:${(app.server.address() as { port: number }).port}`,
    close: async () => { await app.close(); },
  };
}
```

- [ ] **Step 2: Write the e2e test**

Create `packages/server/tests/integration/google-jobs-e2e.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createSearchHandler } from '../../src/queue/handlers/search.js';
import { createScoreHandler } from '../../src/queue/handlers/score.js';
import { createEventBus } from '../../src/events/bus.js';
import { freshTestDb } from '../db/helpers.js';
import { insertProfile } from '../../src/db/repositories/profile.js';
import { insertCv } from '../../src/db/repositories/cvs.js';
import { upsertSearchPreferences } from '../../src/db/repositories/search-preferences.js';
import { setSerpApiKey } from '../../src/services/settings-service.js';
import { listJobs, findJobById } from '../../src/db/repositories/jobs.js';
import { listPending } from '../../src/db/repositories/task-queue.js';
import { startGoogleJobsFixture, type GoogleFixtureHandle } from '../../../../tests/fixtures/sites/google/server.js';
import {
  searchGoogleJobs,
  type GoogleJobsListing,
  type GoogleJobsSearchInput,
} from '../../src/services/serpapi-service.js';

let db: DatabaseType;
let fixture: GoogleFixtureHandle;

beforeEach(async () => {
  db = freshTestDb();
  fixture = await startGoogleJobsFixture();
  insertProfile(db, { full_name: 'Pat', email: 'p@x.com', bio: 'Engineer' });
  insertCv(db, {
    label: 'main',
    original_filename: 'cv.pdf',
    mime_type: 'application/pdf',
    file_path: '/tmp/cv.pdf',
    extracted_text: 'TS, Postgres, AWS',
    is_default: true,
  });
  upsertSearchPreferences(db, {
    description: 'Senior backend',
    keywords: ['typescript'],
    locations: ['Remote'],
    work_models: ['remote'],
    seniority: ['senior'],
    excluded_companies: [],
  });
  setSerpApiKey(db, 'fixture-key');
});
afterEach(async () => {
  await fixture.close();
  db.close();
});

/**
 * Wraps the real searchGoogleJobs with a fetchImpl that rewrites the host
 * from serpapi.com → the fixture URL. The query string and behaviour are
 * otherwise identical to a real run.
 */
function searchGoogleJobsAgainstFixture(
  input: GoogleJobsSearchInput,
  opts: { apiKey: string },
): AsyncIterable<GoogleJobsListing> {
  return searchGoogleJobs(input, {
    apiKey: opts.apiKey,
    maxPages: 3,
    retryDelayMs: 1,
    fetchImpl: async (url) => {
      const u = new URL(typeof url === 'string' ? url : url.toString());
      const rewritten = new URL(u.pathname + u.search, fixture.url);
      return fetch(rewritten);
    },
  });
}

describe('Google Jobs slice — end-to-end', () => {
  it('search → score → applied flow against the SerpAPI fixture', async () => {
    const bus = createEventBus();
    const fakeBM = { getContext: async () => ({ newPage: async () => ({}) }), closeAll: async () => {} } as never;

    const search = createSearchHandler({
      db,
      bus,
      browserManager: fakeBM,
      adapters: {},
      serpapiSearch: searchGoogleJobsAgainstFixture,
    });

    await search({ site_id: 'google' });

    const jobs = listJobs(db, { site_id: 'google' });
    expect(jobs.map((j) => j.external_id).sort()).toEqual(['g-1', 'g-2', 'g-3']);
    expect(jobs.every((j) => j.apply_method === 'manual')).toBe(true);
    expect(jobs.every((j) => j.external_apply_url !== null)).toBe(true);
    expect(jobs.find((j) => j.external_id === 'g-1')?.original_source).toBe('via Greenhouse');

    // Score each one with a fake model.
    const fakeModel = {
      withStructuredOutput: () => ({ invoke: async () => ({ score: 80, justification: 'ok' }) }),
    } as unknown as BaseChatModel;
    const score = createScoreHandler({ db, bus, buildModel: async () => fakeModel });
    for (const t of listPending(db).filter((p) => p.kind === 'score')) {
      await score(JSON.parse(t.payload) as { job_id: string });
    }

    const scored = listJobs(db, { status: 'scored', site_id: 'google' });
    expect(scored.length).toBe(3);
    expect(scored[0]!.match_score).toBe(80);

    // Mark one applied (simulates POST /api/jobs/:id/applied).
    const { updateJobStatus } = await import('../../src/db/repositories/jobs.js');
    updateJobStatus(db, scored[0]!.id, 'applied_manually');
    expect(findJobById(db, scored[0]!.id)?.status).toBe('applied_manually');
  }, 30_000);
});
```

- [ ] **Step 3: Run the test**

Run: `pnpm --filter @vina/server test -- google-jobs-e2e`
Expected: PASS. If it fails due to the URL-rewriting fetch, double-check the fixture path is `/search.json` and the rewritten URL keeps the `engine=google_jobs&q=…` query string (it should — `URL` preserves search params).

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/sites/google/ \
        packages/server/tests/integration/google-jobs-e2e.test.ts
git commit -m "test(server): end-to-end Google Jobs slice integration test"
```

---

## Phase 10 — Final Verification

### Task 14: Run full test + lint + build matrix and update specs

**Files:**
- Modify: `docs/superpowers/specs/2026-05-13-google-jobs-source-design.md` (flip status to "implemented")

- [ ] **Step 1: Run everything**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: PASS across all packages. If any LinkedIn slice tests regressed, the dispatch refactor in Task 4 likely missed a code path — fix before continuing.

- [ ] **Step 2: Update spec status**

In `docs/superpowers/specs/2026-05-13-google-jobs-source-design.md`, line 3, change:

```
**Status:** Designed (2026-05-13).
```

to:

```
**Status:** Implemented (2026-05-13).
```

- [ ] **Step 3: Manual verification (golden path)**

In a fresh data dir:

1. `vina start` — daemon comes up.
2. Open the web UI; the wizard shows.
3. Walk through Welcome → Profile → CV → LLM Provider.
4. New step **Google Jobs** loads. Paste a real or fake SerpAPI key:
   - Bad key → red banner with `auth_failed`.
   - Good key → `✓ Connected to SerpAPI`, auto-advances to Preferences after 1s.
   - Click **Skip for now** instead → routes to Preferences immediately, `sites.google.enabled` stays 0.
5. Complete the rest of the wizard (Preferences → Schedule → Connect LinkedIn → Done).
6. From the Jobs page, click **Search now** for `google` (or wait for the scheduler tick).
7. Listings appear with the `via Greenhouse` caption and `Apply on Greenhouse` button. Click Apply → opens the external URL in a new tab.
8. Mark applied / Skip works identically to the LinkedIn flow.
9. Settings → Sites shows the Google Jobs row as `● Connected · last search …`. Click Disconnect → flips to `○ Not configured`.
10. Re-enable by clicking **Add SerpAPI key** → inline form → Save → status returns to Connected.
11. `vina status` reports `Google Jobs: connected (last search …)`.
12. `vina doctor` reports `[PASS] SerpAPI key configured` and `[PASS] SerpAPI key valid`.

If any step fails, fix the underlying bug before moving on.

- [ ] **Step 4: Final commit**

```bash
git add docs/superpowers/specs/2026-05-13-google-jobs-source-design.md
git commit -m "docs: mark Google Jobs source spec as implemented"
```

---

## Appendix A — Migration Notes

- `001_init.sql` already seeds the `google` site row; no schema change there is needed.
- `003_serpapi_alert_kinds.sql` is forward-only. Like `002`, it must rebuild the `alerts` table because SQLite cannot ALTER a CHECK constraint. The migration runner wraps each file in a transaction — a partial failure rolls back.
- The `idx_alerts_status` index is recreated at the end of the migration since it dies with the dropped table.
- The `alerts.site_id` foreign key still references `sites(id) ON DELETE CASCADE`; the rebuild preserves this constraint.

## Appendix B — Mapping Spec § to Tasks

| Spec § | Tasks |
|---|---|
| §1.1, §1.2 (goal & ships) | All tasks |
| §2 (architecture & data flow) | 4, 13 |
| §2.3 (data mapping) | 3 (mapper), 4 (insertion), 10 (UI rendering) |
| §3 (SerpAPI service) | 3 |
| §3.3 (key handling) | 3 (redaction), 4 (read + missing-key alert) |
| §3.4 (rate-limit + retry) | 3 (retry + 429), 4 (alert + schedule failure) |
| §3.5 (error taxonomy / alert kinds) | 1 (migration), 2 (enum), 3 (errors), 4 (emission) |
| §4.1, §4.2 (wizard step) | 8 |
| §4.3 (Settings → Sites tile) | 9 |
| §4.4 (schedule wiring) | 4 (verification step) |
| §5 (Jobs page reuse + JobCard caption + apply label) | 10 |
| §6.1 (WS events — reuse existing `search:*`) | 4 |
| §6.2 (edge cases — drop on missing apply_options, dedupe, rotate key) | 3 (drop), 4 (dedupe via insertJob), 7 (forget key) |
| §6.3 (CLI) | 11, 12 |
| §8 (out of scope) | None — explicitly not implemented |
| §9 (success criteria) | 13 (e2e), 14 (manual golden path) |

## Appendix C — What Stays Hidden / Unchanged

- `linkedin-connect-service.ts`, the LinkedIn adapter, selector cache, headed-browser login — all untouched.
- The Indeed row in the Sites tile stays as "Coming soon" (ADR-019).
- The existing `validateSerpApiKey` export in `serpapi-service.ts` is preserved verbatim for the M6 wizard + settings test endpoint. The new `searchGoogleJobs` and error classes are additive.
- The score handler from the LinkedIn slice already folds the default CV into `ScoreInput`; no Google-specific change is required. The Google Jobs e2e test exercises that path implicitly via the score handler call in Task 13.
- The `JobStatus` enum is unchanged — Google Jobs listings flow through the same `new → scored → applied_manually | skipped` states.
- The Indeed and auto-apply pipelines remain untouched; the manual-apply pipeline (Phase B) and form-walker (Phase C) are out of scope here.

---

## Appendix D — Test Seam Summary

| Seam | Why it exists | Used in |
|---|---|---|
| `SearchGoogleJobsOpts.fetchImpl` | Drive paginated iteration / error branches without a real HTTP server | Task 3 unit tests |
| `SearchGoogleJobsOpts.retryDelayMs` | Avoid the 2s backoff slowing CI | Tasks 3, 13 |
| `SearchGoogleJobsOpts.maxPages` | Bound the iterator in tests | Tasks 3, 13 |
| `SearchHandlerDeps.serpapiSearch` | Substitute a controlled async iterable in the dispatch test | Task 4 unit tests + Task 13 e2e |
| URL-rewriting `fetchImpl` (e2e) | Point the real iterator at the Fastify fixture host | Task 13 |

Every seam is **optional** — the production code paths default to the real implementations and require no flags or env vars.
