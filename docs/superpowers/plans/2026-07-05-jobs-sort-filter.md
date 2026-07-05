# Jobs Sort + Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sort (score/date) and filters (apply method, source) on `GET /api/jobs` and the Jobs page.

**Architecture:** Per `docs/superpowers/specs/2026-07-05-jobs-sort-filter-design.md`. Server exposes repository filters that already exist (`site_id`, `apply_method`) plus a whitelisted `sort`; web adds a control row whose state feeds the existing paged query and page-reset mechanism.

**Tech Stack:** TypeScript, Fastify + zod, better-sqlite3, React 18, TanStack Query v5, Vitest.

## Global Constraints

- Strict TypeScript; no default exports; comments why-not-what.
- Commits: single short Conventional-Commit subject line, no body, no bylines.
- Tests run from the REPO ROOT: `npx vitest run <paths>` (per-package `pnpm --filter X test` does not work).
- ORDER BY must come from a code whitelist — user input must never be interpolated into SQL.
- Defaults must reproduce current behaviour byte-for-byte (sort=score ordering, no filters).

---

### Task 1: Server — sort param + exposed filters

**Files:**
- Modify: `packages/server/src/db/repositories/jobs.ts` (JobFilters, listJobs ORDER BY)
- Modify: `packages/server/src/http/routes/jobs.ts` (ListQuerySchema + handler, ~lines 23-51)
- Test: `packages/server/tests/http/jobs.test.ts`, `packages/server/tests/db/repositories/jobs.test.ts`
- Docs: `docs/api-spec.md` (GET /api/jobs params)

**Interfaces:**
- Consumes: existing `buildJobWhere`, `countJobs`, `ApplyMethod` type.
- Produces: `JobFilters.sort?: 'score' | 'date'`; route accepts `site_id` (`linkedin|indeed|google`), `apply_method` (`auto|manual`), `sort` (`score|date`, default `score`). Task 2 relies on these exact param names and values.

- [ ] **Step 1: Write the failing tests**

`packages/server/tests/http/jobs.test.ts`, inside `describe('GET /api/jobs', ...)`. The file's `seedJob` helper hard-codes `site_id: 'linkedin'` and `apply_method: 'auto'` — extend its options instead of duplicating it: add `site_id?: string; apply_method?: 'auto' | 'manual'` to its `opts` and pass through (`site_id: opts.site_id ?? 'linkedin'`, `apply_method: opts.apply_method ?? 'auto'`).

```ts
  it('filters by apply_method and reflects it in total', async () => {
    seedJob({ score: 80, status: 'scored', apply_method: 'auto' });
    seedJob({ score: 81, status: 'scored', apply_method: 'manual' });
    seedJob({ score: 82, status: 'scored', apply_method: 'manual' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/jobs?status=scored&apply_method=auto',
      headers: auth(h.token),
    });
    expect(res.json().items).toHaveLength(1);
    expect(res.json().total).toBe(1);
  });

  it('filters by site_id', async () => {
    seedJob({ score: 80, status: 'scored', site_id: 'linkedin' });
    seedJob({ score: 81, status: 'scored', site_id: 'google' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/jobs?status=scored&site_id=google',
      headers: auth(h.token),
    });
    expect(res.json().items).toHaveLength(1);
    expect(res.json().total).toBe(1);
  });

  it('sort=date orders newest-first regardless of score', async () => {
    // seedJob inserts sequentially — discovered_at is monotonically increasing,
    // so the LAST seeded job is the newest. Give it the LOWEST score so the
    // two sort orders disagree.
    seedJob({ score: 90, status: 'scored', title: 'Old high' });
    seedJob({ score: 50, status: 'scored', title: 'New low' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/jobs?status=scored&sort=date',
      headers: auth(h.token),
    });
    const titles = (res.json().items as { title: string }[]).map((j) => j.title);
    expect(titles[0]).toBe('New low');
    const byScore = await h.app.inject({
      method: 'GET',
      url: '/api/jobs?status=scored',
      headers: auth(h.token),
    });
    expect((byScore.json().items as { title: string }[])[0]!.title).toBe('Old high');
  });

  it('rejects unknown sort and site_id values', async () => {
    for (const url of ['/api/jobs?sort=title', '/api/jobs?site_id=monster']) {
      const res = await h.app.inject({ method: 'GET', url, headers: auth(h.token) });
      expect(res.statusCode).toBe(400);
    }
  });
```

Note: if two sequential inserts land on the same millisecond, `discovered_at DESC, id DESC` tie-breaks by ULID id, which is also monotonic — the assertion holds either way.

