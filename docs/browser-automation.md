# Browser Automation — `packages/automation`

Playwright-driven interaction with job sites. Site-agnostic core plus per-site adapters.

This package is **browser-only**. Sources that don't require a browser session (e.g. Google Jobs via SerpAPI) live in the server's `services/` and are not part of this package. The `SiteAdapter` interface below is for browser-driven sites only.

## 1. Folder Layout

```
packages/automation/
├── src/
│   ├── index.ts
│   ├── browser/
│   │   ├── manager.ts          # owns persistent contexts, lifecycle, headful toggle
│   │   └── humanise.ts         # realistic delays, mouse jitter, scrolling
│   ├── adapters/
│   │   ├── adapter.ts          # SiteAdapter interface
│   │   ├── linkedin.ts
│   │   └── indeed.ts
│   ├── forms/
│   │   ├── form-walker.ts      # generic form discovery and filling
│   │   ├── field-map.ts        # canonical field keys, synonyms, type hints
│   │   └── upload.ts           # file upload handling
│   ├── detect/
│   │   ├── captcha.ts          # CAPTCHA detection heuristics
│   │   ├── session.ts          # session-expired detection
│   │   └── apply-method.ts     # Easy Apply vs external-redirect detection
│   └── lib/
│       ├── selectors.ts        # robust selector helpers
│       └── errors.ts
└── package.json
```

## 2. Browser Manager

One Playwright `BrowserContext` per browser-kind site, persisted across runs:

```ts
const context = await chromium.launchPersistentContext(sessionDir, {
  headless: settings.browser_headful ? false : true,
  viewport: { width: 1366, height: 800 },
  // Use a real user-agent string from a recent stable Chromium
  userAgent: chromiumDefaultUA,
  acceptDownloads: true,
  timezoneId: profile.timezone || 'Europe/London',
  locale: 'en-GB',
});
```

`sessionDir` is `~/<data-dir>/sessions/{site}/` — Playwright manages cookies, localStorage, and IndexedDB inside it.

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

`loginInteractive` always launches headful, navigates to the site's login page, and resolves when the adapter's `onLoginSuccess` predicate matches (e.g. URL change to `/feed`). On resolve, the context is closed (which persists storage state) and the session is marked valid.

## 3. SiteAdapter Interface

Every browser-kind site implements this. Note `detectApplyMethod` is now a first-class part of the interface — every listing must be classified at discovery time so the server knows whether to enqueue an `apply` or a `prepare_manual_apply` task.

```ts
interface SiteAdapter {
  id: string; // 'linkedin', 'indeed'
  displayName: string;

  loginUrl: string;
  onLoginSuccess(page: Page): Promise<boolean>;
  onSessionExpired(page: Page): Promise<boolean>;

  search(page: Page, prefs: SearchPreferences): AsyncIterable<RawListing>;

  // Inspect a listing and decide if it's auto-applyable on this site.
  // Returns 'auto' for in-site quick/easy apply, 'manual' for external redirects.
  // Also captures the external apply URL when the method is 'manual'.
  detectApplyMethod(
    page: Page,
    listing: RawListing,
  ): Promise<{
    method: 'auto' | 'manual';
    externalApplyUrl?: string;
  }>;

  openListing(page: Page, listing: RawListing): Promise<JobDetail>;

  // Only called for listings classified as 'auto' by detectApplyMethod
  startApplication(page: Page, listing: RawListing): Promise<ApplicationSession>;

  // The methods invoked by the orchestrator's browser tools, passing the session
  inspectFields(session: ApplicationSession): Promise<FormField[]>;
  fillField(session: ApplicationSession, key: string, value: string): Promise<void>;
  uploadCv(session: ApplicationSession, path: string): Promise<void>;
  uploadCoverLetter(session: ApplicationSession, path: string): Promise<void>;
  submit(session: ApplicationSession): Promise<SubmitResult>;
  takeScreenshot(session: ApplicationSession): Promise<string>;
}
```

Adapters keep their own Playwright `Page` instances tied to an `ApplicationSession`. The session exposes the `formId` returned to the orchestrator; internally that resolves back to a Page.

## 4. Search

`search(page, prefs)` is an async iterable so the worker can stream listings into the DB without buffering everything in memory.

For each enabled browser-kind site, the worker:

1. Builds the search URL/payload from `prefs`
2. Iterates results, yielding `RawListing { externalId, title, company, location, url, snippet, postedAt }`
3. For each new listing, opens the detail page via `openListing` to get the full description
4. **Then calls `detectApplyMethod`** to classify the listing as `auto` or `manual` and capture an `externalApplyUrl` if present
5. Closes that tab

