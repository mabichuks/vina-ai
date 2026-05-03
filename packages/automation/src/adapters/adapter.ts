import type { Page } from 'playwright';
import type { SearchPreferences } from '@vina/shared';
import type { JobDetail, RawListing } from './types.js';

/**
 * Contract for a browser-kind site adapter (LinkedIn in M11, Indeed in
 * M12). M11-subset: discovery only — `id`, `loginUrl`, the predicates,
 * `search`, `openListing`, and `detectApplyMethod`. The form-walker
 * methods (`startApplication`, `inspectFields`, `fillField`, `uploadCv`,
 * `uploadCoverLetter`, `submit`, `takeScreenshot`) extend this interface
 * in M15 and may revisit the discovery method shapes if `ApplicationSession`
 * integration requires it.
 *
 * Adapter implementations are plain `const` exports (no factory needed —
 * adapters hold no closure state); they import helpers from
 * `detect/apply-method.ts` and `browser/humanise.ts` directly.
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
}
