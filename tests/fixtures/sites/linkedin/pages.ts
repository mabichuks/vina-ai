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

// All fixture inputs are trusted constants in this file — no escaping needed.
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

/**
 * Jobs landing page with a real search form. The adapter's `search` method
 * simulates a user typing into the keywords input and pressing Enter; this
 * page renders inputs whose id-prefixes match `KEYWORDS_INPUT_SELECTORS` /
 * `LOCATION_INPUT_SELECTORS` in the adapter so the same code path runs in
 * tests as in production.
 */
export function jobsHomePage(): string {
  return html(`
    <h1>Jobs</h1>
    <form action="/jobs/search/" method="GET">
      <input
        id="jobs-search-box-keyword-id-fixture"
        name="keywords"
        aria-label="Search by title, skill, or company"
        placeholder="Title, skill or company"
      />
      <input
        id="jobs-search-box-location-id-fixture"
        name="location"
        aria-label="City, state, or zip code"
        placeholder="City, state, or zip code"
      />
      <button type="submit">Search</button>
    </form>
  `);
}

type FixtureListingId = 'easy' | 'ext' | 'ndi';

interface FixtureListing {
  id: FixtureListingId;
  title: string;
  company: string;
  location: string;
  snippet: string;
  postedAt: string;
}

const FIXTURE_LISTINGS = {
  easy: {
    id: 'easy',
    title: 'Senior TypeScript Engineer',
    company: 'Acme Corp',
    location: 'Remote',
    snippet: 'Backend role with TypeScript, Postgres, AWS.',
    postedAt: '2026-05-01T00:00:00.000Z',
  },
  ext: {
    id: 'ext',
    title: 'Staff Software Engineer',
    company: 'Globex',
    location: 'San Francisco, CA',
    snippet: 'Platform team — distributed systems, Go preferred.',
    postedAt: '2026-04-30T00:00:00.000Z',
  },
  ndi: {
    id: 'ndi',
    title: 'Principal Backend Engineer',
    company: 'Initech',
    location: 'New York, NY',
    snippet: 'Greenfield infrastructure work.',
    postedAt: '2026-04-29T00:00:00.000Z',
  },
} as const satisfies Record<FixtureListingId, FixtureListing>;

export function searchResultsPage(): string {
  // Search cards intentionally omit JOB_SALARY_CLASS — salary appears only on detail pages.
  const cards = Object.values(FIXTURE_LISTINGS)
    .map(
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
    )
    .join('');
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

/**
 * The fixture Easy Apply form markup (fields only — no submit handler script),
 * shared between the button-variant and anchor-variant detail pages so both
 * exercise the identical form-walking path. Extracted to a const so the two
 * pages don't diverge silently. The submit handler is wired separately in each
 * page so it runs in the document context rather than being injected via
 * innerHTML (scripts inside innerHTML are intentionally not executed by browsers).
 */
const EASY_APPLY_FORM_HTML = `
  <form data-vina-fixture="easy-apply">
    <label>First name <input type="text" name="first_name" required></label>
    <label>Last name <input type="text" name="last_name" required></label>
    <label>Email <input type="email" name="email" required></label>
    <label>Resume <input type="file" name="resume" data-vina-field="cv"></label>
    <button type="submit">Submit application</button>
  </form>
`;

export function easyApplyDetailPage(): string {
  return detailPageBase(
    FIXTURE_LISTINGS.easy,
    `<button data-test-id="${APPLY_BUTTON_TEST_ID}">Easy Apply</button>
    ${EASY_APPLY_FORM_HTML}
    <script>
      document.querySelector('form[data-vina-fixture="easy-apply"]').addEventListener('submit', (e) => {
        e.preventDefault();
        const fields = new FormData(e.target);
        const ok = ['first_name','last_name','email'].every((k) => fields.get(k));
        if (ok) {
          document.body.innerHTML =
            '<h2 data-vina-fixture="apply-success">Application submitted</h2>';
        }
      });
    </script>`,
  );
}

/**
 * 2026 anchor-variant Easy Apply detail page. The CTA is an <a> (role=link,
 * accessible name "Easy Apply to this job"), not a <button> — the real page
 * that broke the apply flow on 2026-07-05. Also carries a decoy global-nav
 * search <form> so tests pin the form-root false positive: the apply flow
 * must NOT treat that form as the application modal.
 */
export function easyApplyAnchorDetailPage(): string {
  const cta = `
    <form class="global-nav-typeahead" action="/search"><input name="q" placeholder="Search" /></form>
    <a class="jobs-apply-button" href="/jobs/view/easy/apply?openSDUIApplyFlow=true"
       aria-label="Easy Apply to this job">Easy Apply to this job</a>
    <div id="anchor-apply-slot"></div>
    <template id="anchor-apply-template">${EASY_APPLY_FORM_HTML}</template>
    <script>
      document.querySelector('a.jobs-apply-button').addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('anchor-apply-slot').innerHTML =
          document.getElementById('anchor-apply-template').innerHTML;
        // Wire the submit handler after injecting the form (innerHTML-injected
        // scripts do not execute, so the handler must be attached here).
        document.querySelector('form[data-vina-fixture="easy-apply"]').addEventListener('submit', (ev) => {
          ev.preventDefault();
          const fields = new FormData(ev.target);
          const ok = ['first_name','last_name','email'].every((k) => fields.get(k));
          if (ok) {
            document.body.innerHTML =
              '<h2 data-vina-fixture="apply-success">Application submitted</h2>';
          }
        });
      });
    </script>
  `;
  return detailPageBase(FIXTURE_LISTINGS.easy, cta);
}

export function externalRedirectDetailPage(): string {
  return detailPageBase(
    FIXTURE_LISTINGS.ext,
    `<a data-test-id="${APPLY_BUTTON_TEST_ID}" href="https://workday.example/jobs/123">Apply</a>`,
  );
}

export function externalNoUrlDetailPage(): string {
  return detailPageBase(
    FIXTURE_LISTINGS.ndi,
    `<button data-test-id="${APPLY_BUTTON_TEST_ID}">Apply</button>`,
  );
}

/**
 * Logged-out "jserp" guest SERP: job cards exist but carry
 * `public_jobs_*` tracking names and /jobs/view/ anchors instead of the
 * authenticated SPA structure. Mirrors what LinkedIn serves when the
 * session cookie has expired (plus an authwall modal).
 * Guest hrefs are slug-style (job title and company slug, with id at the tail),
 * which is why the adapter cannot extract an external id from guest cards —
 * the fixture must mirror that unextractable pattern.
 */
export function guestSearchResultsPage(): string {
  return `<!doctype html><html><head><title>563 Software jobs in United Kingdom</title></head>
<body>
  <div role="dialog" class="authwall-modal">Sign in to view more jobs</div>
  <ul class="jobs-search__results-list">
    <li><a data-tracking-control-name="public_jobs_jserp-result_search-card" href="/jobs/view/senior-software-engineer-at-spectrum-it-recruitment-4306548812">Senior Software Engineer</a></li>
    <li><a data-tracking-control-name="public_jobs_jserp-result_search-card" href="/jobs/view/backend-engineer-at-capital-on-tap-4306548813">Backend Engineer</a></li>
  </ul>
</body></html>`;
}

/** Exported for tests that want to assert on listing data directly. */
export { FIXTURE_LISTINGS };