`packages/server/tests/db/repositories/jobs.test.ts` (mirror the file's existing seeding style):

```ts
  it('listJobs sort=date orders by discovered_at desc', () => {
    // seed two jobs where score order and date order disagree (see the file's
    // insert helper), then:
    const byDate = listJobs(db, { sort: 'date' });
    const byScore = listJobs(db, {});
    expect(byDate[0]!.id).not.toBe(byScore[0]!.id);
    expect(Date.parse(byDate[0]!.discovered_at)).toBeGreaterThanOrEqual(
      Date.parse(byDate[1]!.discovered_at),
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/server/tests/http/jobs.test.ts packages/server/tests/db/repositories/jobs.test.ts`
Expected: new tests FAIL — `sort=title` currently returns 200 (schema strips unknown keys), `apply_method`/`site_id` are ignored (no filtering), `sort=date` has no effect. Pre-existing tests PASS.

- [ ] **Step 3: Repository — sort whitelist**

In `packages/server/src/db/repositories/jobs.ts`:

Add to `JobFilters`:

```ts
  /** Result ordering: 'score' (default — best match first) or 'date' (newest first). */
  sort?: 'score' | 'date';
```

In `listJobs`, replace the hard-coded ORDER BY with a whitelist lookup (keep the existing comment with the score entry):

```ts
  // ORDER BY comes from this fixed whitelist — `sort` is user input and must
  // never reach the SQL string directly.
  const ORDER_BY: Record<'score' | 'date', string> = {
    // Best matches first (score DESC), unscored rows pinned to the bottom so
    // the worklist stays stable while scores stream in. Ties broken by recency.
    score: 'match_score DESC NULLS LAST, discovered_at DESC, id DESC',
    date: 'discovered_at DESC, id DESC',
  };
  const sql = `
    SELECT * FROM jobs
    ${whereSql}
    ORDER BY ${ORDER_BY[filters.sort ?? 'score']}
    LIMIT @limit OFFSET @offset
  `;
```

- [ ] **Step 4: Route — expose the params**

In `packages/server/src/http/routes/jobs.ts`, extend `ListQuerySchema`:

```ts
const ListQuerySchema = z.object({
  status: StatusFilterSchema.optional(),
  min_score: z.coerce.number().int().min(0).max(100).optional(),
  site_id: z.enum(['linkedin', 'indeed', 'google']).optional(),
  apply_method: z.enum(['auto', 'manual']).optional(),
  sort: z.enum(['score', 'date']).default('score'),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
});
```

In the handler, widen `filterArgs` and thread `sort` (sort goes to `listJobs` only — `countJobs` takes filters without it):

```ts
    const filterArgs = {
      ...(status && { status }),
      ...(q.min_score !== undefined && { min_score: q.min_score }),
      ...(q.site_id && { site_id: q.site_id }),
      ...(q.apply_method && { apply_method: q.apply_method }),
    };
    const items = listJobs(db, {
      ...filterArgs,
      sort: q.sort,
      limit: q.page_size,
      offset,
    });
    const total = countJobs(db, filterArgs);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/server/tests/http/jobs.test.ts packages/server/tests/db/repositories/jobs.test.ts`
Expected: ALL PASS.

- [ ] **Step 6: Update `docs/api-spec.md`**

In the `GET /api/jobs` section: delete the "(not yet implemented — accepted by the repository layer only)" annotations on `site_id` and `apply_method`; add `sort` — `score` (default, best match first) | `date` (newest first). Note `q`/free-text search remains unimplemented at the route (leave its annotation if present).

- [ ] **Step 7: Commit**

```bash
git add packages/server docs/api-spec.md
git commit -m "feat(server): sort and site/apply-method filters on GET /api/jobs"
```

---

### Task 2: Web — control row on the Jobs page

**Files:**
- Modify: `packages/web/src/api/resources.ts` (`JobsFilters`, `useJobsPage` query string)
- Modify: `packages/web/src/routes/jobs/JobsPage.tsx` (control row, filterKey, empty state)
- Test: `packages/web/tests/routes/jobs/JobsPage.controls.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1's query params (`site_id`, `apply_method`, `sort`).
- Produces: `JobsFilters` gains `site_id?: 'linkedin' | 'indeed' | 'google'`, `apply_method?: 'auto' | 'manual'`, `sort?: 'score' | 'date'`.

- [ ] **Step 1: Extend the hook**

In `packages/web/src/api/resources.ts`:

`JobsFilters` gains:

```ts
  site_id?: 'linkedin' | 'indeed' | 'google';
  apply_method?: 'auto' | 'manual';
  sort?: 'score' | 'date';
```

In `useJobsPage`, after the `min_score` line, forward them (omit when unset so defaults stay server-side):

```ts
  if (filters.site_id) qs.set('site_id', filters.site_id);
  if (filters.apply_method) qs.set('apply_method', filters.apply_method);
  if (filters.sort) qs.set('sort', filters.sort);
```

- [ ] **Step 2: Write the failing page test**

Create `packages/web/tests/routes/jobs/JobsPage.controls.test.tsx`. Look at an existing page-level test for provider wiring (`packages/web/tests/routes/dashboard/EasyApplyCard.test.tsx` shows the QueryClientProvider pattern; JobsPage also needs a Router — wrap in `MemoryRouter` from react-router-dom). Mock `fetch` to return `{ items: [], page: 1, page_size: 10, total: 0 }` for `/api/jobs*` and sensible empties for the other queries the page fires (`/api/search-preferences` → `{ score_threshold: 70 }`-shaped preferences object or `null`, `/api/sites/linkedin/status` → `{}`, `/api/applications*` → `{ items: [] }`).

```tsx
  it('renders sort and filter controls with defaults', async () => {
    renderJobsPage();
    expect(await screen.findByLabelText(/sort/i)).toHaveValue('score');
    expect(screen.getByLabelText(/apply type/i)).toHaveValue('');
    expect(screen.getByLabelText(/source/i)).toHaveValue('');
  });

  it('changing a control adds the param to the jobs request', async () => {
    const fetchSpy = renderJobsPage();
    fireEvent.change(await screen.findByLabelText(/apply type/i), {
      target: { value: 'auto' },
    });
    await waitFor(() => {
      const jobCalls = fetchSpy.mock.calls
        .map(([u]) => String(u))
        .filter((u) => u.includes('/api/jobs?'));
      expect(jobCalls.at(-1)).toContain('apply_method=auto');
      expect(jobCalls.at(-1)).toContain('page=1');
    });
  });
```

(`renderJobsPage` is a local helper returning the fetch spy; write it in the test file.)

Run: `npx vitest run packages/web/tests/routes/jobs/JobsPage.controls.test.tsx` — expected FAIL (no such controls).

- [ ] **Step 3: JobsPage control row**

In `packages/web/src/routes/jobs/JobsPage.tsx`:

State + filterKey (extend the existing block, lines ~42-57):

```ts
  const [sort, setSort] = useState<'score' | 'date'>('score');
  const [applyMethod, setApplyMethod] = useState<'' | 'auto' | 'manual'>('');
  const [siteId, setSiteId] = useState<'' | 'linkedin' | 'indeed' | 'google'>('');
  const filterKey = `${tab}:${minScore}:${sort}:${applyMethod}:${siteId}`;
```

Query call gains the params:

```ts
  const jobs = useJobsPage({
    status: STATUS_FILTER_FOR_TAB[tab],
    ...(tab === 'new' && { min_score: minScore }),
    ...(applyMethod && { apply_method: applyMethod }),
    ...(siteId && { site_id: siteId }),
    sort,
    page,
    page_size: PAGE_SIZE,
  });
```

Control row, rendered directly below the `<nav>` tabs:

```tsx
      <div className="flex flex-wrap items-center gap-3">
        <ControlSelect
          label="Sort"
          value={sort}
          onChange={(v) => setSort(v as 'score' | 'date')}
          options={[
            { value: 'score', label: 'Best match' },
            { value: 'date', label: 'Newest' },
          ]}
        />
        <ControlSelect
          label="Apply type"
          value={applyMethod}
          onChange={(v) => setApplyMethod(v as '' | 'auto' | 'manual')}
          options={[
            { value: '', label: 'All' },
            { value: 'auto', label: 'Easy Apply' },
            { value: 'manual', label: 'External' },
          ]}
        />
        <ControlSelect
          label="Source"
          value={siteId}
          onChange={(v) => setSiteId(v as '' | 'linkedin' | 'indeed' | 'google')}
          options={[
            { value: '', label: 'All sources' },
            { value: 'linkedin', label: 'LinkedIn' },
            { value: 'google', label: 'Google Jobs' },
            { value: 'indeed', label: 'Indeed' },
          ]}
        />
      </div>
```

Helper component at the bottom of the file (module scope, named export not required — it's file-local):

```tsx
interface ControlSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}

