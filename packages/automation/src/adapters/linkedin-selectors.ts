/**
 * LinkedIn DOM selectors used by the adapter. Multi-variant arrays cover
 * cohort-driven rendering differences — `firstVisible` tries each in
 * order and returns the first hit. Single-string constants are the
 * canonical form for elements that don't drift across cohorts.
 *
 * The fixture site at `tests/fixtures/sites/linkedin/` mirrors a subset
 * of these selectors so adapter tests exercise the same selector paths
 * the real-LinkedIn DOM does. The two are kept in sync manually — a
 * fixture HTML change without an adapter selector update (or vice
 * versa) breaks the relevant test loudly.
 */

/** Selector for the apply-button container, used as a readiness wait. */
export const APPLY_BUTTON_ROOT_SELECTOR = '[data-test-id="jobs-apply-button-id"]';

/** Easy Apply variants — order matters; specific selectors first. */
export const EASY_APPLY_SELECTORS = [
  'button[data-test-id="jobs-apply-button-id"]:has-text("Easy Apply")',
  'button:has-text("Easy Apply")',
];

/** External-redirect variants — anchor preferred (href readable), button fallback. */
export const EXTERNAL_APPLY_SELECTORS = [
  'a[data-test-id="jobs-apply-button-id"]',
  'button[data-test-id="jobs-apply-button-id"]',
];

/** Job title element on the listing detail page. */
export const JOB_TITLE_SELECTOR = '.jobs-unified-top-card__job-title';

/** Job description body. */
export const JOB_DESCRIPTION_SELECTOR = '.jobs-description';

/** Salary text — optional, may not be present on every listing. */
export const JOB_SALARY_SELECTOR = '.jobs-unified-top-card__job-insight-salary';

/** Listing card on the search results page; carries `data-job-id`. */
export const JOB_CARD_SELECTOR = '[data-job-id]';
