/**
 * LinkedIn DOM selectors used by the adapter. Multi-variant arrays cover
 * cohort-driven rendering differences — `firstVisible` tries each in
 * order and returns the first hit. Single-string constants are the
 * canonical form for elements that don't drift across cohorts.
 *
 * **Array order is load-bearing.** The most specific selector goes first,
 * the fallback last. The arrays are typed `as const` (readonly) so the
 * type system prevents accidental reordering or mutation by consumers.
 *
 * The fixture site at `tests/fixtures/sites/linkedin/` mirrors a subset
 * of these selectors so adapter tests exercise the same selector paths
 * the real-LinkedIn DOM does. The two are kept in sync manually — a
 * fixture HTML change without an adapter selector update (or vice
 * versa) breaks the relevant test loudly.
 */

/**
 * Selector for the apply-button container, used as a readiness wait. LinkedIn
 * renders the apply CTA differently across cohorts:
 *   - real LinkedIn (newest):  <a class="jobs-apply-button" href="/jobs/view/<id>/apply/…">
 *   - real LinkedIn (2026):    <button id="jobs-apply-button-id">
 *   - fixture:                 <button data-test-id="jobs-apply-button-id">
 * Any of these matching means the apply UI is rendered.
 */
export const APPLY_BUTTON_ROOT_SELECTOR =
  'a.jobs-apply-button, #jobs-apply-button-id, [data-test-id="jobs-apply-button-id"]';

/**
 * Easy Apply variants — order matters; specific (id + discriminator) first,
 * fixture last. Discriminators avoid mis-matching the external Apply button,
 * which shares the same id.
 *
 * Real LinkedIn (2026):
 *   <button id="jobs-apply-button-id"
 *           aria-label="Easy Apply to <title> at <company>">
 *     <svg data-test-icon="linkedin-bug-xxsmall">…</svg>
 *     <span class="artdeco-button__text">Easy Apply</span>
 *   </button>
 */
export const EASY_APPLY_SELECTORS = [
  // Newest real LinkedIn — Easy Apply CTA is an <a> with the SDUI flow href.
  // Per docs/linkedin-playwright-automation.md, this is the most reliable
  // signal that Easy Apply is available on a given listing.
  'a.jobs-apply-button[href*="openSDUIApplyFlow"]',
  'a.jobs-apply-button[href*="/apply/"]',
  // 2026 cohort — <button id="jobs-apply-button-id"> variant.
  'button#jobs-apply-button-id[aria-label^="Easy Apply"]',
  'button#jobs-apply-button-id:has(svg[data-test-icon="linkedin-bug-xxsmall"])',
  // Fixture.
  'button[data-test-id="jobs-apply-button-id"]:has-text("Easy Apply")',
  'button:has-text("Easy Apply")',
] as const;

/**
 * External-redirect variants — order matters. Real LinkedIn uses a
 * `<button role="link">` (no `href` on the element — clicking opens the
 * external site in a new tab); the fixture uses an `<a href>`. Anchor stays
 * preferred so we can read the href directly when available.
 *
 * Real LinkedIn (2026):
 *   <button role="link" id="jobs-apply-button-id"
 *           aria-label="Apply to <title> on company website">
 *     <svg data-test-icon="link-external-small">…</svg>
 *     <span class="artdeco-button__text">Apply</span>
 *   </button>
 */
export const EXTERNAL_APPLY_SELECTORS = [
  'a[data-test-id="jobs-apply-button-id"]',
  'button#jobs-apply-button-id[role="link"]',
  'button#jobs-apply-button-id:has(svg[data-test-icon="link-external-small"])',
  'button#jobs-apply-button-id[aria-label*="company website"]',
  'button[data-test-id="jobs-apply-button-id"]',
] as const;

/**
 * Job title element on the listing detail page. Multi-variant union to
 * cover cohort drift — `.jobs-unified-top-card__job-title` (fixture + older
 * cohorts), `.job-details-jobs-unified-top-card__job-title` (newer split
 * naming), plus structural fallbacks. Used by `openListing`'s readiness
 * wait — without a match, every per-listing detail fetch times out and
 * Vina silently drops every job at the enrichment stage (we just learned
 * the hard way).
 */
