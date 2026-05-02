import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateSerpApiKey } from '../../src/services/serpapi-service.js';

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
