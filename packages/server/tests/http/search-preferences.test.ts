import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, auth, type TestAppHandle } from './helpers.js';

let h: TestAppHandle;

beforeEach(async () => {
  h = await buildTestApp();
});
afterEach(() => h.cleanup());

describe('search-preferences routes', () => {
  it('GET creates a default row when missing; PUT replaces it', async () => {
    const initial = await h.app.inject({
      method: 'GET',
      url: '/api/search-preferences',
      headers: auth(h.token),
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ id: 'default', score_threshold: 70 });

    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/search-preferences',
      headers: auth(h.token),
      payload: { keywords: ['typescript'], score_threshold: 85 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ keywords: ['typescript'], score_threshold: 85 });
  });
});
