# Easy Apply Trigger + Classification + Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Easy Apply flow click the 2026 anchor-variant CTA, stop mistaking the nav search form for the apply modal, classify unresolvable submit failures as `failed`, and give failed/stuck auto-applications a Retry button.

**Architecture:** Per `docs/superpowers/specs/2026-07-05-easy-apply-trigger-retry-design.md`. Three tasks: automation selectors + fixtures; orchestrator classification; server retry route + web button.

**Tech Stack:** TypeScript, Playwright fixtures, LangGraph orchestrator, Fastify, React 18, Vitest.

## Global Constraints

- Tests run from the REPO ROOT: `npx vitest run <paths>` (per-package `pnpm --filter X test` does not work).
- Commits: single short Conventional-Commit subject line, no body, no bylines.
- Strict TS; comments why-not-what; no default exports.
- WARNING for all web/JSX edits: two prior tasks on this branch hit an Edit-tool failure mode where straight quotes in replacement strings arrived as typographic curly quotes and broke the build. After every edit to a `.tsx`/`.ts` file, run `grep -n $'‘\|’\|“\|”' <file>` and verify the only hit (if any) is pre-existing user-facing copy (the apostrophe in "haven't" on JobsPage/ApplicationsPage empty states).

---

### Task 1: Automation — trigger unification + form-root tightening + anchor fixture

**Files:**
- Modify: `packages/automation/src/adapters/linkedin/application.ts` (delete `EASY_APPLY_TRIGGER_SELECTORS` ~line 20-25; trim `APPLY_FORM_ROOT_SELECTORS` ~line 28-33; update the `findElementByGoal` call ~line 183-187)
- Modify: `tests/fixtures/sites/linkedin/pages.ts` (add `easyApplyAnchorDetailPage()`)
- Modify: `tests/fixtures/sites/linkedin/server.ts` (route `GET /jobs/view/easy-anchor`)
- Test: `packages/automation/tests/adapters/linkedin-application.integration.test.ts`

**Interfaces:**
- Consumes: `EASY_APPLY_SELECTORS` from `packages/automation/src/adapters/linkedin/selectors.ts` (already exported — verify; export it if not).
- Produces: fixture page `easyApplyAnchorDetailPage()` at `/jobs/view/easy-anchor`. No API changes.

- [ ] **Step 1: Fixture page**

In `tests/fixtures/sites/linkedin/pages.ts`, read `detailPageBase` and `FIXTURE_LISTINGS` first, then add (adapting the base-call shape to match the existing `easyApplyDetailPage`):

```ts
/**
 * 2026 anchor-variant Easy Apply detail page. The CTA is an <a> (role=link,
 * accessible name "Easy Apply to this job"), not a <button> — the real page
 * that broke the apply flow on 2026-07-05. Also carries a decoy global-nav
 * search <form> so tests pin the form-root false positive: the apply flow
 * must NOT treat that form as the application modal.
 */
export function easyApplyAnchorDetailPage(): string {
  const cta = `
    <form class="global-nav-typeahead" action="/search"><input name="q" placeholder="Search" /></form>
    <a class="jobs-apply-button" href="/jobs/view/easy/apply?openSDUIApplyFlow=true"
       aria-label="Easy Apply to this job">Easy Apply to this job</a>
    <div id="anchor-apply-slot"></div>
    <script>
      document.querySelector('a.jobs-apply-button').addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('anchor-apply-slot').innerHTML =
          document.getElementById('anchor-apply-template').innerHTML;
      });
    </script>
  `;
  return detailPageBase(FIXTURE_LISTINGS.easy, cta) +
    // The template holds the SAME form markup the button-variant page shows
    // inline — reuse the existing fixture form snippet if pages.ts exposes
    // one; otherwise embed a minimal copy with the data-vina-fixture root.
    `<template id="anchor-apply-template">${'' /* see note below */}</template>`;
}
```

Note: read how `easyApplyDetailPage()`/`detailPageBase` embed the fixture form (`form[data-vina-fixture="easy-apply"]` with its fields and submit button). Reuse that exact form markup inside the template — extract it to a shared `const EASY_APPLY_FORM_HTML` if it's currently inlined, so both pages share one copy. The template must yield, after click, a form that the apply flow can walk and submit exactly like the button-variant page.

In `tests/fixtures/sites/linkedin/server.ts`:

