import type { Locator, Page } from 'playwright';
import type { SearchPreferences } from '@vina/shared';
import { firstVisible, getHref, isExternalUrl } from '../../detect/apply-method.js';
import { sleepBetweenListings } from '../../browser/humanise.js';
import type { SiteAdapter } from '../adapter.js';
import type { JobDetail, RawListing } from '../types.js';
import {
  APPLY_BUTTON_ROOT_SELECTOR,
  EASY_APPLY_SELECTORS,
  EXTERNAL_APPLY_SELECTORS,
  JOB_CARD_COMPANY_SELECTOR,
  JOB_CARD_LINK_SELECTOR,
  JOB_CARD_LOCATION_SELECTOR,
  JOB_CARD_POSTED_AT_SELECTOR,
  JOB_CARD_SELECTOR,
  JOB_CARD_SNIPPET_SELECTOR,
  JOB_DESCRIPTION_SELECTOR,
  JOB_SALARY_SELECTOR,
  JOB_TITLE_SELECTOR,
} from './selectors.js';

const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

// 10s ceiling on readiness waits — surfaces selector drift / anti-bot
// interstitials as a typed Playwright timeout instead of hanging the
// worker for the default 30s.
const SELECTOR_TIMEOUT_MS = 10_000;

function buildSearchUrl(currentUrl: string, prefs: SearchPreferences): string {
  const base = new URL(currentUrl);
  const url = new URL('/jobs/search', base.origin);
  if (prefs.keywords.length > 0) {
    url.searchParams.set('keywords', prefs.keywords.join(' '));
  }
  const [firstLocation] = prefs.locations;
  if (firstLocation) {
    url.searchParams.set('location', firstLocation);
  }
  return url.toString();
}

async function readInner(scope: Locator | Page, selector: string): Promise<string | null> {
  const locator = scope.locator(selector).first();
  if ((await locator.count()) === 0) return null;
  return await locator.innerText();
}

async function readAttr(
  scope: Locator,
  selector: string,
  attr: string,
): Promise<string | null> {
  const locator = scope.locator(selector).first();
  if ((await locator.count()) === 0) return null;
  return await locator.getAttribute(attr);
}

async function extractRawListing(card: Locator, baseUrl: string): Promise<RawListing | null> {
  const externalId = await card.getAttribute('data-job-id');
  if (!externalId) return null;
  const title = await readInner(card, JOB_TITLE_SELECTOR);
  if (!title) return null;
  const company = (await readInner(card, JOB_CARD_COMPANY_SELECTOR)) ?? '';
  const location = await readInner(card, JOB_CARD_LOCATION_SELECTOR);
  const snippet = await readInner(card, JOB_CARD_SNIPPET_SELECTOR);
  const postedAt = await readAttr(card, JOB_CARD_POSTED_AT_SELECTOR, 'datetime');
  const href = await readAttr(card, JOB_CARD_LINK_SELECTOR, 'href');
  const url = href ? new URL(href, baseUrl).toString() : '';
  return {
    externalId,
    title,
    company,
    location,
    url,
    snippet,
    postedAt,
  };
}

/**
 * LinkedIn `SiteAdapter` — discovery only (M11-subset). Form-walker
 * methods land in M15. Predicates use path-based URL checks so the
 * adapter works against both real LinkedIn and the test fixture (same
 * `/feed` and `/login` paths, different hosts).
 */
export const linkedInAdapter: SiteAdapter = {
  id: 'linkedin',
  displayName: 'LinkedIn',
  loginUrl: `${LINKEDIN_ORIGIN}/login`,

  async onLoginSuccess(page) {
    return new URL(page.url()).pathname.startsWith('/feed');
  },

  async onSessionExpired(page) {
    return new URL(page.url()).pathname.startsWith('/login');
  },

  async *search(page, prefs, signal) {
    const url = buildSearchUrl(page.url(), prefs);
    await page.goto(url);
    await page.waitForSelector(JOB_CARD_SELECTOR, {
      state: 'visible',
      timeout: SELECTOR_TIMEOUT_MS,
    });

    const cards = await page.locator(JOB_CARD_SELECTOR).all();
    let isFirst = true;
    for (const card of cards) {
      // Pace per ADR-013: 4-8s between listings yielded from search.
      // Skipped on the first iteration so we don't pause before yielding
      // anything, and not run after the last yield.
      if (!isFirst) await sleepBetweenListings(signal);
      isFirst = false;
      const listing = await extractRawListing(card, page.url());
      if (listing) yield listing;
    }
  },

  // reason: signal threading lands with the M15 form-walker rework that
  // also revisits this method's signature; for M11 discovery the search
  // loop is the only long-running path that needs cooperative cancel.
  async openListing(page, listing) {
    await page.goto(listing.url);
    await page.waitForSelector(JOB_TITLE_SELECTOR, {
      state: 'visible',
      timeout: SELECTOR_TIMEOUT_MS,
    });
    const description = await page.locator(JOB_DESCRIPTION_SELECTOR).innerText();
    const salaryText = await readInner(page, JOB_SALARY_SELECTOR);
    return { description, salaryText } satisfies JobDetail;
  },

  async detectApplyMethod(page) {
    await page.waitForSelector(APPLY_BUTTON_ROOT_SELECTOR, {
      state: 'visible',
      timeout: SELECTOR_TIMEOUT_MS,
    });

    const easyApply = await firstVisible(page, EASY_APPLY_SELECTORS);
    if (easyApply) return { method: 'auto' };

    const externalApply = await firstVisible(page, EXTERNAL_APPLY_SELECTORS);
    if (!externalApply) return { method: 'manual', externalApplyUrl: null };

    const href = await getHref(externalApply);
    if (!href || !isExternalUrl(LINKEDIN_ORIGIN, href)) {
      return { method: 'manual', externalApplyUrl: null };
    }
    return { method: 'manual', externalApplyUrl: href };
  },
};
