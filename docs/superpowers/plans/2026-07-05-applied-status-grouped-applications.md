# Applied Status + Grouped Applications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Easy Apply submission flips the job to `submitted` (visible in the Jobs Applied tab); Applications tab and dashboard show one row per job (latest attempt) with expandable history.

**Architecture:** Per `docs/superpowers/specs/2026-07-05-applied-status-grouped-applications-design.md`. Server: two small changes (handler job flip, dashboard SQL dedupe). Web: Applied-tab filter widening + client-side grouping on ApplicationsPage.

**Tech Stack:** TypeScript, Fastify, better-sqlite3 (window functions OK), React 18, Vitest.

## Global Constraints

- Tests run from the REPO ROOT: `npx vitest run <paths>`.
- Commits: single short Conventional-Commit subject line, no body, no bylines.
- Strict TS; comments why-not-what.
- CURLY-QUOTE WARNING: after every `.tsx`/`.ts` edit, run `grep -n $'‘\|’\|“\|”' <file>` — only pre-existing user-facing apostrophes in copy are legitimate.

---

### Task 1: Server — job flip on submission + dashboard latest-per-job

**Files:**
- Modify: `packages/server/src/queue/handlers/apply.ts` (submitted branch, ~lines 242-251)
- Modify: `packages/server/src/http/routes/dashboard.ts` (`recent` query, ~lines 24-36)
- Test: `packages/server/tests/integration/apply-e2e.test.ts` (or the handler test that exercises the submitted path — check both; add the job-status assertion where the submitted outcome is already tested), `packages/server/tests/http/dashboard.test.ts`

**Interfaces:**
- Consumes: existing `updateJobStatus(db, jobId, status)` from the jobs repository (verify import name in the handler; add the import).
- Produces: job rows flip to `'submitted'` on successful Easy Apply. Task 2's Applied tab relies on this status value.

- [ ] **Step 1: Failing tests**

Handler/e2e: find where the submitted outcome is asserted (`packages/server/tests/integration/apply-e2e.test.ts` "submits a job with all-resolvable fields..."). Add to that test:

```ts
    const jobAfter = findJobById(h.db ?? db, jobId); // adapt to the file's handles
    expect(jobAfter?.status).toBe('submitted');
```

(Adapt variable names to the file; import `findJobById` from the jobs repository if not present.)

Dashboard (`packages/server/tests/http/dashboard.test.ts` — read its seeding helpers):

```ts
  it('recent dedupes to the latest application per job', async () => {
    // seed ONE job with TWO auto applications: older failed (started_at earlier),
    // newer submitted (started_at later) — use the file's seeding pattern; if
    // started_at is set by insertApplication, update it with raw SQL to force ordering.
    // GET /api/dashboard/easy-apply
    // expect body.recent to contain exactly ONE entry for that job — the newer application_id
  });
```

Run: `npx vitest run packages/server/tests/integration/apply-e2e.test.ts packages/server/tests/http/dashboard.test.ts`
Expected: both new assertions FAIL (job stays `scored`; `recent` has 2 rows).

- [ ] **Step 2: Handler flip**

In `packages/server/src/queue/handlers/apply.ts`, submitted branch — after the `updateApplicationStatus(..., 'submitted', ...)` call and before/alongside the existing emits:

```ts
      // The job row mirrors the terminal application state so the Jobs
      // worklist drops it and the Applied tab picks it up.
      updateJobStatus(deps.db, job.id, 'submitted');
      deps.bus.emit('jobs:updated', { ids: [job.id] });
```

Import `updateJobStatus` from `../../db/repositories/jobs.js` (check existing imports in the file first).

- [ ] **Step 3: Dashboard dedupe**

In `packages/server/src/http/routes/dashboard.ts`, replace the `recent` query with a latest-per-job window:

```ts
    const recent = db
      .prepare(
        `SELECT application_id, title, company, status, submitted_at, updated_at FROM (
           SELECT a.id AS application_id, j.title AS title, j.company AS company,
                  a.status AS status, a.submitted_at AS submitted_at,
                  a.started_at AS updated_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY a.job_id ORDER BY a.started_at DESC
                  ) AS rn
             FROM applications a
             JOIN jobs j ON j.id = a.job_id
            WHERE a.apply_method = 'auto'
              AND a.started_at >= datetime('now', '-24 hours')
         )
         WHERE rn = 1
         ORDER BY updated_at DESC
         LIMIT 20`,
      )
      .all() as RecentRow[];
```

One-line comment above: retries create one application per attempt; the card shows the current attempt per job, not the whole history.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/server/tests/integration/apply-e2e.test.ts packages/server/tests/http/dashboard.test.ts packages/server/tests/queue/handlers`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "feat(server): submitted Easy Apply flips job status; dashboard recent dedupes per job"
```

---

### Task 2: Web — Applied tab includes submitted + grouped ApplicationsPage

**Files:**
- Modify: `packages/web/src/routes/jobs/JobsPage.tsx` (STATUS_FILTER_FOR_TAB, ~line 35)
- Modify: `packages/web/src/routes/applications/ApplicationsPage.tsx` (grouping + expand)
- Test: `packages/web/tests/routes/applications/ApplicationsPage.grouping.test.tsx` (new); update `packages/web/tests/routes/jobs/JobsPage.controls.test.tsx` only if it asserts the applied-tab status param.

**Interfaces:**
- Consumes: Task 1's `'submitted'` job status; existing `useApplications` hook (rows have `job_id`, `started_at`, `status`, `failure_reason`, `apply_method`).
- Produces: pure presentation changes; exported-for-test helper `groupByJob(rows)` in ApplicationsPage.

