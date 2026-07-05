import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { SearchPreferences } from '@vina/shared';
import { linkedInAdapter } from '../../src/adapters/linkedin/index.js';
import { startLinkedInFixture } from '../../../../tests/fixtures/sites/linkedin/server.js';
import type { FixtureServerHandle } from '../../../../tests/fixtures/start-server.js';

let fixture: FixtureServerHandle;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  fixture = await startLinkedInFixture();
});
afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterEach(async () => {
  await browser.close();
});

const PREFS: SearchPreferences = {
  id: 'default',
  description: 'TS backend',
  keywords: ['typescript'],
  locations: ['Remote'],
  work_models: ['remote'],
  seniority: ['senior'],
  min_salary: null,
  max_salary: null,
  salary_currency: null,
  excluded_companies: [],
  score_threshold: 70,
  updated_at: '2026-05-03T00:00:00.000Z',
};

describe('linkedInAdapter — login predicates', () => {
  it('onLoginSuccess returns true on /feed', async () => {
    await page.goto(`${fixture.url}/feed`);
    expect(await linkedInAdapter.onLoginSuccess(page)).toBe(true);
  }, 30_000);

  it('onLoginSuccess returns false on /login', async () => {
    await page.goto(`${fixture.url}/login`);
    expect(await linkedInAdapter.onLoginSuccess(page)).toBe(false);
  }, 30_000);

  it('onSessionExpired returns true on /login', async () => {
    await page.goto(`${fixture.url}/login`);
    expect(await linkedInAdapter.onSessionExpired(page)).toBe(true);
  }, 30_000);

  it('onSessionExpired returns false on /feed', async () => {
    await page.goto(`${fixture.url}/feed`);
    expect(await linkedInAdapter.onSessionExpired(page)).toBe(false);
  }, 30_000);

  it('onSessionExpired detects the logged-out guest SERP', async () => {
    await page.goto(`${fixture.url}/jobs/search-guest`);
    expect(await linkedInAdapter.onSessionExpired(page)).toBe(true);
  }, 30_000);

  it('onSessionExpired detects the authwall path', async () => {
    await page.goto(`${fixture.url}/authwall`);
    expect(await linkedInAdapter.onSessionExpired(page)).toBe(true);
  }, 30_000);

  it('onSessionExpired stays false on the authenticated SRP', async () => {
    await page.goto(`${fixture.url}/jobs/search?keywords=x`);
    expect(await linkedInAdapter.onSessionExpired(page)).toBe(false);
  }, 30_000);
});

describe('linkedInAdapter.search', () => {
  it('yields a RawListing for each card on the search results page', async () => {
    await page.goto(`${fixture.url}/feed`);
    const collected: Array<{ externalId: string; title: string }> = [];
    for await (const listing of linkedInAdapter.search(page, PREFS)) {
      collected.push({ externalId: listing.externalId, title: listing.title });
    }
    expect(collected.map((l) => l.externalId).sort()).toEqual(['easy', 'ext', 'ndi']);
    expect(collected.find((l) => l.externalId === 'easy')?.title).toBe(
      'Senior TypeScript Engineer',
    );
  }, 30_000);

  it('aborts mid-iteration when the signal aborts', async () => {
    await page.goto(`${fixture.url}/feed`);
    const controller = new AbortController();
    const collected: string[] = [];
    let rejected: unknown = null;
    try {
      for await (const listing of linkedInAdapter.search(page, PREFS, controller.signal)) {
        collected.push(listing.externalId);
        controller.abort('test-abort');
      }
    } catch (err) {
      rejected = err;
    }
    expect(rejected).toBe('test-abort');
    expect(collected.length).toBe(1);
  }, 30_000);
});

describe('linkedInAdapter.openListing', () => {
  it('extracts description and salary from a detail page', async () => {
    const detail = await linkedInAdapter.openListing(page, {
      externalId: 'easy',
      title: 'Senior TypeScript Engineer',
      company: 'Acme Corp',
      location: 'Remote',
      url: `${fixture.url}/jobs/view/easy`,
      snippet: null,
      postedAt: null,
      cardApplyMethod: null,
    });
    expect(detail.description).toContain('Full description');
    expect(detail.salaryText).toBe('$180k – $220k');
  }, 30_000);
});

describe('linkedInAdapter.detectApplyMethod', () => {
  it("returns { method: 'auto' } for the Easy Apply detail", async () => {
    await page.goto(`${fixture.url}/jobs/view/easy`);
    const result = await linkedInAdapter.detectApplyMethod(page, {
      externalId: 'easy',
      title: 'Senior TypeScript Engineer',
      company: 'Acme Corp',
      location: 'Remote',
      url: `${fixture.url}/jobs/view/easy`,
      snippet: null,
      postedAt: null,
      cardApplyMethod: null,
    });
    expect(result).toEqual({ method: 'auto' });
  }, 30_000);

  it("returns { method: 'manual', externalApplyUrl: '<url>' } for the external-redirect detail", async () => {
    await page.goto(`${fixture.url}/jobs/view/ext`);
    const result = await linkedInAdapter.detectApplyMethod(page, {
      externalId: 'ext',
      title: 'Staff Software Engineer',
      company: 'Globex',
      location: 'San Francisco, CA',
      url: `${fixture.url}/jobs/view/ext`,
      snippet: null,
      postedAt: null,
      cardApplyMethod: null,
    });
    expect(result).toEqual({
      method: 'manual',
      externalApplyUrl: 'https://workday.example/jobs/123',
    });
  }, 30_000);

  it("returns { method: 'manual', externalApplyUrl: null } for the no-href detail (degraded)", async () => {
    await page.goto(`${fixture.url}/jobs/view/ndi`);
    const result = await linkedInAdapter.detectApplyMethod(page, {
      externalId: 'ndi',
      title: 'Principal Backend Engineer',
      company: 'Initech',
      location: 'New York, NY',
      url: `${fixture.url}/jobs/view/ndi`,
      snippet: null,
      postedAt: null,
      cardApplyMethod: null,
    });
    expect(result).toEqual({ method: 'manual', externalApplyUrl: null });
  }, 30_000);
});
