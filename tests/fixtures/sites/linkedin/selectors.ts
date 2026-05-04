/**
 * Selectors used in the fixture HTML. These mirror the canonical (first)
 * variant of `packages/automation/src/adapters/linkedin/selectors.ts` —
 * the adapter side may include legacy-cohort fallbacks the fixture
 * doesn't need to render. The two files are kept in sync manually.
 *
 * If adapter tests start failing because the fixture renders the wrong
 * structure, check that the canonical selectors here still match the
 * first entry of each adapter selector array.
 */

/** Apply-button container test id (used as the data-test-id attribute value). */
export const APPLY_BUTTON_TEST_ID = 'jobs-apply-button-id';

/** Class on the job title element on the detail page. */
export const JOB_TITLE_CLASS = 'jobs-unified-top-card__job-title';

/** Class on the job description body. */
export const JOB_DESCRIPTION_CLASS = 'jobs-description';

/** Class on the salary insight element. */
export const JOB_SALARY_CLASS = 'jobs-unified-top-card__job-insight-salary';

/** Data attribute name on listing cards in the search results page. */
export const JOB_CARD_DATA_ATTR = 'data-job-id';
