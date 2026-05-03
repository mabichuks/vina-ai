import type { Locator, Page } from 'playwright';

/**
 * Return the first locator from `selectors` that is visible on the page,
 * or null if none match. Selectors are tried in order; the first hit wins.
 *
 * Used by adapters to detect apply buttons that may have multiple legacy
 * variants — e.g. LinkedIn renders `button[data-testid="..."]` in some
 * cohorts and a plain `button:has-text("Easy Apply")` in others. Adapters
 * pass an ordered list and let the helper pick whichever is present.
 */
export async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible()) return locator;
  }
  return null;
}

/**
 * Read the `href` attribute of the locator's element. Returns null when
 * the element has no `href` (e.g. a `<button>` rather than an `<a>`).
 * Adapters use this to capture an external apply URL without clicking
 * the button — clicks can trigger anti-bot heuristics.
 */
export async function getHref(locator: Locator): Promise<string | null> {
  return await locator.getAttribute('href');
}

/**
 * True if `url` has a different origin than `siteOrigin`. Pure JS — no
 * Playwright. Used to classify a captured apply URL as in-site (auto)
 * versus external redirect (manual).
 *
 * Throws via the URL constructor if either argument is malformed; both
 * are expected to be valid URLs from DOM reads.
 */
export function isExternalUrl(siteOrigin: string, url: string): boolean {
  return new URL(url).origin !== new URL(siteOrigin).origin;
}