function ControlSelect({ label, value, onChange, options }: ControlSelectProps): JSX.Element {
  return (
    <label className="flex items-center gap-2">
      <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border-default bg-surface-sunken px-2 py-1.5 text-sm text-ink-primary outline-none focus:border-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
```

Empty state: when a non-default filter is active and the list is empty, show a filter-aware line instead of the tab copy. Replace the empty-state ternary's body:

```tsx
      ) : jobs.items.length === 0 ? (
        <p className="text-sm text-ink-secondary">
          {applyMethod || siteId
            ? 'No jobs match the current filters.'
            : tab === 'new'
              ? 'No new jobs yet. Try Search now once LinkedIn is connected.'
              : tab === 'applied'
                ? 'You haven’t marked anything applied yet.'
                : 'Nothing skipped.'}
        </p>
      ) : (
```

(Keep the existing curly apostrophe in the applied copy — it's intentional user-facing text.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/web/tests` — new test passes, all pre-existing pass (JobsPage's other tests, if any, unaffected: defaults add only `sort=score` to the query string — update any test asserting the exact jobs URL).

- [ ] **Step 5: Rebuild + commit**

```bash
pnpm --filter @vina/web build
git add packages/web
git commit -m "feat(web): sort and filter controls on Jobs page"
```

---

### Task 3: Verification

- [ ] Run: `npx vitest run packages/server/tests packages/web/tests` — all pass.
- [ ] Run: `pnpm lint 2>&1 | tail -3` — no NEW errors (baseline: 15 pre-existing).
- [ ] Run: `pnpm build` — clean.
- [ ] Curl smoke: `GET /api/jobs?status=new,scored&apply_method=auto&sort=date` against the live daemon returns only `apply_method: 'auto'` items, newest first.
