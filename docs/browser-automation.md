# Browser Automation — `packages/automation`

Playwright-driven interaction with job sites. Site-agnostic core plus per-site adapters.

This package is **browser-only**. Sources that don't require a browser session (e.g. Google Jobs via SerpAPI) live in the server's `services/` and are not part of this package. The `SiteAdapter` interface below is for browser-driven sites only.

Interaction model and transport are set by ADR-022: a **managed CDP transport**
and a **deterministic-first, LLM-fallback** loop built on a shared **snapshot/ref**
primitive. The anti-detection posture is set by ADR-021: stealth masking is an
**opt-in layer, off by default**.

## 1. Folder Layout

```
packages/automation/
├── src/
│   ├── index.ts
│   ├── browser/
│   │   ├── manager.ts          # owns the managed-CDP browser, persistent profile, lifecycle, headful toggle
│   │   ├── cdp.ts              # launch Chromium with a loopback debug port + connectOverCDP
│   │   ├── stealth.ts          # opt-in masking layer (no-op when browser_stealth=false)
│   │   └── humanise.ts         # realistic delays, mouse jitter, scrolling
│   ├── snapshot/
│   │   ├── snapshot.ts         # accessibility-tree → ref-keyed UiTree
│   │   └── refs.ts             # ref allocation + label-based re-resolution
│   ├── adapters/
│   │   ├── adapter.ts          # SiteAdapter interface
│   │   ├── linkedin.ts
│   │   └── indeed.ts
│   ├── forms/
│   │   ├── form-walker.ts      # generic form discovery and filling (deterministic-first)
│   │   ├── field-map.ts        # canonical field keys, synonyms, type hints
│   │   └── upload.ts           # file upload handling
│   ├── detect/
│   │   ├── captcha.ts          # CAPTCHA detection heuristics
│   │   ├── session.ts          # session-expired detection
│   │   └── apply-method.ts     # Easy Apply vs external-redirect detection
│   └── lib/
│       ├── selectors.ts        # robust selector helpers (fallback for poor a11y widgets)
│       └── errors.ts
└── package.json
```

## 2. Browser Manager (managed CDP)

Vina launches a local Chromium itself, exposing a Chrome DevTools Protocol debug
port **bound to loopback**, and attaches Playwright over CDP. The browser is
local and the session is the user's — only the attach mechanism differs from the
old `launchPersistentContext` approach. See ADR-022.

```ts
// browser/cdp.ts (sketch)
const port = await pickFreeLoopbackPort();           // ephemeral, 127.0.0.1 only
const proc = await launchChromium({
  userDataDir: profileDir,                            // persistent, per-profile
  args: [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=127.0.0.1`,           // NEVER 0.0.0.0
    `--user-data-dir=${profileDir}`,
    ...(settings.browser_headful ? [] : ['--headless=new']),
    ...stealthArgs(settings),                          // [] when browser_stealth=false
  ],
});
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0] ?? await browser.newContext();
```

Security: the CDP debug port is an unauthenticated control channel for anyone who
can reach it. It MUST bind to `127.0.0.1` and MUST NOT be exposed. This matches
the local-first posture of ADR-002.

`profileDir` is `~/<data-dir>/sessions/{site}/` — Chromium persists cookies,
localStorage, and IndexedDB inside it across runs.

The manager exposes:

```ts
interface BrowserManager {
  getContext(siteId: string): Promise<BrowserContext>;
  closeContext(siteId: string): Promise<void>;
  loginInteractive(siteId: string, signal: AbortSignal): Promise<void>;
  isSessionValid(siteId: string): Promise<boolean>;
  closeAll(): Promise<void>;
}
```

`loginInteractive` always launches headful, navigates to the site's login page,
and resolves when the adapter's `onLoginSuccess` predicate matches. On resolve,
the context is closed (which persists storage state) and the session is marked
valid.

Mode switching (headless ↔ headful) closes and relaunches the managed browser
against the same `profileDir`, so the session survives the switch.

## 3. Snapshot / ref primitive

The shared currency between the deterministic walker and the LLM fallback is a
ref-keyed accessibility tree. Selectors are a fallback, not the primary handle.

```ts
type UiRef = string;                 // stable within a snapshot, e.g. "r12"

