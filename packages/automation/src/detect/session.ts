import type { Page } from 'playwright';

/**
 * Cross-adapter session-expired heuristics. Adapter `onSessionExpired`
 * methods can compose these — the LinkedIn adapter still owns
 * site-specific URL knowledge, but the comparison logic lives here so
 * every adapter speaks the same vocabulary.
 */
export interface SessionExpiredHeuristics {
  /** URL-path patterns that indicate a re-auth page. */
  loginPathPatterns?: readonly RegExp[];
  /** Case-insensitive substrings the page body may contain. */
  textPatterns?: readonly string[];
  /** Selectors whose presence implies an unauth state. */
  selectors?: readonly string[];
}

/**
 * Subset of Playwright `Page` we read. Lets unit tests inject a fake
 * without spinning a real browser.
 */
export interface SessionDetectablePage {
  url(): string;
  locator(selector: string): { count(): Promise<number> };
  content(): Promise<string>;
}

/**
 * Returns true if the page looks like a re-auth state. Order:
 *   1. URL path matches any `loginPathPatterns` — cheapest signal, always
 *      checked first.
 *   2. Any `selectors` is present — DOM-level, no body read.
 *   3. Any `textPatterns` substring is in `page.content()` — most
 *      expensive (full HTML pull), checked last.
 */
export async function isSessionExpired(
  page: SessionDetectablePage,
  heuristics: SessionExpiredHeuristics,
): Promise<boolean> {
  const url = page.url();
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  for (const re of heuristics.loginPathPatterns ?? []) {
    if (re.test(pathname)) return true;
  }
  for (const selector of heuristics.selectors ?? []) {
    if ((await page.locator(selector).count()) > 0) return true;
  }
  const textPatterns = heuristics.textPatterns ?? [];
  if (textPatterns.length > 0) {
    const html = (await page.content()).toLowerCase();
    for (const needle of textPatterns) {
      if (html.includes(needle.toLowerCase())) return true;
    }
  }
  return false;
}

/** Convenience wrapper — Playwright `Page` already satisfies the structural shape. */
export function isSessionExpiredOnPage(
  page: Page,
  heuristics: SessionExpiredHeuristics,
): Promise<boolean> {
  return isSessionExpired(page, heuristics);
}