export const JOB_TITLE_SELECTOR = [
  '.jobs-unified-top-card__job-title',
  '.job-details-jobs-unified-top-card__job-title',
  '.jobs-search__job-details h1',
  'h1.t-24',
  'main h1',
].join(', ');

/**
 * Job title variants on a search-results card. Real LinkedIn does **not**
 * use `.jobs-unified-top-card__job-title` on cards (that's the detail page);
 * cards use one of the variants below depending on cohort. Per
 * `docs/linkedin-playwright-automation.md`, the most stable real-LinkedIn
 * selector is `a[data-control-name="job_card_title"]` — `data-control-name`
 * survives DOM redesigns because LinkedIn uses it for click tracking.
 * Order: fixture-friendly first, real-LinkedIn variants follow.
 */
export const JOB_CARD_TITLE_SELECTORS = [
  '.jobs-unified-top-card__job-title',
  'a[data-control-name="job_card_title"]',
  '.job-card-list__title',
  '.job-card-list__title--link',
  '.job-card-container__link',
  'a.job-card-list__entity-lockup',
  'a[aria-label][data-control-id]',
] as const;

/**
 * Job description body on the detail page. Multi-variant union — fixture
 * uses `.jobs-description`; real LinkedIn cohorts use
 * `.jobs-description-content`, `.jobs-box__html-content`, or scope it
 * under `#job-details`.
 */
export const JOB_DESCRIPTION_SELECTOR = [
  '.jobs-description',
  '.jobs-description-content',
  '.jobs-box__html-content',
  '#job-details',
  '.jobs-search__job-details .jobs-description-content',
].join(', ');

/**
 * Salary text on the detail page — optional. Real LinkedIn uses several
 * insight-row variants; fixture uses the older class.
 */
export const JOB_SALARY_SELECTOR = [
  '.jobs-unified-top-card__job-insight-salary',
  '.job-details-jobs-unified-top-card__job-insight-salary',
  '.jobs-unified-top-card__job-insight--highlight',
  '[class*="salary"]',
].join(', ');

/**
 * Listing card on the search results page. Multiple cohorts:
 *
 * 1. Newest real LinkedIn — `li.jobs-search-results__list-item` (per
 *    docs/linkedin-playwright-automation.md, the canonical SRP card).
 *    Also surfaces in `ul.scaffold-layout__list-container` as direct `<li>`.
 * 2. Classic / fixture — outer container has `data-job-id`.
 * 3. Mid-2024 cohort — `data-occludable-job-id` on the outer card.
 * 4. 2026 AI-search SRP cohort — cards are clickable list items / bare
 *    anchors whose primary link uses `?currentJobId=<id>` for SPA routing.
 *
 * Order is precise → structural so the cheapest selector wins when present.
 */
// The bare-anchor variants are scoped to <main> so they don't match nav-bar
// or sidebar links like "Recently viewed jobs", which would otherwise yield
// fake cards with no title/company and trigger the LLM recovery path.
export const JOB_CARD_SELECTOR = [
  'li.jobs-search-results__list-item',
  'ul.scaffold-layout__list-container > li',
  '[data-occludable-job-id]',
  '[data-job-id]',
  'main a[href*="currentJobId="]',
  'li:has(a[href*="currentJobId="])',
  '[role="listitem"]:has(a[href*="currentJobId="])',
  'li:has(a[href*="/jobs/view/"])',
  '[role="listitem"]:has(a[href*="/jobs/view/"])',
].join(', ');

/**
 * Card sub-selectors used by `extractRawListing`. Each is a comma-joined
 * union of fixture + real-LinkedIn variants — Playwright's `.locator(sel).first()`
 * returns the first match across the union so order is preference-driven
 * (fixture first to keep adapter tests deterministic, real-LinkedIn second).
 * The real-LinkedIn class names come from
 * `docs/linkedin-playwright-automation.md`.
 */
export const JOB_CARD_LINK_SELECTOR = 'a';
export const JOB_CARD_COMPANY_SELECTOR =
  '.company, .job-card-container__primary-description, .job-card-container__company-name';
export const JOB_CARD_LOCATION_SELECTOR =
  '.location, .job-card-container__metadata-item';
export const JOB_CARD_SNIPPET_SELECTOR =
  '.snippet, .job-card-container__metadata-wrapper';
export const JOB_CARD_POSTED_AT_SELECTOR = 'time';
