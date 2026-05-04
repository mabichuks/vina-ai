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

/** Selector for the apply-button container, used as a readiness wait. */
export const APPLY_BUTTON_ROOT_SELECTOR = '[data-test-id="jobs-apply-button-id"]';

/** Easy Apply variants — order matters; specific selectors first. */
export const EASY_APPLY_SELECTORS = [
  'button[data-test-id="jobs-apply-button-id"]:has-text("Easy Apply")',
  'button:has-text("Easy Apply")',
] as const;

/** External-redirect variants — order matters; anchor preferred (href readable), button fallback. */
export const EXTERNAL_APPLY_SELECTORS = [
  'a[data-test-id="jobs-apply-button-id"]',
  'button[data-test-id="jobs-apply-button-id"]',
] as const;

/** Job title element on the listing detail page. */
export const JOB_TITLE_SELECTOR = '.jobs-unified-top-card__job-title';

/** Job description body. */
export const JOB_DESCRIPTION_SELECTOR = '.jobs-description';

/** Salary text — optional, may not be present on every listing. */
export const JOB_SALARY_SELECTOR = '.jobs-unified-top-card__job-insight-salary';

/** Listing card on the search results page; carries `data-job-id`. */
export const JOB_CARD_SELECTOR = '[data-job-id]';

/**
 * Card sub-selectors used by `extractRawListing`. These match the fixture
 * DOM today; real LinkedIn cards use different class names (e.g.
 * `.job-card-list__company-name`) and will need cohort-aware variants
 * when the live integration lands. Kept here so the file is the single
 * source of truth for everything the adapter targets.
 */
export const JOB_CARD_LINK_SELECTOR = 'a';
export const JOB_CARD_COMPANY_SELECTOR = '.company';
export const JOB_CARD_LOCATION_SELECTOR = '.location';
export const JOB_CARD_SNIPPET_SELECTOR = '.snippet';
export const JOB_CARD_POSTED_AT_SELECTOR = 'time';
