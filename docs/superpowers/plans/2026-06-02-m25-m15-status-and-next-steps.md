# M25 + M15 status and next steps (2026-06-02)

A snapshot of what shipped, what's wired into production, what's deferred,
and the prioritised follow-up work. Hand-off doc — pick up in a new
conversation by re-reading this first.

## What shipped

### M25 — Managed CDP, snapshot/act, prompts → markdown, skill system

All six bullets from `docs/build-order.md` M25 either landed or were
explicitly scoped down with reasons.

| Bullet | Status | Notes |
|---|---|---|
| 1. ADRs + `browser_stealth` setting | ✅ done | f57051f |
| 2. Managed CDP transport | ✅ done | 33884aa — `launchCdpSession`, loopback port, `connectOverCDP` |
| 3. Snapshot/ref primitive + SiteAdapter snapshot/act | ✅ done | 88161db, 555f5e7 — accname via `Accessibility.getFullAXTree`, one-shot stale-ref retry |
| 4. Deterministic walker + LLM fallback | ✅ done (split from M15) | bf83374, affaa78, e4fd70f — walker, fallback, resolver |
| 5. Prompts → markdown + Settings UI | ✅ done | 26dbc7f → bb6f1bf — loader, identity tests, CRUD, UI |
| 6. Skill registry + Settings UI | ✅ done (chatbot deferred) | b806648 → ff0d045 — registry, REST, UI; chatbot propose-then-confirm waits on M20 |

### M15 — Apply graph and form walker (auto-apply, LinkedIn)

Status flipped from "deferred indefinitely" to shipped on 2026-06-02. The
six chunks plus follow-up hardening:

| Chunk | Commit | What |
|---|---|---|
| 15 | fa3ae87 | `detect/captcha.ts` + `detect/session.ts` heuristics |
| 16 | 2912324 | `AutoApplyToolKit` interface + `graphs/apply.ts` skeleton with LLM fallback |
| 17 | 33b03c5 | LinkedIn adapter form methods + Easy Apply fixture tests |
| 18 | 259fa67 | Server-side `AutoApplyToolKit` + `apply` task handler + route defence |
| 19 | b1c971b | Resume-on-alert-resolve service |
| 20 | a376cf7 | End-to-end fixture test (happy + missing-field-resume) |
| 21 | 5c89568 | a11y-name fallback for perimeter actions + skip upload when CV pre-attached |

Post-M15 hardening from live testing against real LinkedIn:

- 02b0d36 — `VINA_PORT=0` parses correctly (test was silently using default)
- 46da936 — `Applications` page wired up so live progress is visible in the UI
- 682d68e — Skip CV tailoring for LinkedIn (uses profile resume; saves
  10–20s and an LLM call per apply)
- d8a4c04 + 29fa83c — `FallbackDecisionSchema` reshaped for OpenAI strict
  mode (no `oneOf` at root, every key in `required`, `value` nullable
  with runtime refine)
- 0a24508 — Optional fields stay blank when LLM says skip; only required
  fields escalate to `missing_field` alert
- de3602a — `fillField` dispatches by role: combobox → `.selectOption()`,
  checkbox → `.check()`/`.uncheck()`, radio → `.check()`, else `.fill()`.
  Also: apply handler wraps `runApply` to convert unexpected throws into
  `apply_failed` alerts
- 04c35b5 — Submit-button patterns widened + visible-buttons logged on
  locator miss
- 45736b2 — `startLinkedInApplication` throws clear errors when the
  Easy Apply button isn't visible or the listing is already-applied;
  handler raises `apply_failed` for every failed outcome; sidebar shows
  total open-alerts count
- e84d972 — Easy Apply trigger polled for 15s with overlay dismissal
  (Premium upsell "Not now" buttons) between polls; `awaiting_user`
  status now distinct from `awaiting_approval`
- 4da5fb8 — Submit success detection: widened selectors and
  form-root-disappeared heuristic for cohorts whose confirmation copy
  doesn't match any pattern

### What's in production today

- `vina start` boots the daemon with all of the above wired in
- Apply task handler is registered and pulls `kind='apply'` from the queue
- Three test applications successfully exercised the path end-to-end
  against real LinkedIn (one submitted, two failed cleanly on closed
  listings)
- Applications page, Alerts page, Prompts page, Skills page all live

## What's deferred

