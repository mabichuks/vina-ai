import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, auth, type TestAppHandle } from './helpers.js';

let h: TestAppHandle;

beforeEach(async () => {
  h = await buildTestApp();
});
afterEach(() => h.cleanup());

describe('schedule routes', () => {
  it('rejects an invalid cron expression with 400 invalid_cron', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/schedules',
      headers: auth(h.token),
      payload: { cron_expression: 'totally not cron' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_cron' });
  });

  it('CRUD lifecycle: create, list (creation order), patch, delete', async () => {
    const a = (
      await h.app.inject({
        method: 'POST',
        url: '/api/schedules',
        headers: auth(h.token),
        payload: { cron_expression: '0 9 * * *' },
      })
    ).json() as { id: string };

    const b = (
      await h.app.inject({
        method: 'POST',
        url: '/api/schedules',
        headers: auth(h.token),
        payload: { cron_expression: '0 18 * * *' },
      })
    ).json() as { id: string };

    const list = (
      await h.app.inject({
        method: 'GET',
        url: '/api/schedules',
        headers: auth(h.token),
      })
    ).json() as { id: string }[];
    expect(list.map((s) => s.id)).toEqual([a.id, b.id]);

    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/schedules/${a.id}`,
      headers: auth(h.token),
      payload: { enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ enabled: false });

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/schedules/${b.id}`,
      headers: auth(h.token),
    });
    expect(del.statusCode).toBe(204);
  });
});