```ts
    app.get('/jobs/view/easy-anchor', async (_req, reply) =>
      reply.type('text/html').send(easyApplyAnchorDetailPage()),
    );
```

- [ ] **Step 2: Failing integration test**

In `packages/automation/tests/adapters/linkedin-application.integration.test.ts`, mirror the existing happy-path Easy Apply test (read it first — reuse its arrange/act helpers) but navigate to `/jobs/view/easy-anchor`:

```ts
  it('clicks the 2026 anchor-variant Easy Apply CTA and completes the flow', async () => {
    // arrange: same as the button-variant happy-path test, but the page is
    // /jobs/view/easy-anchor (anchor CTA + decoy nav form).
    // assert: startLinkedInApplication resolves (form root found AFTER the
    // click), and the walk/submit path completes as in the button test.
  }, 60_000);
```

Write it as a real test by copying the button-variant test body and changing the URL + assertions as needed. Run:
`npx vitest run packages/automation/tests/adapters/linkedin-application.integration.test.ts`
Expected: the new test FAILS — with the decoy form present, the current code either matches the decoy instantly (bare `'form'`) and then fails downstream, or never clicks the anchor.

- [ ] **Step 3: Implement**

In `packages/automation/src/adapters/linkedin/application.ts`:

1. Delete the `EASY_APPLY_TRIGGER_SELECTORS` const. Import `EASY_APPLY_SELECTORS` from `./selectors.js` and pass it to the `findElementByGoal(page, 'easy_apply', …)` call instead.
2. Trim the form-root list:

```ts
/**
 * Selectors for the Easy Apply form root / modal. First match wins.
 * Deliberately NO bare 'form' catch-all: LinkedIn's job page always has a
 * global-nav search <form>, which once masqueraded as the apply modal and
 * sent the flow walking a form with no fields (2026-07-05 incident).
 */
const APPLY_FORM_ROOT_SELECTORS = [
  '[role="dialog"]',
  '#easy-apply',
  'form[data-vina-fixture="easy-apply"]',
] as const;
```

- [ ] **Step 4: Run automation tests**

Run: `npx vitest run packages/automation/tests/adapters/linkedin-application.integration.test.ts packages/automation/tests/adapters/linkedin.test.ts`
Expected: ALL PASS, including the pre-existing button-variant tests (the fixture form matches via the scoped selector).

- [ ] **Step 5: Commit**

```bash
git add packages/automation tests/fixtures/sites/linkedin
git commit -m "fix(automation): apply flow clicks anchor Easy Apply CTA, no bare-form modal match"
```

---

### Task 2: Orchestrator — unresolvable submit failures are `failed`

**Files:**
- Modify: `packages/orchestrator/src/graphs/apply.ts` (submit-failure branch ~lines 186-200; `ApplyResult` type ~lines 41-60)
- Modify: `packages/server/src/queue/handlers/apply.ts` (failed-branch alert dedupe, ~lines 260-282)
- Test: `packages/orchestrator/tests/graphs/apply.test.ts`, `packages/server/tests/queue/handlers/apply.gate.test.ts` (only if it asserts the old mapping)

**Interfaces:**
- Consumes: existing `ApplyResult` union and reason enum.
- Produces: `ApplyResult` gains optional `alertRaised?: boolean`; submit failures with reason NOT in `('missing_field','captcha','session_expired')` return `outcome: 'failed'` with `alertRaised: true`. Task 3's retry button relies on such applications landing in status `failed`.

- [ ] **Step 1: Failing graph test**

In `packages/orchestrator/tests/graphs/apply.test.ts`, find the existing submit-failure test (asserting `awaiting_user` for a failed submit) and read its toolkit-stub pattern. Add:

```ts
  it("classifies an unresolvable submit failure ('other') as failed, not awaiting_user", async () => {
    // arrange: toolkit stub whose submit() resolves { ok: false, reason: 'other', detail: 'no submit button found' }
    // act: run the apply graph as the neighbouring tests do
    // assert:
    //   expect(result.outcome).toBe('failed');
    //   expect(result.reason).toBe('other');
    //   expect(result.alertRaised).toBe(true);
  });

  it('keeps awaiting_user for resolvable submit failures (missing_field)', async () => {
    // same stub with reason: 'missing_field' → outcome 'awaiting_user'
  });
```

Write both as real tests using the file's existing stub helpers. Run:
`npx vitest run packages/orchestrator/tests/graphs/apply.test.ts` — first FAILS.

