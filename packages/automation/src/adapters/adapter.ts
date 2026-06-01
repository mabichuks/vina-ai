import type { Page } from 'playwright';
import type { SearchPreferences } from '@vina/shared';
import type { JobDetail, RawListing } from './types.js';
import type { UiRef, UiTree } from '../snapshot/snapshot.js';
import type { FormField } from '../forms/types.js';

/**
 * In-progress application context. Carries the `Page` the form is being
 * driven on plus the most recent UI snapshot. `latestSnapshot` is set by
 * `snapshot()` and read by `act()` to map refs back to (role, name) for
 * label-based re-resolution on a stale ref (ADR-022).
 */
export interface ApplicationSession {
  /** The Playwright Page driving this application. */
  page: Page;
  /** Opaque identifier surfaced to the orchestrator. */
  formId: string;
  /** Most recent snapshot taken via `SiteAdapter.snapshot`. */
  latestSnapshot?: UiTree;
}

/** Actions `SiteAdapter.act` can dispatch against a ref. */
export type ActAction = 'click' | 'check' | 'select';

/** Result of `SiteAdapter.submit`. The graph reads `reason` for alerts. */
export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: 'captcha' | 'session_expired' | 'other'; detail?: string };

/**
 * Contract for a browser-kind site adapter (LinkedIn in M11, Indeed in
 * M12). Discovery surface (`id`, `loginUrl`, predicates, `search`,
 * `openListing`, `detectApplyMethod`) plus the snapshot/act surface from
 * ADR-022. The remaining form-walker methods (`startApplication`,
 * `inspectFields`, `fillField`, `uploadCv`, `uploadCoverLetter`, `submit`,
 * `takeScreenshot`) extend this interface in M15.
 *
 * Adapter implementations are plain `const` exports (no factory needed —
 * adapters hold no closure state); they import helpers from
 * `detect/apply-method.ts`, `browser/humanise.ts`, and `adapters/session-actions.ts`
 * directly.
 */
export interface SiteAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly loginUrl: string;

  /**
   * True when `page` shows the post-login state (e.g. LinkedIn's `/feed`
   * URL, Indeed's account menu). The login route polls this until it
   * returns true (or the user cancels).
   */
  onLoginSuccess(page: Page): Promise<boolean>;

  /**
   * True when `page` shows a session-expired state (redirected to login,
   * presence of an unauthenticated landing element). Adapters check this
   * during search/apply to detect when the saved session needs
   * re-authentication.
   */
  onSessionExpired(page: Page): Promise<boolean>;

  /**
   * Stream-search results matching the user's preferences. Async iterable
   * so the worker can persist listings as they arrive without buffering.
   * Adapters thread `signal` into their humanise pauses for cooperative
   * shutdown — the worker's stop signal interrupts mid-iteration.
   */
  search(
    page: Page,
    prefs: SearchPreferences,
    signal?: AbortSignal,
  ): AsyncIterable<RawListing>;

  /**
   * Navigate to the listing's detail page and extract description +
   * salary. Adapters return the page to a clean state (close tab or
   * navigate back) so the caller can reuse `page` for the next listing.
   */
  openListing(page: Page, listing: RawListing, signal?: AbortSignal): Promise<JobDetail>;

  /**
   * Classify the listing as `auto` (in-site easy/quick apply) or `manual`
   * (external redirect). Captures the external apply URL when applicable.
   * Read-only when possible — prefer DOM inspection over clicks.
   */
  detectApplyMethod(
    page: Page,
    listing: RawListing,
    signal?: AbortSignal,
  ): Promise<
    | { method: 'auto' }
    | { method: 'manual'; externalApplyUrl: string | null }
  >;

  /**
   * Capture the page's accessibility tree as a ref-keyed `UiTree` (ADR-022).
   * Also stores the result on `session.latestSnapshot` so subsequent `act`
   * calls can map refs back to (role, name). Refs are valid only within
   * the returned tree.
   */
  snapshot(session: ApplicationSession): Promise<UiTree>;

  /**
   * Dispatch an action against the element referred to by `ref` in the
   * session's latest snapshot (ADR-022). On failure the implementation
   * re-snapshots once and re-resolves the original (role, name) before
   * giving up. `value` is required for `action === 'select'`.
   */
  act(
    session: ApplicationSession,
    ref: UiRef,
    action: ActAction,
    value?: string,
  ): Promise<void>;

  // --- M15 form-driving surface -------------------------------------------

  /**
   * Open the Easy Apply / Quick Apply form for the listing. Navigates to
   * the listing URL, clicks the Easy Apply button, and waits for the
   * modal/form to mount. Returns a session with a fresh `formId`.
   */
  startApplication(page: Page, listing: RawListing): Promise<ApplicationSession>;

  /**
   * Enumerate the visible form fields. Wraps `snapshot` + `walkForm`;
   * adapters with poor-a11y widgets may post-filter or augment.
   */
  inspectFields(session: ApplicationSession): Promise<FormField[]>;

  /**
   * Fill a single text/textarea/email/phone/url/number field by ref. For
   * non-text kinds use `act` (`check`/`select`/`click`).
   */
  fillField(
    session: ApplicationSession,
    ref: UiRef,
    value: string,
  ): Promise<void>;

  /** Upload the tailored CV via the form's file input. */
  uploadCv(session: ApplicationSession, path: string): Promise<void>;
  /** Upload the tailored cover letter via the form's file input. */
  uploadCoverLetter(session: ApplicationSession, path: string): Promise<void>;

  /**
   * Click the form's Continue / Next / Review button. Returns
   * `advanced: true` if a button was found and clicked. The graph uses
   * this to detect multi-step forms (browser-apply skill, step cap = 5).
   */
  advanceStep(session: ApplicationSession): Promise<{ advanced: boolean }>;

  /**
   * Click Submit and report outcome. The adapter checks for captcha and
   * session-expired states as part of the post-submit verification.
   */
  submit(session: ApplicationSession): Promise<SubmitResult>;

  /** PNG screenshot of the page, base64-encoded for alert attachment. */
  takeScreenshot(session: ApplicationSession): Promise<{ pngBase64: string }>;

  /** Cleanup — closes any modal or auxiliary page opened during apply. */
  closeApplication(session: ApplicationSession): Promise<void>;
}