- [ ] **Step 1: Applied tab widening**

In `packages/web/src/routes/jobs/JobsPage.tsx`:

```ts
const STATUS_FILTER_FOR_TAB: Record<Tab, JobStatus | JobStatus[]> = {
  new: ['new', 'scored'],
  // Easy Apply submissions land as 'submitted'; the manual pipeline uses
  // 'applied_manually'. The user-facing Applied tab means both.
  applied: ['applied_manually', 'submitted'],
  skipped: 'skipped',
};
```

- [ ] **Step 2: Failing grouping test**

Create `packages/web/tests/routes/applications/ApplicationsPage.grouping.test.tsx` (mirror the provider/fetch-mock pattern of `ApplicationsPage.retry.test.tsx` — read it first). Mock `/api/applications` with three rows: job A newer `submitted` + job A older `failed` (earlier `started_at`), job B single `ready_for_manual_apply`.

```tsx
  it('shows one row per job with an attempts toggle', async () => {
    renderPage();
    // exactly one row per job at top level:
    expect(await screen.findAllByText(/Job A Title/)).toHaveLength(1);
    // the multi-attempt job shows the toggle, the single-attempt one doesn't:
    const toggle = screen.getByRole('button', { name: /2 attempts/i });
    expect(screen.queryAllByRole('button', { name: /attempts/i })).toHaveLength(1);
    // top-level row is the NEWER attempt:
    expect(screen.getByText('submitted')).toBeInTheDocument();
    expect(screen.queryByText('failed')).not.toBeInTheDocument();
  });

  it('expanding reveals the older attempts', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /2 attempts/i }));
    expect(await screen.findByText('failed')).toBeInTheDocument();
  });
```

Adapt text queries to the page's real rendering (status renders with underscores replaced — check the component). Run: `npx vitest run packages/web/tests/routes/applications/ApplicationsPage.grouping.test.tsx` — FAILS.

- [ ] **Step 3: Grouping implementation**

In `packages/web/src/routes/applications/ApplicationsPage.tsx`:

1. Module-scope helper (export it for the test):

```ts
export interface ApplicationGroup<T extends { job_id: string; started_at: string }> {
  latest: T;
  history: T[]; // older attempts, newest first
}

/**
 * One group per job: the latest attempt is the representative row; older
 * attempts (retries create one application per attempt) become expandable
 * history. Rows arrive in any order — sort within group by started_at desc.
 */
export function groupByJob<T extends { job_id: string; started_at: string }>(
  rows: T[],
): ApplicationGroup<T>[] {
  const byJob = new Map<string, T[]>();
  for (const row of rows) {
    const list = byJob.get(row.job_id) ?? [];
    list.push(row);
    byJob.set(row.job_id, list);
  }
  return [...byJob.values()]
    .map((list) => {
      const sorted = [...list].sort(
        (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at),
      );
      return { latest: sorted[0]!, history: sorted.slice(1) };
    })
    .sort(
      (a, b) => Date.parse(b.latest.started_at) - Date.parse(a.latest.started_at),
    );
}
```

2. Component state: `const [expanded, setExpanded] = useState<Set<string>>(new Set());` keyed by `latest.job_id`; a `toggle(jobId)` that copies the set.

3. Render: map `groupByJob(rows)` instead of `rows`. The representative row renders exactly as today plus, when `group.history.length > 0`, an inline toggle button in the job cell:

```tsx
  <button
    type="button"
    className="ml-2 rounded-pill bg-surface-sunken px-2 py-0.5 font-mono text-2xs text-ink-secondary hover:text-ink-primary"
    aria-expanded={expanded.has(group.latest.job_id)}
    onClick={() => toggle(group.latest.job_id)}
  >
    ×{group.history.length + 1} attempts
  </button>
```

4. When expanded, render each history row beneath as the same `<tr>` markup with muted styling (`className="opacity-60"` on the row, and suppress action buttons on history rows — history attempts are superseded; only the representative row gets Retry/mark-applied actions).

Preserve everything else (columns, badges, failure_reason line, retry button condition — which now applies to the representative row only).

- [ ] **Step 4: Run web tests**

Run: `npx vitest run packages/web/tests` — new tests pass; `ApplicationsPage.retry.test.tsx` must still pass (its mocked rows are single-attempt, so grouping is a no-op for it; if its mock rows share a job_id, adjust expectations accordingly). Check the Jobs controls test for an applied-tab URL assertion (`status=applied_manually`) — update to `applied_manually,submitted` if present. Curly-quote grep on both edited files.

- [ ] **Step 5: Commit**

```bash
git add packages/web
git commit -m "feat(web): group applications by job with expandable history; Applied tab includes submitted"
```

---

### Task 3: Verification + live data fix

- [ ] `npx vitest run packages/server/tests packages/web/tests` — all pass.
- [ ] `pnpm lint 2>&1 | tail -3` — no new errors; `pnpm build` — clean.
- [ ] Restart the daemon (`node packages/cli/dist/bin.js stop && node packages/cli/dist/bin.js start`).
- [ ] One-off live-data fix (data, not schema — run against the live DB):
  `sqlite3 "$HOME/Library/Application Support/vina-nodejs/vina.db" "UPDATE jobs SET status='submitted' WHERE status='scored' AND id IN (SELECT job_id FROM applications WHERE status='submitted')"`
- [ ] Smoke: GET `/api/jobs?status=applied_manually,submitted` returns the Bounce Digital job; GET `/api/dashboard/easy-apply` `recent` has one row per job.