- [ ] **Step 2: Graph change**

In `packages/orchestrator/src/graphs/apply.ts`, submit-failure branch — replace the unconditional `awaiting_user` return:

```ts
        record('submit_failed', { reason: submitted.reason });
        await raiseSubmitFailureAlert({
          toolKit,
          formId,
          applicationId: input.applicationId,
          job,
          outcome: submitted,
        });
        // 'awaiting_user' is reserved for pauses the user can actually
        // resolve through alert resolution (answer a field, clear a captcha,
        // re-login). Anything else — submit button missing, unexpected DOM —
        // is a hard failure: terminal status, retryable from the
        // Applications page. alertRaised stops the apply handler from
        // inserting a second alert on the failed path.
        const resolvable = ['missing_field', 'captcha', 'session_expired'];
        if (resolvable.includes(submitted.reason)) {
          return {
            outcome: 'awaiting_user',
            applicationId: input.applicationId,
            reason: submitted.reason,
            failureDetail: submitted.detail,
            events,
          };
        }
        return {
          outcome: 'failed',
          applicationId: input.applicationId,
          reason: submitted.reason,
          failureDetail: submitted.detail,
          alertRaised: true,
          events,
        };
```

Add `alertRaised?: boolean;` to the failed-shape of `ApplyResult` (read the type first; put it wherever `failureDetail` lives).

- [ ] **Step 3: Handler alert dedupe**

In `packages/server/src/queue/handlers/apply.ts` failed-outcome branch (~lines 260-282): wrap its `insertAlert` call with `if (!result.alertRaised) { … }` and a one-line why-comment (the graph already raised a screenshot-bearing alert for submit failures).

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/orchestrator/tests/graphs/apply.test.ts packages/server/tests/queue/handlers/apply.gate.test.ts packages/server/tests/queue/handlers/apply.route-defense.test.ts packages/server/tests/integration/apply-e2e.test.ts`
Expected: ALL PASS. If apply-e2e asserted `awaiting_user` for an 'other' submit failure, update that assertion to the new mapping (`failed`) — that's the intended behaviour change, note it in the report.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator packages/server
git commit -m "fix(orchestrator,server): unresolvable submit failures are terminal failed, single alert"
```

---

### Task 3: Server retry route + web Retry button

**Files:**
- Modify: `packages/server/src/http/routes/applications.ts` (add retry route; read the file first for deps/patterns)
- Modify: `packages/web/src/api/resources.ts` (add `useRetryApplication`)
- Modify: `packages/web/src/routes/applications/ApplicationsPage.tsx` (Retry button)
- Test: `packages/server/tests/http/applications.test.ts`, `packages/web/tests/routes/applications/ApplicationsPage.retry.test.tsx` (new)
- Docs: `docs/api-spec.md` (retry endpoint)

**Interfaces:**
- Consumes: `enqueueEasyApplyForJob(db, bus, jobId)` (existing, idempotent); `updateApplicationStatus`; `findApplicationById` (check exact repo names in `packages/server/src/db/repositories/applications.ts`).
- Produces: `POST /api/applications/:id/retry` → 202 `{ application_id, status, deduped }` (the NEW application); 404 unknown; 409 non-auto or status outside `('awaiting_user','failed')`.

- [ ] **Step 1: Failing route tests**

In `packages/server/tests/http/applications.test.ts` (read its seeding helpers first — it has a way to create an application in a given status):

```ts
describe('POST /api/applications/:id/retry', () => {
  it('flips an awaiting_user auto application to failed and enqueues a fresh attempt', async () => {
    // seed job + auto application in status 'awaiting_user' with failure_reason 'other'
    // POST /api/applications/<id>/retry
    // expect 202; body.application_id !== old id
    // old application: status 'failed', failure_reason still 'other'
    // new application exists in status 'queued'; task_queue has a pending apply task for it
  });

  it('retries a failed auto application without touching the old row', async () => {
    // seed status 'failed' → 202, old row unchanged, new application queued
  });

  it('409s for manual applications and for submitted ones', async () => {
    // manual apply_method → 409; status 'submitted' → 409
  });

  it('404s for unknown ids', async () => {});
});
```

Write them fully using the file's helpers. Run: `npx vitest run packages/server/tests/http/applications.test.ts` — new tests FAIL (404 route not found).

- [ ] **Step 2: Route**

