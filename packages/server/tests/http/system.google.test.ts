import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppHandle } from './helpers.js';
import { setSerpApiKey } from '../../src/services/settings-service.js';
import { updateSiteEnabled, updateSiteSession } from '../../src/db/repositories/sites.js';
import { insertAlert } from '../../src/db/repositories/alerts.js';

let handle: TestAppHandle;
beforeEach(async () => {
  handle = await buildTestApp();
});
afterEach(async () => {
  await handle.cleanup();
});

const auth = (): { authorization: string } => ({
  authorization: `Bearer ${handle.token}`,
});

describe('GET /api/system/status — google fields', () => {
  it('returns not_configured by default', async () => {
    const res = await handle.app.inject({
      method: 'GET',
      url: '/api/system/status',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ google_state: 'not_configured', google_last_search_at: null });
  });

  it('returns connected when key is set, enabled, and last_search_at present', async () => {
    setSerpApiKey(handle.db, 'k');
    updateSiteEnabled(handle.db, 'google', true);
    updateSiteSession(handle.db, 'google', { last_search_at: '2026-05-13T10:00:00Z' });
    const res = await handle.app.inject({
      method: 'GET',
      url: '/api/system/status',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      google_state: 'connected',
      google_last_search_at: '2026-05-13T10:00:00Z',
    });
  });

  it('returns key_invalid when an open serpapi_key_invalid alert exists', async () => {
    setSerpApiKey(handle.db, 'k');
    updateSiteEnabled(handle.db, 'google', true);
    insertAlert(handle.db, {
      kind: 'serpapi_key_invalid',
      severity: 'action_required',
      title: 'x',
      description: 'y',
      site_id: 'google',
    });
    const res = await handle.app.inject({
      method: 'GET',
      url: '/api/system/status',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ google_state: 'key_invalid' });
  });
});
