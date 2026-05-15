import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, auth, type TestAppHandle } from './helpers.js';
import * as serpapiService from '../../src/services/serpapi-service.js';
import { hasSerpApiKey } from '../../src/services/settings-service.js';
import { findSiteById } from '../../src/db/repositories/sites.js';

let h: TestAppHandle;

beforeEach(async () => {
  h = await buildTestApp();
});
afterEach(async () => {
  await h.cleanup();
  vi.restoreAllMocks();
});

describe('POST /api/sites/google/test', () => {
  it('with a body key, validates and persists on success and enables the site', async () => {
    vi.spyOn(serpapiService, 'validateSerpApiKey').mockResolvedValue({ ok: true, latency_ms: 42 });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/sites/google/test',
      headers: auth(h.token),
      payload: { key: 'live-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(hasSerpApiKey(h.db)).toBe(true);
    expect(findSiteById(h.db, 'google')?.enabled).toBe(true);
  });

  it('with a body key, returns ok:false and does NOT persist on failure', async () => {
    vi.spyOn(serpapiService, 'validateSerpApiKey').mockResolvedValue({
      ok: false,
      reason: 'auth_failed',
    });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/sites/google/test',
      headers: auth(h.token),
      payload: { key: 'bad' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'auth_failed' });
    expect(hasSerpApiKey(h.db)).toBe(false);
    expect(findSiteById(h.db, 'google')?.enabled).toBe(false);
  });

  it('with no body key and no stored key, returns no_key_configured', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/sites/google/test',
      headers: auth(h.token),
      payload: {},
    });
    expect(res.json()).toMatchObject({ ok: false, reason: 'no_key_configured' });
  });
});
