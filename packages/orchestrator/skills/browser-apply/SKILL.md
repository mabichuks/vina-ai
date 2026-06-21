---
id: browser-apply
name: browser-apply
description: >
  How to fill and submit a job application form reliably. Snapshot the form
  before acting, target elements by stable ref, re-snapshot after any UI change,
  recover stale refs once, and escalate login/2FA/CAPTCHA/session-expiry as
  manual blockers instead of guessing. Deterministic-first; use the LLM only for
  fields the form-walker could not classify.
applies_to: [apply]
capabilities: [snapshot, inspectFields, fillField, act, uploadCv, uploadCoverLetter, submit, takeScreenshot, createAlert]
editable_by_user: false
version: 3
---

## Purpose

You are completing one job application in an auto-apply flow (Easy Apply /
Quick Apply only — manual-apply jobs never reach this skill). Fill every required
field correctly using the user's real data, then submit, without inventing
information and without fighting anti-bot defences.

## Interaction model (ADR-022)

You operate over a **snapshot** of the page: an accessibility tree where each
interactable element has a stable **ref**. You act on refs, not CSS selectors —
this is what survives the site's changing class names. Refs are valid only within
the snapshot that produced them; any UI change invalidates them.

Detection avoidance (masking) is governed by the user's `browser_stealth` setting
(ADR-021) at the browser-manager level — it is **not** your concern in this loop.
Do not attempt to alter fingerprinting from here.

## Operating loop

1. **Inspect first.** `inspectFields(session)` returns the deterministic field
   list (ref, label, kind, required, options). This is the primary source of
   truth. Do not act before you have it.

2. **Resolve values deterministically.** For each field, first hit wins:
   - the user's `profile` (name, email, phone, location, links),
   - `profile_answers` (saved answers to past screening questions),
   - the source CV text — only when unambiguous.
   A field you cannot resolve confidently is `unknown`. Do **not** guess.

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

   When deciding `fill`, take a fresh `snapshot(session)` and
   `takeScreenshot(session)` so your decision reflects current UI. One decision
   per call — the page may change after one action. Stay within the apply
   token budget.

4. **Fill / act.** `fillField(session, key, value)` for resolved text-like
   fields; `act(session, ref, 'click'|'check'|'select', value?)` for buttons,
   checkboxes, radios, and dropdowns. `uploadCv` / `uploadCoverLetter` for file
   inputs with the tailored paths.

5. **Re-snapshot after any UI change.** Multi-step forms mutate between steps.
   After clicking Continue/Next, re-run `inspectFields` (which re-snapshots)
   before acting again. Pre-change refs are stale.

6. **Stale-ref recovery (once).** If an action fails because the ref no longer
   resolves, re-snapshot and re-resolve that one field by its accessible name,
   then retry **once**. If it still fails, stop and escalate — do not loop.

7. **Step cap.** Walk at most 5 steps. Beyond that, stop with a `form_too_long`
   outcome and raise an alert.

8. **Submit, then verify.** `submit(session)`, then confirm the success state
   (e.g. an "application sent" confirmation). An ambiguous result is
   `submit_unknown_outcome` — raise an alert with a screenshot rather than
   assuming success.

## Escalate as manual blocker (never auto-solve)

Stop the loop and `createAlert` with a screenshot when you detect:

- **CAPTCHA** — never attempt to solve (ADR-007). The manager switches to headful
  and brings the page to front; raise a `captcha` alert. The user solves it and
  re-triggers from submit.
- **2FA / login wall / session expiry** — raise `session_expired`; the user
  re-runs the login flow. Do not type credentials.
- **A required field you cannot resolve** — raise `missing_field` with the field
  label and a prompt; the answer is saved to `profile_answers` for next time.

## EEO / demographic questions — always skip

These questions are legally optional in many jurisdictions and the user must
answer them themselves. Detect them by the field's label or options. **Always
emit `skip`, never `fill`, regardless of what the profile contains.**

Signals that mark a question as EEO / demographic:
- Labels mentioning: race, ethnicity, gender, sex, sexual orientation,
  disability status, veteran status, military service, pronouns, or
  questions explicitly tagged as "EEO" / "voluntary self-identification".
- Options that include "Prefer not to answer" alongside protected-class
  values.

Skip these even if the user previously answered one — saved answers may have
been entered under duress or have changed. Pause and let the user re-confirm
each time.

## Hard rules

- Never fabricate. If a field needs information not literally present in the
  user's data, `skip` and let the caller pause the application.
- EEO / demographic questions always skip — see the dedicated section above.
- Read attributes rather than clicking when you only need to inspect.
- One action, then observe. Re-snapshot whenever the page may have changed.
- Take a screenshot on every failure path before raising the alert.

## What good looks like

A matched Easy Apply job: inspect → resolve all fields from profile/answers →
fill → upload tailored CV → step through ≤5 pages, re-snapshotting each → submit
→ confirm "application sent" → `submitted`, with a complete event timeline, no
invented data, and zero LLM calls in the fill loop. A missing field pauses
cleanly, raises one alert, and resumes correctly when the user answers.
