import type { Page } from 'playwright';

/**
 * CAPTCHA detectors. Vina never solves CAPTCHAs (ADR-007); these
 * heuristics let the apply graph raise a manual blocker so the user can
 * solve in a headful browser.
 *
 * Each entry pairs a name with selectors that signal the widget's
 * presence. Wide net intentionally — false positives are cheap (a single
 * alert) while a miss silently fails the application.
 */
const CAPTCHA_HEURISTICS = [
  {
    kind: 'recaptcha' as const,
    selectors: [
      'iframe[src*="google.com/recaptcha"]',
      'iframe[src*="recaptcha.net"]',
      '.g-recaptcha',
      '[data-sitekey][class*="recaptcha"]',
    ],
  },
  {
    kind: 'hcaptcha' as const,
    selectors: [
      'iframe[src*="hcaptcha.com"]',
      '.h-captcha',
      '[data-hcaptcha-widget-id]',
    ],
  },
  {
    kind: 'turnstile' as const,
    selectors: [
      'iframe[src*="challenges.cloudflare.com"]',
      '.cf-turnstile',
      'div[data-sitekey][class*="turnstile"]',
    ],
  },
] as const;

export type CaptchaKind = (typeof CAPTCHA_HEURISTICS)[number]['kind'];

export interface CaptchaDetection {
  /** True if any known CAPTCHA widget was found in the DOM. */
  present: boolean;
  /** Which kind matched first; undefined when `present` is false. */
  kind?: CaptchaKind;
  /** The matching selector — useful for logs/screenshots. */
  selector?: string;
}

/**
 * Page-shaped contract the detector needs. Lets unit tests fake it
 * without spinning a real browser. The selector contract matches
 * Playwright's `Locator` semantics — `count()` returns 0 when the
 * selector doesn't match anything.
 */
export interface DetectablePage {
  locator(selector: string): { count(): Promise<number> };
}

/**
 * Returns the first matching CAPTCHA widget on the page. Iterates the
 * heuristic list in order, returning as soon as one matches. The apply
 * graph (Chunk 16) calls this between each step and when `submit`
 * returns `reason='captcha'`.
 */
export async function detectCaptcha(
  page: DetectablePage,
): Promise<CaptchaDetection> {
  for (const { kind, selectors } of CAPTCHA_HEURISTICS) {
    for (const selector of selectors) {
      const count = await page.locator(selector).count();
      if (count > 0) return { present: true, kind, selector };
    }
  }
  return { present: false };
}

/**
 * Convenience: narrow `Page` → `DetectablePage`. Use this at the
 * call site so the function's contract surface stays minimal.
 */
export function detectCaptchaOnPage(page: Page): Promise<CaptchaDetection> {
  return detectCaptcha(page);
}