These were called out and explicitly skipped during M25/M15 work. Each
has a clear reason; reviving any of them is a deliberate scope decision.

### From M25

- **`tailor-cv` no-fabrication sentinel** — the spec calls for a
  `<!-- vina:no-fabrication -->` marker in the default prompt body and
  server-side validation rejecting edits that drop it. Skipped because
  the sentinel-in-body subtly changes prompt bytes; the byte-identity
  test caught it. Easy add later: put the sentinel in
  `prompts/tailor-cv.md`, update the (now-deleted) identity test, add the
  drop-on-write validation in `prompts-service.ts`.
- **Five missing starter skills** — only `browser-apply` ships. The other
  six listed in `docs/skill-system.md` §5 (`cv-tailoring`, `cover-letter`,
  `answer-questions`, `job-scoring`, `manual-apply-prep`, `prompt-editing`)
  are pure markdown authoring, ~30 min of writing.
- **`apply.md` + `chat.md` prompts** — `apply.md` listed in
  `docs/prompt-system.md` §3 as `editable_by_user: false`; `chat.md`
  depends on a chat graph that doesn't exist (M20).
- **Chatbot propose-then-confirm for prompts and skills** — bullet 5 step
  5 and bullet 6 step 4 from M25. Both need a chat graph (M20).
- **`apply` graph LLM-tier element locator** — we have selectors → a11y
  fallback for perimeter actions. The deeper LLM-tier locator
  (`decideElement(snapshot, screenshot, goal) → ref`) is not built. The
  a11y tier covers most cases; LLM tier would catch the rest. Reasonable
  to defer until we hit a real LinkedIn variant the a11y tier misses.

### From M15

- **Indeed adapter** — explicitly skipped per ADR-019.

## Known issues from live testing

These are real gaps surfaced while exercising the live LinkedIn path.

1. **No UI trigger for auto-apply.** The score handler's autonomy hook
   only enqueues `prepare_manual_apply` (manual jobs). There's no parallel
   for auto-apply jobs, and no "Auto-apply" button on the JobCard. To
   trigger an apply task today you either need to insert a row into
   `task_queue` directly or rely on a (not yet built) autonomy branch.
2. **The "Apply" button on JobCard goes to manual-prep, not auto-apply.**
   Confusing for any user with an `apply_method='auto'` job.
3. **Sidebar Alerts badge counts every open alert** including stale
   ones from previous task failures. Worth a "mark all read" or
   auto-dismiss after N days.
4. **Stale apply tasks accumulate.** Each failed/completed task stays in
   `task_queue` forever. Worth a periodic cleanup or status-based filter.
5. **Already-applied detection** has crude heuristics
   (`alreadyApplied()` selector list in
   `packages/automation/src/adapters/linkedin/application.ts`). It works
   but won't survive a LinkedIn copy change. The a11y-tree approach used
   for other detection paths would be more robust.

## Priority follow-ups

Ordered by user-visible impact and unblocking power.

### Tier 1 — close the UI loop

These two together turn "manually `INSERT INTO task_queue`" into a real
flow you can drive from the UI.

1. **Auto-apply autonomy hook in the score handler.** Parallel to the
   manual-apply enqueueing logic in
   `packages/server/src/queue/handlers/score.ts`. When
   `settings.mode === 'autonomous'`, `score >= threshold`, AND
   `apply_method === 'auto'`, enqueue an `apply` task for the job (after
   creating an application row).
2. **`POST /api/jobs/:id/apply` route + JobCard "Auto-apply" button.**
   Server creates an application row + enqueues an `apply` task. Web
   shows the button only for auto-apply jobs. Mirrors the existing
   `POST /api/jobs/:id/prepare` flow.

After these two, the user clicks Auto-apply on any Easy Apply job and
Vina drives the flow. No SQL.

### Tier 2 — the rest of M25 polish

3. **The five missing starter skills.** Pure markdown. Populates the
   Skills tile, gives the (future) chatbot something to reference.
4. **`tailor-cv` no-fabrication sentinel.** Small, focused, safety win.
5. **LLM-tier element locator** (`graphs/element-decider.ts`). Only
   worth doing if the a11y tier misses on a real LinkedIn cohort. Add a
   stub now and wait for a real miss.

### Tier 3 — broader product

6. **M20 — Chatbot.** Unblocks the prompt/skill chatbot authoring flows
   from M25. Architectural decisions logged in commit acd66ab.
