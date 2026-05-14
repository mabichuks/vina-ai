/**
 * The raw header data an adapter's `search` iterator yields per listing —
 * what's visible on the search results page before the detail page is
 * fetched. Combined with `JobDetail` (from `openListing`) to populate a
 * full `jobs` row.
 */
export interface RawListing {
  externalId: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  snippet: string | null;
  /** ISO timestamp parsed from "X days ago" listing text, or null when absent. */
  postedAt: string | null;
  /**
   * Card-level apply-method signal. `'auto'` when the card itself renders
   * an "Easy Apply" badge (no detail-page navigation required to know);
   * `'manual'` when no such badge is present; `null` when the adapter
   * couldn't read it confidently. Callers should treat `null` as unknown
   * and either guess a default or defer classification.
   */
  cardApplyMethod: 'auto' | 'manual' | null;
}

/**
 * The detail-page data fetched via `SiteAdapter.openListing`. Adapters
 * close (or navigate away from) the detail page before returning so the
 * caller can reuse the same `Page` for the next listing.
 */
export interface JobDetail {
  description: string;
  salaryText: string | null;
}
