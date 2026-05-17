import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSerpApiKey } from '../../src/services/settings-service.js';
import { buildTestApp, auth, type TestAppHandle } from './helpers.js';
import * as serpapiService from '../../src/services/serpapi-service.js';

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

describe('GET /api/sites — has_credentials', () => {
  it('reports has_credentials=false for the linkedin row when no session is on disk', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/sites',
      headers: auth(h.token),
    });
    const sites = res.json() as Array<{ id: string; has_credentials: boolean; kind: string }>;
    const linkedin = sites.find((s) => s.id === 'linkedin')!;
    expect(linkedin.kind).toBe('browser');
    expect(linkedin.has_credentials).toBe(false);
  });

  it('reports has_credentials=false for the google row when no SerpAPI key is stored', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/sites',
      headers: auth(h.token),
    });
    const sites = res.json() as Array<{ id: string; has_credentials: boolean }>;
    const google = sites.find((s) => s.id === 'google')!;
    expect(google.has_credentials).toBe(false);
  });

  it('flips google.has_credentials to true after the SerpAPI key is stored', async () => {
    vi.spyOn(serpapiService, 'validateSerpApiKey').mockResolvedValue({ ok: true, latency_ms: 1 });
    await h.app.inject({
      method: 'POST',
      url: '/api/sites/google/test',
      headers: auth(h.token),
      payload: { key: 'live-key' },
    });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/sites',
      headers: auth(h.token),
    });
    const sites = res.json() as Array<{ id: string; has_credentials: boolean }>;
    const google = sites.find((s) => s.id === 'google')!;
    expect(google.has_credentials).toBe(true);
  });

  it('flips linkedin.has_credentials to true after the login stub seeds session_path', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/sites/linkedin/login',
      headers: auth(h.token),
    });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/sites',
      headers: auth(h.token),
    });
    const sites = res.json() as Array<{ id: string; has_credentials: boolean }>;
    const linkedin = sites.find((s) => s.id === 'linkedin')!;
    expect(linkedin.has_credentials).toBe(true);
  });
});

describe('LinkedIn connect endpoints', () => {
  it('GET /api/sites/linkedin/status returns the initial state', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/sites/linkedin/status',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      connected: false,
      attempting: false,
      last_success_at: null,
    });
  });

  it('DELETE /api/sites/linkedin/connect cancels and returns 204', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/sites/linkedin/connect',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(204);
  });

  it('DELETE /api/sites/linkedin disconnects and returns 204', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/sites/linkedin',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(204);
  });
});