type UiNode = {
  ref: UiRef;
  role: string;                      // button, textbox, combobox, checkbox, ...
  name: string;                      // accessible name / label
  value?: string;
  required?: boolean;
  disabled?: boolean;
  options?: string[];                // for selects / comboboxes when exposed
  children?: UiNode[];
};

type UiTree = { takenAt: number; root: UiNode };
```

`snapshot/snapshot.ts` builds the `UiTree` from `page.accessibility.snapshot()`
plus a ref-injection pass. `snapshot/refs.ts` allocates refs and, given a stale
ref, re-resolves it by accessible name within a fresh snapshot.

**Refs are valid only within the snapshot that produced them.** Any UI change
(step advance, dynamic field reveal) invalidates them — re-snapshot before
acting again.

## 4. SiteAdapter Interface

Every browser-kind site implements this. `detectApplyMethod` classifies each
listing at discovery time so the server knows whether to enqueue an `apply` or a
`prepare_manual_apply` task. `snapshot` (ADR-022) is now part of the interface,
and actions resolve by ref.

```ts
interface SiteAdapter {
  id: string;                      // 'linkedin', 'indeed'
  displayName: string;

  loginUrl: string;
  onLoginSuccess(page: Page): Promise<boolean>;
  onSessionExpired(page: Page): Promise<boolean>;

  search(page: Page, prefs: SearchPreferences): AsyncIterable<RawListing>;

  detectApplyMethod(page: Page, listing: RawListing): Promise<{
    method: 'auto' | 'manual';
    externalApplyUrl?: string;
  }>;

  openListing(page: Page, listing: RawListing): Promise<JobDetail>;

  // Only called for listings classified as 'auto'
  startApplication(page: Page, listing: RawListing): Promise<ApplicationSession>;

