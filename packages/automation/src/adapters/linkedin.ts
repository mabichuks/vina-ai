import type { Locator, Page } from 'playwright';
import type { SearchPreferences } from '@vina/shared';
import { firstVisible, getHref, isExternalUrl } from '../detect/apply-method.js';
import { pause } from '../browser/humanise.js';
import type { SiteAdapter } from './adapter.js';
import type { JobDetail, RawListing } from './types.js';
import {
  APPLY_BUTTON_ROOT_SELECTOR,
  EASY_APPLY_SELECTORS,
  EXTERNAL_APPLY_SELECTORS,
  JOB_CARD_SELECTOR,
  JOB_DESCRIPTION_SELECTOR,
  JOB_SALARY_SELECTOR,
  JOB_TITLE_SELECTOR,
} from './linkedin-selectors.js';

const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

function buildSearchUrl(currentUrl: string, prefs: SearchPreferences): string {
  const base = new URL(currentUrl);
  const url = new URL('/jobs/search', base.origin);
  if (prefs.keywords.length > 0) {
    url.searchParams.set('keywords', prefs.keywords.join(' '));
  }
  if (prefs.locations.length > 0) {
    url.searchParams.set('location', prefs.locations[0]!);
  }
  return url.toString();
}

async function readOptional(page: Page, selector: string): Promise<string | null> {
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) return null;
  return await locator.innerText();
}

async function extractRawListing(card: Locator, baseUrl: string): Promise<RawListing | null> {
  const externalId = await card.getAttribute('data-job-id');
  if (!externalId) return null;
  const titleText = await card.locator(JOB_TITLE_SELECTOR).first().innerText();
  if (!titleText) return null;
  const company = await card.locator('.company').first().innerText();
  const location = await card.locator('.location').first().innerText();
  const snippet = await card.locator('.snippet').first().innerText();
  const postedAt = await card.locator('time').first().getAttribute('datetime');
  const href = await card.locator('a').first().getAttribute('href');
  const url = href ? new URL(href, baseUrl).toString() : '';
  return {
    externalId,
    title: titleText,
    company,
    location: location || null,
    url,
    snippet: snippet || null,
    postedAt: postedAt || null,
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
    await page.waitForSelector(JOB_CARD_SELECTOR, { state: 'visible' });

    const cards = await page.locator(JOB_CARD_SELECTOR).all();
    for (const card of cards) {
      const listing = await extractRawListing(card, page.url());
      if (listing) yield listing;
      await pause(200, 600, signal);
    }
  },

  async openListing(page, listing) {
    await page.goto(listing.url);
    await page.waitForSelector(JOB_TITLE_SELECTOR, { state: 'visible' });
    const description = await page.locator(JOB_DESCRIPTION_SELECTOR).innerText();
    const salaryText = await readOptional(page, JOB_SALARY_SELECTOR);
    return { description, salaryText } satisfies JobDetail;
  },

  async detectApplyMethod(page) {
    await page.waitForSelector(APPLY_BUTTON_ROOT_SELECTOR, { state: 'visible' });

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
