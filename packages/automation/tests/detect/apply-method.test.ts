import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { firstVisible, getHref, isExternalUrl } from '../../src/detect/apply-method.js';

let browser: Browser;
let page: Page;

beforeEach(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterEach(async () => {
  await browser.close();
});

describe('firstVisible', () => {
  it('returns the first matching visible locator (selector order wins)', async () => {
    await page.setContent(`
      <button id="b1">Apply</button>
      <button id="b2">Easy Apply</button>
    `);
    const result = await firstVisible(page, [
      'button:has-text("Easy Apply")',
      'button:has-text("Apply")',
    ]);
    expect(result).not.toBeNull();
    expect(await result?.getAttribute('id')).toBe('b2');
  });

  it('returns null when no selector matches', async () => {
    await page.setContent('<div></div>');
    const result = await firstVisible(page, [
      'button:has-text("Apply")',
      'a.apply-link',
    ]);
    expect(result).toBeNull();
  });
});

describe('getHref', () => {
  it('reads the href attribute from an anchor', async () => {
    await page.setContent('<a href="https://workday.com/apply">Apply</a>');
    const link = page.locator('a').first();
    expect(await getHref(link)).toBe('https://workday.com/apply');
  });

  it('returns null when the element has no href', async () => {
    await page.setContent('<a>Apply</a>');
    const link = page.locator('a').first();
    expect(await getHref(link)).toBeNull();
  });
});

describe('isExternalUrl', () => {
  it('classifies same-origin and cross-origin URLs', () => {
    expect(
      isExternalUrl('https://www.linkedin.com', 'https://www.linkedin.com/jobs/123'),
    ).toBe(false);
    expect(isExternalUrl('https://www.linkedin.com', 'https://workday.com/apply')).toBe(true);
    // Different subdomain → cross-origin per the WHATWG URL Standard.
    expect(isExternalUrl('https://www.linkedin.com', 'https://api.linkedin.com/jobs')).toBe(true);
  });
});