  // Snapshot/act surface (ADR-022)
  snapshot(session: ApplicationSession): Promise<UiTree>;
  inspectFields(session: ApplicationSession): Promise<FormField[]>;
  fillField(session: ApplicationSession, key: string, value: string): Promise<void>;
  // act resolves by ref; selector is an internal fallback for poor-a11y widgets
  act(session: ApplicationSession, ref: UiRef, action: 'click' | 'check' | 'select', value?: string): Promise<void>;
  uploadCv(session: ApplicationSession, path: string): Promise<void>;
  uploadCoverLetter(session: ApplicationSession, path: string): Promise<void>;
  submit(session: ApplicationSession): Promise<SubmitResult>;
  takeScreenshot(session: ApplicationSession): Promise<string>;
}
```

Adapters keep their own Playwright `Page` instances tied to an
`ApplicationSession`. They retain a thin layer of site-specific selectors for
widgets that expose poor accessibility nodes (LinkedIn's custom dropdowns, some
radio/checkbox groups); refs handle everything else.

## 5. Search

`search(page, prefs)` is an async iterable so the worker streams listings into
the DB without buffering. For each enabled site, the worker:

1. Builds the search URL/payload from `prefs`
2. Yields `RawListing { externalId, title, company, location, url, snippet, postedAt }`
3. Opens the detail page via `openListing` for the full description
4. Calls `detectApplyMethod` to classify `auto`/`manual` and capture an `externalApplyUrl`
5. Closes that tab

The job is inserted with `apply_method` set from detection and `external_apply_url`
populated when applicable. Search rate-limit: 1 detail fetch every 4–8s (jittered).

## 6. Apply-method Detection

`detect/apply-method.ts` provides a generic structure; each adapter implements
its own selectors.

### LinkedIn
- `auto` if the listing shows the Easy Apply badge (button text/attributes,
  inspected without clicking).
- `manual` if the apply button takes the user offsite; capture `externalApplyUrl`
  via the new-tab URL, then close it without navigating further.

### Indeed
- `auto` for an in-Indeed "Apply now" modal (data attribute, no `target="_blank"`).
- `manual` for an external apply link (read `href` directly, no click).

Detection prefers reading attributes over clicking — clicks can trip anti-bot
heuristics regardless of the stealth setting.

## 7. Form Walking (deterministic-first)

The walker is the deterministic core — no LLM in the inner loop for fields it can
classify and resolve. Algorithm:

1. Identify the form root (site-specific "easy/quick apply" container).
2. `snapshot(session)` and enumerate interactive nodes into `FormField`s:

```ts
type FormField = {
  ref: UiRef;                // primary handle (ADR-022)
  selector?: string;         // fallback handle for poor-a11y widgets
  label: string;
  kind: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file' | 'date' | 'phone' | 'url' | 'email' | 'number' | 'multiselect';
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  hint?: string;
  pattern?: string;
  filledFromKey?: string;
};
```

3. Resolve each field's value deterministically, first hit wins:
   - `profile` (name, email, phone, location, links)
   - `profile_answers` (saved answers)
   - source CV text (only when unambiguous)
   A field that doesn't resolve is `unknown` — never guessed.

4. **LLM fallback only for `unknown` fields or unexpected UI states.** Take a
   `snapshot` + `takeScreenshot` and ask the orchestrator's apply graph for a
   single next action (one decision per call; respects the apply token budget).

5. Fill each resolved field by ref (`fillField`/`act`). CV/cover-letter uploads
   use the file inputs found during enumeration with the tailored paths.

6. **Re-snapshot after any UI change.** After clicking Continue/Next, re-run the
   snapshot + enumeration before acting again — prior refs are stale.

7. **Stale-ref recovery (once).** If an action fails because a ref/selector no
   longer resolves, re-snapshot and re-resolve that field by accessible name,
   then retry exactly once. If it still fails, stop and escalate — do not loop.

8. **Step cap.** At most 5 steps, then `AutomationError('form_too_long')`.

9. Submit, then run detection routines and verify the success state.

## 8. Canonical Field Map

`forms/field-map.ts` exports canonical keys with synonyms to map free-form labels
to keys (`first_name`, `last_name`, `full_name`, `email`, `phone`, `location`,
`linkedin`, `website`, `years_of_experience`, `work_authorization`,
`salary_expectation`, `notice_period`, …). Deterministic fuzzy matching first;
only labels that don't match deterministically go to the LLM for classification.

## 9. CAPTCHA Detection (unchanged — ADR-007)

`detect/captcha.ts` runs after every page load and submit. Heuristics: recaptcha/
hcaptcha/captcha iframes, `aria-label` containing "captcha", site-specific
markers. On detection the walker emits `captcha_detected`, switches to headful,
brings the page to front, and returns `SubmitResult { ok: false, reason: 'captcha' }`.

Vina never solves a CAPTCHA. The user solves it in the visible window and clicks
"I solved it", which re-enqueues the apply task from `submit`. This is unchanged
by ADR-021 — masking reduces how often challenges fire; it does not solve them,
and we still use no third-party solver.

## 10. Anti-detection posture (opt-in masking — ADR-021)

Masking is a supported but **opt-in** layer, gated by `settings.browser_stealth`
(default `false`). ADR-021 supersedes the previous "no masking" stance (ADR-013).

**Always on, regardless of the setting (legitimate techniques):**
- The user's real, persistent, logged-in session (the product depends on it).
- Realistic delays between actions (200–600ms with jitter) and between listings (4–8s).
- Mouse movement to elements before clicking (Playwright actionability).
- The user's real OS locale and timezone.
- Per-site application caps (configurable; default max 20/day per site).

**When `browser_stealth = true` (opt-in):**
- `navigator.webdriver` and related automation-flag suppression.
- A stealth/evasion layer (e.g. `playwright-extra` + stealth plugin or equivalent),
  loaded only when enabled so the default install is unaffected.
- User-agent / client-hint alignment consistent with the launched browser.

**When `browser_stealth = false` (default):** behaviour is identical to the old
ADR-013 posture — no masking, no `navigator.webdriver` override, no stealth plugin.

Guidance surfaced to the user in Settings/onboarding: masking is best-effort and
is an arms race we do not promise to keep winning; and enabling it on a
long-established account that has always presented a consistent fingerprint can
itself look anomalous. Prefer enabling it early in an account's automation
history rather than mid-stream. Per-site caps remain in force either way.

## 11. Session Expiry Detection

`detect/session.ts` provides a cross-adapter heuristics system; each adapter
shares one `SessionExpiredHeuristics` constant (exported from its own module).

LinkedIn expiry detection matches `/login`, `/uas/login`, `/authwall` URL paths
**and** the DOM marker `[data-tracking-control-name^="public_jobs_"]`, because
LinkedIn serves logged-out visitors real guest pages (with public_jobs tracking
attributes and authwall modals) rather than redirecting to a login URL.

Indeed redirect to `/account/login`. On detection:
emit `session_expired`, mark `sites.session_valid_at = null`, create a
`session_expired` alert, return `SubmitResult { ok: false, reason: 'session_expired' }`.
User resolves by re-running `POST /api/sites/{site}/login`.

## 12. LinkedIn Adapter Specifics

- Login URL `https://www.linkedin.com/login`; success when URL starts `…/feed`.
- Search `https://www.linkedin.com/jobs/search/?keywords=…&location=…&f_WT=…&f_TPR=…`.
- Surfaces all listings, runs `detectApplyMethod` on each; Easy Apply → auto,
  external-redirect → manual. `f_AL=true` is not applied as a default filter.