The job is inserted into the database with `apply_method` set from the detection result and `external_apply_url` populated when applicable.

Search rate-limits: maximum 1 listing detail fetch every 4–8 seconds (jittered). The humaniser handles this.

## 5. Apply-method Detection

`detect/apply-method.ts` provides a generic structure; each adapter implements its own selectors.

### LinkedIn

- `auto` if the listing card or detail view shows the Easy Apply badge
  - Selector: `button[data-testid="jobs-apply-button-id"]:has-text("Easy Apply")` or similar (checked at runtime)
- `manual` if the apply button takes the user offsite. The `externalApplyUrl` is captured by clicking the apply button (which opens a new tab) and reading `page.url()` of the new context, then closing it without navigating further

To minimise side effects, when `auto` is detected the click is never attempted — only the button's text and attributes are inspected.

### Indeed

- `auto` if the listing has an "Apply now" button that opens an in-Indeed modal (matched by data attribute and the absence of `target="_blank"` on the apply link)
- `manual` if the apply link points to an external URL (read from `href` directly without clicking)

In both cases, detection is read-only when possible — we prefer to read attributes over clicking, because clicks can trigger anti-bot heuristics.

## 6. Form Walking

The form walker is the deterministic part — no LLM in the inner loop. Algorithm:

1. Identify the form root for the site's "easy apply" / "quick apply" container
2. Enumerate all interactive children: `input[type=text|email|tel|number|url]`, `textarea`, `select`, `input[type=radio]`, `input[type=checkbox]`, file inputs, custom dropdowns (site-specific selectors live in the adapter)
3. For each, build a `FormField`:

```ts
type FormField = {
  selector: string; // robust selector to re-find later
  label: string; // visible label or aria-label
  kind:
    | 'text'
    | 'textarea'
    | 'select'
    | 'radio'
    | 'checkbox'
    | 'file'
    | 'date'
    | 'phone'
    | 'url'
    | 'email'
    | 'number'
    | 'multiselect';
  required: boolean;
  options?: Array<{ value: string; label: string }>; // for selects, radios
  placeholder?: string;
  hint?: string;
  pattern?: string; // HTML pattern attribute when present
  filledFromKey?: string; // set after we successfully fill
};
```

4. Hand the list to the orchestrator's apply graph. The graph asks the LLM (small focused call) to map each `label` to a canonical key from `field-map.ts`, then resolves a value:
   - From `profile` (e.g. email, phone, name, location)
   - From `profile_answers` (saved from past resolutions)
   - From the source CV text (LLM-derived only when confident; field marked `unknown` otherwise)

5. The graph calls `fillField(session, fieldKey, value)` for each known field. The walker selects the field by selector and fills appropriately for its `kind` (typing for text, picking by label for select, clicking for radio/checkbox).

6. CV upload uses the file input identified during enumeration, with the tailored CV path.

7. Multi-page forms: after filling the visible form, the walker clicks "Continue/Next" and re-runs enumeration on the next step. It does this up to 5 steps, after which it errors as `AutomationError('form_too_long')`.

8. Submit: walker clicks the submit button. Then runs detection routines.

## 7. Canonical Field Map

`forms/field-map.ts` exports a list of canonical keys with synonyms used to map free-form labels to keys:

```ts
const FIELDS = [
  { key: 'first_name', synonyms: ['first name', 'given name'] },
  { key: 'last_name', synonyms: ['last name', 'surname', 'family name'] },
  { key: 'full_name', synonyms: ['full name', 'name'] },
  { key: 'email', synonyms: ['email', 'e-mail'] },
  { key: 'phone', synonyms: ['phone', 'mobile', 'telephone'] },
  { key: 'location', synonyms: ['location', 'city', 'where are you based'] },
  { key: 'linkedin', synonyms: ['linkedin', 'linkedin profile'] },
  { key: 'website', synonyms: ['website', 'portfolio', 'personal site'] },
  {
    key: 'years_of_experience',
    synonyms: ['years of experience', 'yoe', 'years of related experience'],
  },
  { key: 'work_authorization', synonyms: ['authorized to work', 'right to work', 'visa status'] },
  {
    key: 'salary_expectation',
    synonyms: ['salary expectation', 'desired salary', 'compensation expectations'],
  },
  { key: 'notice_period', synonyms: ['notice period', 'when can you start', 'availability'] },
  // ...
];
```

A small mapping helper does fuzzy matching first; only labels that don't match deterministically are sent to the LLM for classification.

## 8. CAPTCHA Detection

`detect/captcha.ts` runs after every page load and after every form submit. Heuristics:

