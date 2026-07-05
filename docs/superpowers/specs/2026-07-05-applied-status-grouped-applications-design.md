# Design: job status on Easy Apply submission + grouped application history

Date: 2026-07-05
Status: approved in session

User request: (1) a job whose Easy Apply application was submitted still
shows status `scored` and stays in the Jobs worklist — it should read as
applied; (2) the Applications tab and the dashboard Easy Apply card list
every attempt row — only the current/most recent per job should show, with
expandable history.

## 1. Job status flip on submission (server)

- In the apply handler's `submitted` outcome branch
  (`packages/server/src/queue/handlers/apply.ts`), after the application
  status write: `updateJobStatus(db, job.id, 'submitted')` and a
  `jobs:updated` emit (reuse the branch's existing emit if one fires).
- `submitted` already exists in the jobs status enum — no schema change.
- Web Jobs page: the Applied tab filter widens from `'applied_manually'`
  to `['applied_manually', 'submitted']` so Easy Apply submissions appear
  there (and, being non-`new`/`scored`, drop out of the New tab).
- One-off data fix for the live DB (not a migration — data, not schema):
  flip jobs that already have a submitted application. Run manually at
  deploy: `UPDATE jobs SET status='submitted' WHERE status='scored' AND id
  IN (SELECT job_id FROM applications WHERE status='submitted')`.

## 2. Grouped application history

### Applications tab (web, client-side grouping)

- `ApplicationsPage` groups fetched rows by `job_id`; the representative
  row is the latest by `started_at`. When a group has more than one row, it
  shows an "×N attempts" toggle; expanding renders the older attempts as
  visually-subordinate rows beneath it (same columns, muted).
- Grouping is client-side — the page already fetches up to 100 rows and
  the grouping is a pure presentation concern. No API change.
- Collapse state is per-job, default collapsed, reset on refetch is
  acceptable.

### Dashboard Easy Apply card (server-side)

- `/api/dashboard/easy-apply`'s `recent` list dedupes to the latest
  application per job in SQL (`ROW_NUMBER() OVER (PARTITION BY job_id
  ORDER BY started_at DESC) = 1`), keeping its existing limit and shape —
  no web change needed beyond what renders today.

## Tests

- Apply handler: submitted outcome flips the job row to `submitted`.
- Dashboard route: two applications for one job → `recent` contains only
  the newer one.
- Web: ApplicationsPage with 3 rows across 2 jobs renders 2 top-level rows;
  the multi-attempt job shows "×2 attempts"; expanding reveals the older
  row. Jobs page Applied tab request includes `status=applied_manually,submitted`.

## Out of scope

Server-side grouping/pagination of applications, attempt-count badges on
the Jobs page, retention/pruning of old attempts.