- Multi-step Easy Apply handled up to 5 steps, re-snapshotting each step.

## 13. Indeed Adapter Specifics

- Login URL `https://secure.indeed.com/account/login`; success on account menu at
  `https://www.indeed.com/`.
- Search `https://www.indeed.com/jobs?q=…&l=…`.
- In-Indeed "Apply Now" → auto; external apply link → manual with `externalApplyUrl`
  from `href`.

## 14. Headful vs Headless (unchanged — ADR-012)

Headless by default; auto-switch to headful for `loginInteractive` and on CAPTCHA;
`settings.browser_headful` forces headful for the whole session (debugging).
Switching closes and relaunches the managed browser against the same profile dir.

## 15. Error Handling

All errors are `AutomationError`s with codes: `selector_missing` (now rare — a
stale ref that survived one recovery attempt), `ref_unresolved`,
`navigation_timeout`, `form_too_long`, `submit_unknown_outcome`,
`apply_method_undetectable` (treated as `manual`, no external URL),
`playwright_crash`. Every failure path saves a screenshot to
`screenshots/{application_id}/{timestamp}.png`.

## 16. Testing

- Unit tests for `field-map.ts`, `humanise.ts`, `detect/*`, `snapshot/*`
  (ref allocation + stale-ref re-resolution), and `stealth.ts` (no-op when
  disabled; expected flags/args when enabled).
- E2E against fixture HTML in `tests/fixtures/sites/` replicating LinkedIn/Indeed
  Easy Apply and external-redirect variants — asserts deterministic walking,
  apply-method classification, snapshot/ref resolution, and one-shot stale-ref
  recovery, without real-site flakiness.
- An opt-in suite against real sites with a recorded test account, run locally,
  never in CI — covers both `browser_stealth` states.

## 17. Public Exports

```ts
// packages/automation/src/index.ts
export { createBrowserManager } from './browser/manager';
export { LinkedInAdapter } from './adapters/linkedin';
export { IndeedAdapter } from './adapters/indeed';
export type { SiteAdapter, FormField, UiTree, UiNode, UiRef, ApplicationSession, SubmitResult } from './adapters/adapter';
```

Google Jobs is **not** exported here — it lives in the server's
`services/serpapi-service.ts` because it doesn't use a browser.