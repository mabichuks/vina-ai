# Design: Easy Apply trigger fix + failure classification + retry

Date: 2026-07-05
Status: approved in session ("go ahead")

Diagnosed failure (application `01KWSD39480FNMJ5T59X96W2W3`, job "Senior
Software Engineer @ Bounce Digital"): the 2026 LinkedIn job page renders the
Easy Apply CTA as an anchor (`role=link`, name "Easy Apply to this job"), the
apply flow's private trigger list only matches `button` selectors, and a bare
`'form'` entry in the modal-detection list false-positived on the page's
global-nav search form — so the flow "walked" a non-form, found no submit
button, and parked the application as `awaiting_user`/`other`: a state with
no resume path, no retry surface, and no pending task.

## 1. Trigger selector unification (automation)

- Delete the private `EASY_APPLY_TRIGGER_SELECTORS` in
  `packages/automation/src/adapters/linkedin/application.ts` (~line 20).
- The apply flow uses `EASY_APPLY_SELECTORS` from
  `packages/automation/src/adapters/linkedin/selectors.ts` — the single
  source of truth that already knows the anchor variants
  (`a.jobs-apply-button[href*="openSDUIApplyFlow"]`, `…[href*="/apply/"]`)
  and the 2026 button variant.

## 2. Form-root tightening (automation)

`APPLY_FORM_ROOT_SELECTORS` loses the bare `'form'` catch-all. Remaining:
`[role="dialog"]`, `#easy-apply`, `form[data-vina-fixture="easy-apply"]`.
The fixture's on-page form matches via the scoped entries; a page's
global-nav search form can no longer masquerade as the apply modal.

### Fixture additions

- `easyApplyAnchorDetailPage()`: job detail page whose CTA is
  `<a class="jobs-apply-button" href="…openSDUIApplyFlow…">Easy Apply to
  this job</a>`; clicking it injects the standard fixture form into the DOM
  (inline script, `preventDefault`). The page also contains a decoy
  `<form class="global-nav-typeahead">` mimicking LinkedIn's nav search —
  regression net for the `'form'` false positive.
- Served at `GET /jobs/view/easy-anchor`.

## 3. Failure classification (orchestrator)

Submit failures keep `awaiting_user` ONLY for reasons the user can resolve
via the existing alert-resolution flow: `missing_field`, `captcha`,
`session_expired`. Any other submit failure (`other` — e.g. submit button
missing) returns `outcome: 'failed'` with the same reason/detail. The graph
still raises its screenshot-bearing alert (`raiseSubmitFailureAlert`); the
result gains `alertRaised: true` so the apply handler's failed-path does not
insert a duplicate alert.

`docs/langgraph-orchestrator.md` outcome table updated accordingly (if it
documents the mapping).

## 4. Retry surface (server + web)

- New route `POST /api/applications/:id/retry`:
  - 404 unknown id; 409 if `apply_method !== 'auto'` or status not in
    `('awaiting_user', 'failed')`.
  - If the application is non-terminal (`awaiting_user`): flip it to
    `failed` first (preserve its `failure_reason`), emit
    `application:updated`.
  - Enqueue a fresh attempt via the existing `enqueueEasyApplyForJob`
    (creates a new application + apply task; existing dedupe/gate semantics
    unchanged).
  - 202 `{ application_id, status, deduped }` (the NEW application).
- Web `ApplicationsPage`: a "Retry" button on rows with
  `apply_method === 'auto'` and status `awaiting_user` or `failed`, via a
  `useRetryApplication` hook; success toast names the new attempt.
- `docs/api-spec.md`: document the retry endpoint.

This also unblocks the currently stuck application: it will show a Retry
button (awaiting_user + auto).

## Tests

- Automation integration: apply flow completes on the anchor-variant page
  (clicks the anchor, real fixture form opens despite the decoy nav form);
  form-root detection ignores the decoy.
- Orchestrator graph: submit failure `other` → `failed` (+ `alertRaised`);
  `missing_field` still → `awaiting_user`.
- Server route: retry on awaiting_user auto app → old app failed, new app
  queued + task enqueued; 409 on manual apps and terminal-but-submitted
  states; 404 unknown.
- Web: Retry button visible for auto+awaiting_user/failed rows only; click
  fires the mutation.

## Out of scope

Auto-retry policies, resumable form_state reuse across retries, alert-based
resume changes.
