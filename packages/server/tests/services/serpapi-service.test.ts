import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  validateSerpApiKey,
  searchGoogleJobs,
  SerpapiKeyInvalidError,
  SerpapiQuotaExhaustedError,
  SerpapiTransientError,
  type GoogleJobsListing,
} from '../../src/services/serpapi-service.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(impl: (url: string) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL) =>
      Promise.resolve(impl(typeof url === 'string' ? url : url.toString())),
    ),
  );
}

describe('validateSerpApiKey', () => {
  it('200 with no error → ok', async () => {
    let called = '';
    mockFetch((url) => {
      called = url;
      return new Response(JSON.stringify({ jobs_results: [] }), { status: 200 });
    });
    const result = await validateSerpApiKey('serp-good');
    expect(result.ok).toBe(true);
    expect(called).toContain('engine=google_jobs');
    expect(called).toContain('api_key=serp-good');
  });

  it('200 with body.error mentioning "Invalid API key" → auth_failed', async () => {
    mockFetch(() => new Response(JSON.stringify({ error: 'Invalid API key.' }), { status: 200 }));
    const result = await validateSerpApiKey('serp-bad');
    expect(result).toMatchObject({ ok: false, reason: 'auth_failed' });
  });

  it('429 → rate_limited', async () => {
    mockFetch(() => new Response('', { status: 429 }));
    const result = await validateSerpApiKey('serp-x');
    expect(result).toMatchObject({ ok: false, reason: 'rate_limited' });
  });

  it('empty key → auth_failed without hitting the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await validateSerpApiKey('')).toMatchObject({
      ok: false,
      reason: 'auth_failed',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// searchGoogleJobs
// ---------------------------------------------------------------------------

interface FakePage {
  jobs_results: Array<Record<string, unknown>>;
  serpapi_pagination?: { next_page_token?: string };
}

function fakeFetch(pages: Record<string, FakePage | { status: number; body?: unknown }>) {
  return async (input: URL | string): Promise<Response> => {
    const url = typeof input === 'string' ? new URL(input) : input;
    const token = url.searchParams.get('next_page_token') ?? 'page-1';
    const entry = pages[token];
    if (!entry) return new Response('{}', { status: 200 });
    if ('status' in entry) {
      return new Response(JSON.stringify(entry.body ?? {}), { status: entry.status });
    }
    return new Response(JSON.stringify(entry), { status: 200 });
  };
}

const job = (id: string) => ({
  job_id: id,
  title: `Engineer ${id}`,
  company_name: 'Acme',
  location: 'Remote',
  via: 'via Greenhouse',
  description: 'Build things.',
  detected_extensions: { salary: '$180K' },
  apply_options: [{ title: 'Apply on Greenhouse', link: `https://gh.io/${id}` }],
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe('searchGoogleJobs', () => {
  it('iterates across pages until next_page_token is absent', async () => {
    const fetchImpl = fakeFetch({
      'page-1': { jobs_results: [job('a'), job('b')], serpapi_pagination: { next_page_token: 'p2' } },
      p2: { jobs_results: [job('c')] },
    });
    const out = await collect(
      searchGoogleJobs(
        { keywords: 'typescript', location: 'Remote' },
        { apiKey: 'k', fetchImpl, maxPages: 5 },
      ),
    );
    expect(out.map((l) => l.external_id)).toEqual(['a', 'b', 'c']);
    expect(out[0]).toMatchObject({
      title: 'Engineer a',
      company: 'Acme',
      via: 'via Greenhouse',
      apply_url: 'https://gh.io/a',
    });
  });

  it('honours the soft maxPages cap', async () => {
    const fetchImpl = fakeFetch({
      'page-1': { jobs_results: [job('a')], serpapi_pagination: { next_page_token: 'p2' } },
      p2: { jobs_results: [job('b')], serpapi_pagination: { next_page_token: 'p3' } },
      p3: { jobs_results: [job('c')] },
    });
    const out = await collect(
      searchGoogleJobs({ keywords: 'x' }, { apiKey: 'k', fetchImpl, maxPages: 2 }),
    );
    expect(out.map((l) => l.external_id)).toEqual(['a', 'b']);
  });

  it('drops listings without apply_options[0].link', async () => {
    const bad = { ...job('z'), apply_options: [] };
    const fetchImpl = fakeFetch({ 'page-1': { jobs_results: [bad, job('y')] } });
    const out = await collect(
      searchGoogleJobs({ keywords: 'x' }, { apiKey: 'k', fetchImpl, maxPages: 1 }),
    );
    expect(out.map((l) => l.external_id)).toEqual(['y']);
  });

  it('throws SerpapiKeyInvalidError on 403', async () => {
    const fetchImpl = fakeFetch({ 'page-1': { status: 403, body: { error: 'Invalid API key' } } });
    await expect(
      collect(searchGoogleJobs({ keywords: 'x' }, { apiKey: 'k', fetchImpl })),
    ).rejects.toBeInstanceOf(SerpapiKeyInvalidError);
  });

  it('throws SerpapiQuotaExhaustedError on 429', async () => {
    const fetchImpl = fakeFetch({ 'page-1': { status: 429 } });
    await expect(
      collect(searchGoogleJobs({ keywords: 'x' }, { apiKey: 'k', fetchImpl })),
    ).rejects.toBeInstanceOf(SerpapiQuotaExhaustedError);
  });

  it('retries once on 5xx then succeeds', async () => {
    let n = 0;
    const fetchImpl = async (): Promise<Response> => {
      n += 1;
      if (n === 1) return new Response('', { status: 502 });
      return new Response(
        JSON.stringify({ jobs_results: [job('a')] }),
        { status: 200 },
      );
    };
    const out = await collect(
      searchGoogleJobs(
        { keywords: 'x' },
        { apiKey: 'k', fetchImpl, maxPages: 1, retryDelayMs: 1 },
      ),
    );
    expect(n).toBe(2);
    expect(out.map((l) => l.external_id)).toEqual(['a']);
  });

  it('throws SerpapiTransientError when 5xx persists after retry', async () => {
    let n = 0;
    const fetchImpl = async (): Promise<Response> => {
      n += 1;
      return new Response('', { status: 500 });
    };
    await expect(
      collect(
        searchGoogleJobs(
          { keywords: 'x' },
          { apiKey: 'k', fetchImpl, maxPages: 1, retryDelayMs: 1 },
        ),
      ),
    ).rejects.toBeInstanceOf(SerpapiTransientError);
    expect(n).toBe(2);
  });

  it('aborts mid-pagination when signal is triggered', async () => {
    const fetchImpl = fakeFetch({
      'page-1': { jobs_results: [job('a')], serpapi_pagination: { next_page_token: 'p2' } },
      p2: { jobs_results: [job('b')] },
    });
    const ac = new AbortController();
    const out: GoogleJobsListing[] = [];
    for await (const l of searchGoogleJobs(
      { keywords: 'x' },
      { apiKey: 'k', fetchImpl, maxPages: 5, signal: ac.signal },
    )) {
      out.push(l);
      ac.abort();
    }
    expect(out.map((l) => l.external_id)).toEqual(['a']);
  });
});