- Presence of `iframe[src*="recaptcha"]`, `iframe[src*="hcaptcha"]`, `iframe[src*="captcha"]`
- Presence of an element with `aria-label` containing "captcha" (case-insensitive)
- Site-specific markers passed in by the adapter

If detected, the walker:

1. Emits a `captcha_detected` event
2. Switches the browser context to headful (if it isn't already)
3. Brings the relevant page to the front
4. Returns control to the orchestrator with `SubmitResult { ok: false, reason: 'captcha' }`

Vina never tries to solve a CAPTCHA. The user solves it in the visible window. Resume happens via an alert: the user clicks "I solved it" in the UI, which re-enqueues the application's apply task starting from `submit`.

## 9. Session Expiry Detection

`detect/session.ts` checks (per-adapter implementations):

- LinkedIn: redirect to `/login` or presence of `#username` field where there should be content
- Indeed: redirect to `/account/login`

If detected:

1. Emit `session_expired` event
2. Mark the site's session as invalid (`sites.session_valid_at = null`)
3. Create alert: `{ kind: 'session_expired', site_id }`
4. Return `SubmitResult { ok: false, reason: 'session_expired' }`

User resolves by re-running the login flow (`POST /api/sites/{site}/login`).

## 10. Anti-Detection Practices

- Realistic delays between actions (200–600ms with jitter) and between listings (4–8s)
- Mouse movement to elements before clicking via Playwright's built-in actionability
- Don't override `navigator.webdriver` (sites detect inconsistent overrides; the persistent context approach is sufficient for normal use)
- Use the user's real OS locale and timezone
- Limit per-site application throughput (configurable; default max 20 applications/day per site)

We deliberately do not use anti-fingerprinting tools that misrepresent the browser. Vina is acting on the user's behalf with their consent and their real session — that's the legitimate posture and it's what we keep.

## 11. LinkedIn Adapter Specifics

- Login URL: `https://www.linkedin.com/login`
- Login success: `page.url().startsWith('https://www.linkedin.com/feed')`
- Search uses `https://www.linkedin.com/jobs/search/?keywords=...&location=...&f_WT=...&f_TPR=...`
- Adapter no longer filters out non-Easy Apply listings during search — instead it surfaces all listings, runs `detectApplyMethod` on each, and lets the server classify them. Easy Apply listings flow into auto-apply; external-redirect listings flow into the manual-apply pipeline
- Multi-step Easy Apply form: walker handles up to 5 steps
- `f_AL=true` is no longer applied as a default search filter — that filter would suppress non-Easy Apply listings we now want to surface for manual-apply

## 12. Indeed Adapter Specifics

- Login URL: `https://secure.indeed.com/account/login`
- Login success: presence of an account menu element on `https://www.indeed.com/`
- Search uses `https://www.indeed.com/jobs?q=...&l=...`
- Adapter classifies "Apply Now" (in-Indeed apply) as `auto`, and external apply links as `manual` with `externalApplyUrl` captured from the link's `href`

## 13. Headful vs Headless

- Headless by default
- Switches to headful automatically when:
  - User triggers `loginInteractive`
  - CAPTCHA is detected (so the user can solve it)
- Settings toggle (`settings.browser_headful`) forces headful for the entire session — useful for debugging

## 14. Error Handling

All errors from this package are `AutomationError`s with codes:

- `selector_missing` — adapter is out of date with the site's DOM
- `navigation_timeout`
- `form_too_long`
- `submit_unknown_outcome` — submit clicked but no clear result detected
- `apply_method_undetectable` — adapter can't decide if the listing is Easy Apply or external; treated as `manual` with no external URL captured (best-effort fallback)
- `playwright_crash`

Every failure path saves a screenshot to `screenshots/{application_id}/{timestamp}.png`.

## 15. Testing

- Unit tests for `field-map.ts`, `humanise.ts`, `detect/*` (including `apply-method`)
- E2E tests run against fixture HTML pages served by a tiny Fastify app in `tests/fixtures/sites/` — they replicate the LinkedIn and Indeed apply flow with stable selectors, including both Easy Apply and external-redirect variants. This lets us assert form-walker behaviour and apply-method classification without flakiness from real sites
- A separate, opt-in suite runs against the real sites with a recorded test account (only run locally, never in CI)

## 16. Public Exports

```ts
// packages/automation/src/index.ts
export { createBrowserManager } from './browser/manager';
export { LinkedInAdapter } from './adapters/linkedin';
export { IndeedAdapter } from './adapters/indeed';
export type { SiteAdapter, FormField, ApplicationSession, SubmitResult } from './adapters/adapter';
```

The server uses these to construct the `ToolKit` it passes to the orchestrator. Google Jobs is **not** exported here — that lives in the server's `services/serpapi-service.ts` because it doesn't use a browser.
