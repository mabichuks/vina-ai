# Design: Jobs page sort + filters

Date: 2026-07-05
Status: approved in session ("go")

Follows on from `2026-07-05-session-stop-pagination-design.md` §3 (pagination).
User request: sort by date and by score; filter by Easy Apply / not Easy
Apply and by source (LinkedIn, Google Jobs, Indeed).

## Server — `GET /api/jobs`

`ListQuerySchema` (`packages/server/src/http/routes/jobs.ts`) gains three
optional params, all forwarded to the existing repository filters:

- `site_id`: `z.enum(['linkedin', 'indeed', 'google'])` — already supported
  by `buildJobWhere`; this change merely exposes it.
- `apply_method`: `z.enum(['auto', 'manual'])` — same.
- `sort`: `z.enum(['score', 'date']).default('score')`.

Repository (`packages/server/src/db/repositories/jobs.ts`):

- `JobFilters` gains `sort?: 'score' | 'date'`.
- `listJobs` picks its ORDER BY from a whitelist keyed by `sort` — never
  interpolating user input:
  - `score` (default, current behaviour):
    `ORDER BY match_score DESC NULLS LAST, discovered_at DESC, id DESC`
  - `date`: `ORDER BY discovered_at DESC, id DESC`
- `countJobs` is unaffected (sort doesn't change the WHERE); `total` stays
  correct for any filter combination because both share `buildJobWhere`.

`docs/api-spec.md`: remove the "(not yet implemented — accepted by the
repository layer only)" annotations for `site_id`/`apply_method`; document
`sort` (default `score`).

## Web — Jobs page control row

A compact control row rendered between the tab nav and the list, on all
three tabs:

- **Sort** select: `Best match` (`score`, default) / `Newest` (`date`).
- **Apply type** select: `All` (omit param) / `Easy Apply` (`auto`) /
  `External` (`manual`).
- **Source** select: `All sources` (omit) / `LinkedIn` / `Google Jobs` /
  `Indeed` (`site_id`).

Behaviour:

- Defaults reproduce today's page exactly (score sort, no filters).
- Control state lives in `JobsPage` component state (not URL) — consistent
  with the existing tab state.
- Any control change re-anchors to page 1 via the existing render-phase
  `filterKey` mechanism (the key widens to include sort/filter values).
- `useJobsPage` (`packages/web/src/api/resources.ts`) forwards the new
  params; `JobsFilters` gains `site_id`, `apply_method`, `sort`. The query
  key already serialises the full query string, so refetching is automatic.
- Native `<select>` elements styled with the existing input classes — no
  new dependency; matches the codebase's minimal-shadcn approach.
- Empty result under a filter shows the existing empty-state copy (plain
  "no jobs match" line for filtered states rather than the tab-specific
  onboarding copy, to avoid claiming "No new jobs yet" when the filter is
  the cause).

## Tests

- Route: `site_id`/`apply_method` filter items AND `total`; `sort=date`
  orders newest-first regardless of score; invalid enum values 400.
- Repo: `listJobs` sort whitelist — `date` ordering vs default `score`
  ordering (seed with score/date inversions).
- Web: control row renders with defaults; changing a select updates the
  fetched query string (assert via mocked fetch) and resets to page 1.

## Out of scope

URL-persisted filter state, free-text search box (repo `search` filter
stays unexposed), multi-select sources, sort direction toggles.
