import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateSettings } from '../../src/db/repositories/settings.js';
import { createProvider } from '../../src/services/llm-service.js';
import { buildTestApp, auth, type TestAppHandle } from './helpers.js';

let h: TestAppHandle;

beforeEach(async () => {
  h = await buildTestApp();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await h.cleanup();
});

function mockFetch(impl: (url: string) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL) =>
      Promise.resolve(impl(typeof url === 'string' ? url : url.toString())),
    ),
  );
}

describe('llm-provider routes', () => {
  it('POST validates the key and returns the provider WITHOUT the api_key', async () => {
    mockFetch(() => new Response('{}', { status: 200 }));

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/llm-providers',
      headers: auth(h.token),
      payload: {
        kind: 'anthropic',
        label: 'Claude',
        model: 'claude-opus-4-7',
        api_key: 'sk-ant-good',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['has_api_key']).toBe(true);
    expect(body).not.toHaveProperty('api_key');
    expect(body).not.toHaveProperty('encrypted_api_key');
  });

  it('POST with an invalid key returns 400 provider_invalid', async () => {
    mockFetch(() => new Response('', { status: 401 }));
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/llm-providers',
      headers: auth(h.token),
      payload: {
        kind: 'anthropic',
        label: 'Claude',
        model: 'claude-opus-4-7',
        api_key: 'sk-ant-bad',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'provider_invalid' });
  });

  it('DELETE the active provider returns 409', async () => {
    const provider = createProvider(h.db, {
      kind: 'anthropic',
      label: 'C',
      model: 'm',
      api_key: 'k',
    });
    updateSettings(h.db, { active_llm_provider_id: provider.id });

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/llm-providers/${provider.id}`,
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST /:id/test echoes back validateProvider result', async () => {
    mockFetch(() => new Response('{}', { status: 200 }));
    const provider = createProvider(h.db, {
      kind: 'anthropic',
      label: 'C',
      model: 'm',
      api_key: 'sk-ant-test',
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/llm-providers/${provider.id}/test`,
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });
});