In `packages/server/src/http/routes/applications.ts` (mirror the file's existing route style, e.g. mark-applied):

```ts
  // Re-run a dead auto-application. The old row is terminalised (failed)
  // so the enqueuer's active-application dedupe can't return it, then a
  // fresh application + apply task is created through the normal path.
  app.post('/api/applications/:id/retry', async (req, reply) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const application = findApplicationById(db, id);
    if (!application) throw new NotFoundError(`Application ${id} not found`);
    if (application.apply_method !== 'auto') {
      throw new ConflictError('Only auto (Easy Apply) applications can be retried');
    }
    if (!['awaiting_user', 'failed'].includes(application.status)) {
      throw new ConflictError(`Cannot retry an application in status ${application.status}`);
    }
    if (application.status === 'awaiting_user') {
      updateApplicationStatus(db, id, 'failed', {
        failure_reason: application.failure_reason ?? 'superseded_by_retry',
      });
      bus.emit('application:updated', { id, status: 'failed' });
    }
    const result = enqueueEasyApplyForJob(db, bus, application.job_id);
    return reply.status(202).send({
      application_id: result.application_id,
      status: result.status,
      deduped: result.deduped,
    });
  });
```

Adjust names to the file's actual imports (`ConflictError` from `@vina/shared`; check `updateApplicationStatus` signature for the options bag; check the route file already has `bus` in deps — if not, add it and update `app.ts` registration).

- [ ] **Step 3: Run route tests**

`npx vitest run packages/server/tests/http/applications.test.ts` — ALL PASS.

- [ ] **Step 4: Web hook + button**

`packages/web/src/api/resources.ts` (next to `useMarkApplied`):

```ts
export function useRetryApplication(): {
  mutate: (id: string) => Promise<{ application_id: string; status: string; deduped: boolean }>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<
    { application_id: string; status: string; deduped: boolean },
    Error,
    string
  >({
    mutationFn: (id) =>
      api(`/api/applications/${id}/retry`, { method: 'POST', body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['applications'] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
  return { mutate: (id) => mut.mutateAsync(id), isPending: mut.isPending };
}
```

`ApplicationsPage.tsx`: read the row-action area (where mark-applied/skip buttons render) and add, for rows with `apply_method === 'auto'` and status `awaiting_user` or `failed`:

```tsx
  {row.apply_method === 'auto' &&
    (row.status === 'awaiting_user' || row.status === 'failed') && (
      <Button
        variant="ghost"
        size="sm"
        disabled={retry.isPending}
        onClick={() =>
          void retry
            .mutate(row.id)
            .then(() => pushToast({ kind: 'success', message: 'Retry queued.' }))
            .catch((err) =>
              pushToast({
                kind: 'error',
                message: err instanceof Error ? err.message : String(err),
              }),
            )
        }
      >
        Retry
      </Button>
    )}
```

Wire `const retry = useRetryApplication();` and the page's existing `pushToast` pattern (add it if the page doesn't have one — check first).

- [ ] **Step 5: Web test**

Create `packages/web/tests/routes/applications/ApplicationsPage.retry.test.tsx` (mirror provider/mocking patterns from `packages/web/tests/routes/jobs/JobsPage.controls.test.tsx`): mock `/api/applications` to return one auto+awaiting_user row and one manual+ready row; assert exactly one Retry button; click it; assert a POST to `/api/applications/<id>/retry`.

Run: `npx vitest run packages/web/tests` — ALL PASS. Run the curly-quote grep on both edited web files.

- [ ] **Step 6: Docs + commit**

`docs/api-spec.md`: add the retry endpoint under Applications (202 shape, 404/409 rules, note that awaiting_user rows are terminalised to failed).

```bash
git add packages/server packages/web docs/api-spec.md
git commit -m "feat(server,web): retry action for dead Easy Apply applications"
```

---

### Task 4: Verification

- [ ] `npx vitest run packages/automation/tests packages/orchestrator/tests packages/server/tests packages/web/tests packages/shared/tests` — all pass (automation Playwright suites are slow; budget ~5 min).
- [ ] `pnpm lint 2>&1 | tail -3` — no new errors (baseline 15, all pre-existing).
- [ ] `pnpm build` — clean.
- [ ] Live smoke (daemon must be restarted to load new server/orchestrator code): `POST /api/applications/01KWSD39480FNMJ5T59X96W2W3/retry` with bearer token → 202, new application queued; the stuck application flips to failed.