7. **M22 — Polish (dashboards, settings, error states).**
8. **M23 — Hardening.**
9. **M24 — Installer / release pipeline** (ADR-020).

## Picking back up in a new conversation

When you start fresh, the fastest path is:

1. **Read this doc first**, then `docs/build-order.md` M15 and M25
   sections. The build-order doc has the original scope; this one has
   the as-shipped reality.
2. **Re-check the working tree state.** Several flakes/bugs surfaced
   only during live testing; the test suite passes (~580+ tests) but
   browser-heavy ones flake under full parallel load. Run with
   `--pool=forks --poolOptions.forks.singleFork` for stable runs.
3. **Don't trust diagnostic logs without context.** I twice claimed
   things based on "visible buttons" lists in alert descriptions that
   were wrong — the user manually browsing the page caught both. When
   investigating LinkedIn issues, set `browser_headful=true` in
   Settings so you (the human) can see what Vina is seeing.
4. **For the apply path specifically**, the chain is
   `score handler → applications row → apply task → handler →
   AutoApplyToolKit → runApply → LinkedIn adapter`. Failures can hide
   at any layer:
   - Apply handler unexpected throws now convert to `apply_failed`
     alerts; older logs may show silent task-failures (pre-de3602a).
   - The `field_unknown` / `field_skipped_optional` distinction matters:
     optional fields don't pause the flow; required fields do.
   - `fillField` dispatches by role — adding a new role kind requires
     updating both `fillLinkedInField` and (if interactive) the
     `actOnSession` `ACTIONABLE_ROLES` set.
5. **The browser-apply skill body** (`packages/orchestrator/skills/browser-apply/SKILL.md`)
   is loaded into the system prompt of every `decideUnresolvedField`
   call. Editing it changes LLM behaviour on the next run.

## File layout cheat sheet

```
packages/automation/src/
  browser/cdp.ts                  # managed CDP launch
  snapshot/{snapshot,refs}.ts     # ref-keyed a11y tree
  adapters/
    adapter.ts                    # SiteAdapter interface (M15-extended)
    element-locator.ts            # selectors → a11y-name fallback
    session-actions.ts            # snapshot + act with stale-ref retry
    linkedin/
      application.ts              # all M15 form-driving methods
      index.ts                    # adapter wiring
      selectors.ts                # discovery selectors only
  detect/{captcha,session}.ts     # M15 escalation heuristics
  forms/
    types.ts                      # FormField, FormFieldKind
    field-map.ts                  # canonical-key matcher
    form-walker.ts                # UiTree → FormField[]
    field-resolver.ts             # profile → answers → CV resolver

packages/orchestrator/src/
  prompts/                        # loader + default-loader + .ts userTemplates
  prompts/                        # (top-level) .md prompt defaults
  skills/                         # loader + registry + default-registry
  skills/                         # (top-level) packaged skill .md files
  graphs/
    apply.ts                      # M15 state graph
    apply-fallback.ts             # decideUnresolvedField (LLM)
    prepare-manual-apply.ts       # manual path (pre-existing)
    score-job.ts, tailor-cv.ts    # pre-existing
  tools/
    auto-apply-toolkit.ts         # AutoApplyToolKit interface
    types.ts                      # ManualApplyToolKit (pre-existing)

packages/server/src/
  queue/handlers/apply.ts         # M15 apply task handler
  orchestrator/tools/auto-apply.ts # server-side AutoApplyToolKit impl
  services/
    apply-resume-service.ts       # alert resolve → re-enqueue
    prompts-service.ts            # CRUD + loader wrapper
    skills-service.ts             # CRUD + registry wrapper

packages/web/src/routes/
  applications/ApplicationsPage.tsx  # live status table (M15-era)
  settings/{Prompts,Skills}Tile.tsx  # M25 admin UIs
```

## Open question for the next session

Before doing more on the auto-apply path: **is the answer to the
"only auto-submit on user-initiated trigger" question still
review-first-by-default?** Today the flow is

```
score >= threshold + autonomous + apply_method='auto' → (nothing)
score >= threshold + autonomous + apply_method='manual' → enqueue prepare_manual_apply
```

If we wire the auto-apply autonomy hook (Tier 1 item 1 above), the
autonomous mode submits Easy Apply jobs without the user clicking
anything — gated only by the `approval='review-first'` setting. This was
exactly the M15-deferral concern. Worth a deliberate decision before
flipping it on.
