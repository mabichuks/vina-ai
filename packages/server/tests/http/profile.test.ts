import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, auth, type TestAppHandle } from './helpers.js';

let h: TestAppHandle;

beforeEach(async () => {
  h = await buildTestApp();
});
afterEach(() => h.cleanup());

describe('profile routes', () => {
  it('GET returns 404 on a fresh DB', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/profile',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });

  it('POST creates the profile and GET returns it; PATCH updates', async () => {
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/profile',
      headers: auth(h.token),
      payload: { full_name: 'Ada', email: 'ada@example.com' },
    });
    expect(create.statusCode).toBe(200);

    const get = await h.app.inject({
      method: 'GET',
      url: '/api/profile',
      headers: auth(h.token),
    });
    expect(get.json()).toMatchObject({ full_name: 'Ada', email: 'ada@example.com' });

    const patch = await h.app.inject({
      method: 'PATCH',
      url: '/api/profile',
      headers: auth(h.token),
      payload: { phone: '+44 7700 900000' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ phone: '+44 7700 900000', full_name: 'Ada' });
  });

  it('POST rejects an invalid email with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/profile',
      headers: auth(h.token),
      payload: { full_name: 'X', email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_error' });
  });
});
