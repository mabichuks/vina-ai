/**
 * SerpAPI client. `validateSerpApiKey` confirms a key works for onboarding.
 * `searchGoogleJobs` is the paginated iterator used by the search handler.
 */

export type ValidateResult =
  | { ok: true; latency_ms: number }
  | {
      ok: false;
      reason: 'auth_failed' | 'rate_limited' | 'network' | 'other';
      detail?: string;
    };

export const SERPAPI_BASE = 'https://serpapi.com/search.json';

interface SerpApiErrorBody {
  error?: string;
}

/**
 * Confirms the supplied SerpAPI key works against the Google Jobs engine
 * with the cheapest possible query (single result, no extras).
 */
export async function validateSerpApiKey(plaintext: string): Promise<ValidateResult> {
  if (!plaintext) return { ok: false, reason: 'auth_failed' };

  const url = new URL(SERPAPI_BASE);
  url.searchParams.set('engine', 'google_jobs');
  url.searchParams.set('q', 'engineer');
  url.searchParams.set('num', '1');
  url.searchParams.set('api_key', plaintext);

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET' });
  } catch {
    return { ok: false, reason: 'network' };
  }
  const latency_ms = Date.now() - started;

  if (res.status === 401) return { ok: false, reason: 'auth_failed' };
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };

  // SerpAPI returns 200 with `{ "error": "..." }` when the key is bad rather
  // than HTTP 401 — read the body to disambiguate.
  let body: SerpApiErrorBody = {};
  try {
    body = (await res.json()) as SerpApiErrorBody;
  } catch {
    return { ok: false, reason: 'other', detail: `non-JSON response ${res.status}` };
  }

  if (body.error) {
    const lower = body.error.toLowerCase();
    if (lower.includes('invalid api key') || lower.includes('unauthorized')) {
      return { ok: false, reason: 'auth_failed', detail: body.error };
    }
    if (lower.includes('limit') || lower.includes('exceeded')) {
      return { ok: false, reason: 'rate_limited', detail: body.error };
    }
    return { ok: false, reason: 'other', detail: body.error };
  }

  if (!res.ok) return { ok: false, reason: 'other', detail: `HTTP ${res.status}` };
  return { ok: true, latency_ms };
}

// ---------------------------------------------------------------------------
// searchGoogleJobs — paginated async iterator
// ---------------------------------------------------------------------------

/**
 * Restricts results to listings posted within the given window. Mirrors
 * Google Jobs' "Date posted" facet on the UI.
 *
 * Implementation choice: append a natural-language phrase to the `q` string
 * rather than the `chips` param. SerpAPI's documented `chips` filter is a
 * server-issued token from a prior response's `chips_filter` array — it
 * isn't a manually-constructable `key:value` string. Google Jobs parses
 * "in the last N days" out of the query itself, which is what the SerpAPI
 * playground demonstrates ("`.net developer jobs uk in the last 3 days`").
 */
export type DatePostedFilter = 'today' | '3days' | 'week' | 'month';

const DATE_POSTED_PHRASES: Record<DatePostedFilter, string> = {
  today: 'in the last 24 hours',
  '3days': 'in the last 3 days',
  week: 'in the last week',
  month: 'in the last month',
};

export interface GoogleJobsSearchInput {
  keywords: string;
  location?: string;
  num?: number;
  date_posted?: DatePostedFilter;
}

export interface GoogleJobsListing {
  external_id: string;
  title: string;
  company: string;
  location: string | null;
  description: string;
  via: string | null;
  apply_url: string;
  salary_text: string | null;
}

export interface SearchGoogleJobsOpts {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Default 3. Caps total HTTP calls per invocation. */
  maxPages?: number;
  /** Default 2000ms. Backoff before the single 5xx retry. Test seam. */
  retryDelayMs?: number;
  signal?: AbortSignal;
}

export class SerpapiKeyInvalidError extends Error {
  readonly code = 'serpapi_key_invalid' as const;
  constructor(detail: string) {
    super(`SerpAPI rejected the key: ${detail}`);
  }
}

export class SerpapiQuotaExhaustedError extends Error {
  readonly code = 'serpapi_quota_exhausted' as const;
  constructor() {
    super('SerpAPI monthly quota exhausted (HTTP 429)');
  }
}

export class SerpapiTransientError extends Error {
  readonly code = 'serpapi_transient' as const;
  constructor(detail: string) {
    super(`SerpAPI transient failure: ${detail}`);
  }
}

