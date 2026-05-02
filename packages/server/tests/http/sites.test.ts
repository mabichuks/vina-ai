import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSerpApiKey } from '../../src/services/settings-service.js';
import { buildTestApp, auth, type TestAppHandle } from './helpers.js';

let h: TestAppHandle;

beforeEach(async () => {
  h = await buildTestApp();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await h.cleanup();
});

describe('sites routes', () => {
  it('GET returns all three seeded sites with the public shape', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/sites',
      headers: auth(h.token),
    });
    const body = res.json() as { id: string; kind: string; has_session: boolean }[];
    expect(body.map((s) => s.id).sort()).toEqual(['google', 'indeed', 'linkedin']);
    expect(body[0]).toHaveProperty('has_session');
  });

  it('PATCH google enabled without a SerpAPI key returns 409', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/sites/google',
      headers: auth(h.token),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST /linkedin/login returns pending; /google/login returns 405', async () => {
    const linkedin = await h.app.inject({
      method: 'POST',
      url: '/api/sites/linkedin/login',
      headers: auth(h.token),
    });
    expect(linkedin.statusCode).toBe(200);
    expect(linkedin.json()).toMatchObject({ status: 'pending' });

    const google = await h.app.inject({
      method: 'POST',
      url: '/api/sites/google/login',
      headers: auth(h.token),
    });
    expect(google.statusCode).toBe(405);
  });

  it('POST /google/test with no key returns no_key_configured (not a network call)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/sites/google/test',
      headers: auth(h.token),
    });
    expect(res.json()).toMatchObject({ ok: false, reason: 'no_key_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POST /google/test with a configured key calls SerpAPI', async () => {
    setSerpApiKey(h.db, 'serp-good');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ jobs_results: [] }), { status: 200 })),
      ),
    );
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/sites/google/test',
      headers: auth(h.token),
    });
    expect(res.json()).toMatchObject({ ok: true });
  });
});
