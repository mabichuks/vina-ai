import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertAlert } from '../../src/db/repositories/alerts.js';
import { auth, buildTestApp, type TestAppHandle } from './helpers.js';

let h: TestAppHandle;
beforeEach(async () => {
  h = await buildTestApp();
});
afterEach(async () => {
  await h.cleanup();
});

describe('alerts routes', () => {
  it('GET /api/alerts returns open alerts by default', async () => {
    insertAlert(h.db, {
      kind: 'linkedin_session_expired',
      severity: 'action_required',
      title: 't',
      description: 'd',
    });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/alerts',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
  });

  it('POST /api/alerts/:id/resolve flips status to resolved', async () => {
    const a = insertAlert(h.db, {
      kind: 'general',
      severity: 'info',
      title: 't',
      description: 'd',
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/alerts/${a.id}/resolve`,
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('resolved');
  });

  it('POST /api/alerts/:id/dismiss flips status to dismissed', async () => {
    const a = insertAlert(h.db, {
      kind: 'general',
      severity: 'info',
      title: 't',
      description: 'd',
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/alerts/${a.id}/dismiss`,
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('dismissed');
  });

  it('404s on missing alert id', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/alerts/missing/resolve',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /api/alerts/resolved removes resolved alerts and leaves open ones', async () => {
    const a = insertAlert(h.db, {
      kind: 'general',
      severity: 'info',
      title: 'resolved-1',
      description: 'd',
    });
    insertAlert(h.db, {
      kind: 'general',
      severity: 'info',
      title: 'open-1',
      description: 'd',
    });
    // Resolve the first one.
    await h.app.inject({
      method: 'POST',
      url: `/api/alerts/${a.id}/resolve`,
      headers: auth(h.token),
    });

    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/alerts/resolved',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(204);

    const remaining = h.db
      .prepare(`SELECT title, status FROM alerts ORDER BY title`)
      .all() as Array<{ title: string; status: string }>;
    expect(remaining).toEqual([{ title: 'open-1', status: 'open' }]);
  });
});
