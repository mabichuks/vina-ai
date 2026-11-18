import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { auth, buildTestApp, type TestAppHandle } from './helpers.js';

let handle: TestAppHandle;

beforeEach(async () => {
  handle = await buildTestApp();
});
afterEach(async () => {
  await handle.cleanup();
});

// The prompt registry is retired (#19): the service is a no-op and the route
// keeps a stable empty contract. These assertions pin that behaviour.
describe('prompt routes (retired)', () => {
  it('lists no prompts', async () => {
    const res = await handle.app.inject({
      method: 'GET',
      url: '/api/prompts',
      headers: auth(handle.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it('404s on a prompt detail', async () => {
    const res = await handle.app.inject({
      method: 'GET',
      url: '/api/prompts/score',
      headers: auth(handle.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE is a no-op 204', async () => {
    const del = await handle.app.inject({
      method: 'DELETE',
      url: '/api/prompts/score',
      headers: auth(handle.token),
    });
    expect(del.statusCode).toBe(204);
  });
});