const SALARY_RE = /\$[\d,]+(?:\.\d+)?[KMk]?(?:\s*[-–]\s*\$[\d,]+(?:\.\d+)?[KMk]?)?/;

interface RawJob {
  job_id?: string;
  title?: string;
  company_name?: string;
  location?: string;
  description?: string;
  via?: string;
  extensions?: string[];
  detected_extensions?: { salary?: string };
  apply_options?: Array<{ title?: string; link?: string }>;
}

function mapJobResult(raw: RawJob): GoogleJobsListing | null {
  const link = raw.apply_options?.[0]?.link;
  if (!link) return null;
  const externalId = raw.job_id ?? link;
  const salary =
    raw.detected_extensions?.salary ??
    raw.extensions?.find((e) => SALARY_RE.test(e)) ??
    null;
  return {
    external_id: externalId,
    title: raw.title ?? '(untitled)',
    company: raw.company_name ?? '(unknown)',
    location: raw.location ?? null,
    description: raw.description ?? '',
    via: raw.via ?? null,
    apply_url: link,
    salary_text: salary,
  };
}

function redactKey(url: URL): string {
  const u = new URL(url.toString());
  if (u.searchParams.has('api_key')) u.searchParams.set('api_key', 'REDACTED');
  return u.toString();
}

export async function* searchGoogleJobs(
  input: GoogleJobsSearchInput,
  opts: SearchGoogleJobsOpts,
): AsyncIterable<GoogleJobsListing> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxPages ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 2000;

  let pageIdx = 0;
  let nextPageToken: string | null = null;

  while (pageIdx < maxPages) {
    if (opts.signal?.aborted) return;

    const url = new URL(SERPAPI_BASE);
    url.searchParams.set('engine', 'google_jobs');
    const phrase = input.date_posted ? DATE_POSTED_PHRASES[input.date_posted] : null;
    const q = phrase ? `${input.keywords} ${phrase}` : input.keywords;
    url.searchParams.set('q', q);
    if (input.location) url.searchParams.set('location', input.location);
    if (input.num) url.searchParams.set('num', String(input.num));
    if (nextPageToken) url.searchParams.set('next_page_token', nextPageToken);
    url.searchParams.set('api_key', opts.apiKey);

    const res = await fetchOnceWithRetry(fetchImpl, url, retryDelayMs, opts.signal);

    if (res.status === 403) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new SerpapiKeyInvalidError(
        typeof body?.error === 'string' ? body.error : `HTTP 403 at ${redactKey(url)}`,
      );
    }
    if (res.status === 429) throw new SerpapiQuotaExhaustedError();
    if (!res.ok) {
      throw new SerpapiTransientError(`HTTP ${res.status} at ${redactKey(url)}`);
    }

    const payload = (await res.json()) as {
      jobs_results?: RawJob[];
      serpapi_pagination?: { next_page_token?: string };
      error?: string;
    };

    if (payload.error) {
      const lower = payload.error.toLowerCase();
      if (lower.includes('invalid api key') || lower.includes('unauthorized')) {
        throw new SerpapiKeyInvalidError(payload.error);
      }
      if (lower.includes('limit') || lower.includes('exceeded')) {
        throw new SerpapiQuotaExhaustedError();
      }
      // SerpAPI surfaces "no results" via `error` rather than an empty
      // `jobs_results` array. Treat as a clean empty-result page: stop
      // pagination and return without throwing, so the handler reports
      // "0 listings added" instead of "search failed" + a retry storm.
      if (
        lower.includes("hasn't returned any results") ||
        lower.includes('no results') ||
        lower.includes("didn't return any results")
      ) {
        return;
      }
      throw new SerpapiTransientError(payload.error);
    }

    for (const raw of payload.jobs_results ?? []) {
      if (opts.signal?.aborted) return;
      const mapped = mapJobResult(raw);
      if (mapped) yield mapped;
    }

    nextPageToken = payload.serpapi_pagination?.next_page_token ?? null;
    if (!nextPageToken) return;
    pageIdx += 1;
  }
}

async function fetchOnceWithRetry(
  fetchImpl: typeof fetch,
  url: URL,
  retryDelayMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal });
  } catch (err) {
    // Surface aborts so the iterator can short-circuit. Anything else maps
    // to a synthetic 502 so the standard transient path handles it.
    if (err instanceof Error && err.name === 'AbortError') throw err;
    res = new Response('', { status: 502 });
  }
  if (res.status < 500) return res;
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, retryDelayMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
  try {
    return await fetchImpl(url, { signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return new Response('', { status: 502 });
  }
}
