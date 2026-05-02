import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findSiteById, updateSiteEnabled } from '../../src/db/repositories/sites.js';
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

describe('settings routes', () => {
  it('GET response excludes the raw key, exposes has_serpapi_key', async () => {
    setSerpApiKey(h.db, 'serp-test');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: auth(h.token),
    });
    const body = res.json() as Record<string, unknown>;
    expect(body['has_serpapi_key']).toBe(true);
    expect(body).not.toHaveProperty('serpapi_key');
    expect(body).not.toHaveProperty('encrypted_serpapi_key');
  });

  it('PATCH unknown mode returns 400', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: auth(h.token),
      payload: { mode: 'manual' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH active_llm_provider_id with a nonexistent id returns 409', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: auth(h.token),
      payload: { active_llm_provider_id: '01NONEXISTENT' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('DELETE /serpapi-key clears the key and disables Google Jobs', async () => {
    setSerpApiKey(h.db, 'serp-test');
    updateSiteEnabled(h.db, 'google', true);

    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/settings/serpapi-key',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ has_serpapi_key: false });
    expect(findSiteById(h.db, 'google')?.enabled).toBe(false);
  });
});
