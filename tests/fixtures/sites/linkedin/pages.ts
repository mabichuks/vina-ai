import {
  APPLY_BUTTON_TEST_ID,
  JOB_CARD_DATA_ATTR,
  JOB_DESCRIPTION_CLASS,
  JOB_SALARY_CLASS,
  JOB_TITLE_CLASS,
} from './selectors.js';

/**
 * HTML page generators for the LinkedIn fixture. Each function returns
 * a complete HTML document. Pages are intentionally minimal — they
 * include only the DOM structure the adapter actually targets.
 */

function html(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body>${body}</body></html>`;
}

export function loginPage(): string {
  return html(`
    <h1>Sign in</h1>
    <form action="/login" method="POST">
      <input name="username" placeholder="Email">
      <input name="password" type="password" placeholder="Password">
      <button type="submit">Sign in</button>
    </form>
  `);
}

export function feedPage(): string {
  return html(`
    <h1>Welcome back</h1>
    <p>Your feed</p>
  `);
}

interface FixtureListing {
  id: string;
  title: string;
  company: string;
  location: string;
  snippet: string;
  postedAt: string;
}

const FIXTURE_LISTINGS: readonly FixtureListing[] = [
  {
    id: 'easy',
    title: 'Senior TypeScript Engineer',
    company: 'Acme Corp',
    location: 'Remote',
    snippet: 'Backend role with TypeScript, Postgres, AWS.',
    postedAt: '2026-05-01T00:00:00.000Z',
  },
  {
    id: 'ext',
    title: 'Staff Software Engineer',
    company: 'Globex',
    location: 'San Francisco, CA',
    snippet: 'Platform team — distributed systems, Go preferred.',
    postedAt: '2026-04-30T00:00:00.000Z',
  },
  {
    id: 'ndi',
    title: 'Principal Backend Engineer',
    company: 'Initech',
    location: 'New York, NY',
    snippet: 'Greenfield infrastructure work.',
    postedAt: '2026-04-29T00:00:00.000Z',
  },
] as const;

export function searchResultsPage(): string {
  const cards = FIXTURE_LISTINGS.map(
    (l) => `
      <div ${JOB_CARD_DATA_ATTR}="${l.id}">
        <a href="/jobs/view/${l.id}">
          <h3 class="${JOB_TITLE_CLASS}">${l.title}</h3>
          <span class="company">${l.company}</span>
          <span class="location">${l.location}</span>
          <p class="snippet">${l.snippet}</p>
          <time datetime="${l.postedAt}">${l.postedAt}</time>
        </a>
      </div>
    `,
  ).join('');
  return html(`<main><h1>Search results</h1>${cards}</main>`);
}

function detailPageBase(listing: FixtureListing, applyHtml: string): string {
  return html(`
    <main>
      <h1 class="${JOB_TITLE_CLASS}">${listing.title}</h1>
      <span class="company">${listing.company}</span>
      <span class="location">${listing.location}</span>
      <span class="${JOB_SALARY_CLASS}">$180k – $220k</span>
      <div class="${JOB_DESCRIPTION_CLASS}">${listing.snippet} Full description here.</div>
      ${applyHtml}
    </main>
  `);
}

export function easyApplyDetailPage(): string {
  const listing = FIXTURE_LISTINGS[0]!;
  return detailPageBase(
    listing,
    `<button data-test-id="${APPLY_BUTTON_TEST_ID}">Easy Apply</button>`,
  );
}

export function externalRedirectDetailPage(): string {
  const listing = FIXTURE_LISTINGS[1]!;
  return detailPageBase(
    listing,
    `<a data-test-id="${APPLY_BUTTON_TEST_ID}" href="https://workday.example/jobs/123">Apply</a>`,
  );
}

export function externalNoUrlDetailPage(): string {
  const listing = FIXTURE_LISTINGS[2]!;
  return detailPageBase(
    listing,
    `<button data-test-id="${APPLY_BUTTON_TEST_ID}">Apply</button>`,
  );
}

/** Exported for tests that want to assert on listing data directly. */
export { FIXTURE_LISTINGS };
