import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { auth, buildTestApp, type TestAppHandle } from './helpers.js';

let handle: TestAppHandle;

beforeEach(async () => {
  handle = await buildTestApp();
});
afterEach(async () => {
  await handle.cleanup();
});

describe('GET /api/skills', () => {
  it('lists the packaged browser-apply skill', async () => {
    const res = await handle.app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: auth(handle.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ id: string; source: string; editable_by_user: boolean }>;
    };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain('browser-apply');
    const browserApply = body.items.find((i) => i.id === 'browser-apply')!;
    expect(browserApply.source).toBe('default');
    expect(browserApply.editable_by_user).toBe(false);
  });
});

describe('GET /api/skills/:id', () => {
  it('returns the full body for an existing skill', async () => {
    const res = await handle.app.inject({
      method: 'GET',
      url: '/api/skills/browser-apply',
      headers: auth(handle.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; body: string };
    expect(body.id).toBe('browser-apply');
    expect(body.body).toMatch(/Interaction model/i);
  });
});

describe('POST /api/skills/:id — guardrails', () => {
  const newUserSkill = (id: string): string =>
    [
      '---',
      `id: ${id}`,
      `name: My ${id}`,
      `description: User-authored skill for testing.`,
      'applies_to: [apply]',
      'capabilities: [snapshot, createAlert]',
      'editable_by_user: true',
      'version: 1',
      '---',
      '',
      'How I want this skill to behave.',
    ].join('\n');

  it('creates a brand-new user-authored skill', async () => {
    const res = await handle.app.inject({
      method: 'POST',
      url: '/api/skills/my-skill',
      headers: { ...auth(handle.token), 'content-type': 'application/json' },
      payload: { body: newUserSkill('my-skill') },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; source: string };
    expect(body.id).toBe('my-skill');
    expect(body.source).toBe('user');
  });

  it('refuses to overwrite a locked safety skill (browser-apply)', async () => {
    const res = await handle.app.inject({
      method: 'POST',
      url: '/api/skills/browser-apply',
      headers: { ...auth(handle.token), 'content-type': 'application/json' },
      payload: { body: newUserSkill('browser-apply') },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/safety-critical|cannot be overwritten/i);
  });

  it('strips and rejects disallowed capabilities', async () => {
    const bodyText = [
      '---',
      'id: bad-cap',
      'name: Bad capability',
      'description: tries to declare a disallowed capability',
      'applies_to: [apply]',
      'capabilities: [snapshot, evilRootAccess]',
      'editable_by_user: true',
      'version: 1',
      '---',
      '',
      'body',
    ].join('\n');
    const res = await handle.app.inject({
      method: 'POST',
      url: '/api/skills/bad-cap',
      headers: { ...auth(handle.token), 'content-type': 'application/json' },
      payload: { body: bodyText },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/disallowed capabilities.*evilRootAccess/);
  });

  it('rejects an attempt to create an editable_by_user=false skill', async () => {
    const bodyText = [
      '---',
      'id: lock-attempt',
      'name: Lock attempt',
      'description: tries to ship as read-only via the API',
      'applies_to: [apply]',
      'editable_by_user: false',
      'version: 1',
      '---',
      '',
      'body',
    ].join('\n');
    const res = await handle.app.inject({
      method: 'POST',
      url: '/api/skills/lock-attempt',
      headers: { ...auth(handle.token), 'content-type': 'application/json' },
      payload: { body: bodyText },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a body that mismatches the path id', async () => {
    const res = await handle.app.inject({
      method: 'POST',
      url: '/api/skills/path-id',
      headers: { ...auth(handle.token), 'content-type': 'application/json' },
      payload: { body: newUserSkill('different-id') },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/does not match path/);
  });

  it('caps body size', async () => {
    const huge = 'x'.repeat(20_000);
    const bodyText = [
      '---',
      'id: huge',
      'name: Huge',
      'description: large body',
      'applies_to: [apply]',
      'editable_by_user: true',
      'version: 1',
      '---',
      '',
      huge,
    ].join('\n');
    const res = await handle.app.inject({
      method: 'POST',
      url: '/api/skills/huge',
      headers: { ...auth(handle.token), 'content-type': 'application/json' },
      payload: { body: bodyText },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/character cap/);
  });
});

describe('PUT then DELETE round-trip on a user skill', () => {
  it('writes, reads, then deletes a user skill', async () => {
    const skillBody = [
      '---',
      'id: scratch',
      'name: Scratch',
      'description: temp',
      'editable_by_user: true',
      'version: 1',
      '---',
      '',
      'first body',
    ].join('\n');

    await handle.app.inject({
      method: 'PUT',
      url: '/api/skills/scratch',
      headers: { ...auth(handle.token), 'content-type': 'application/json' },
      payload: { body: skillBody },
    });

    const get = await handle.app.inject({
      method: 'GET',
      url: '/api/skills/scratch',
      headers: auth(handle.token),
    });
    const fetched = get.json() as { source: string; body: string };
    expect(fetched.source).toBe('user');
    expect(fetched.body).toBe('first body');

    const del = await handle.app.inject({
      method: 'DELETE',
      url: '/api/skills/scratch',
      headers: auth(handle.token),
    });
    expect(del.statusCode).toBe(204);

    const after = await handle.app.inject({
      method: 'GET',
      url: '/api/skills/scratch',
      headers: auth(handle.token),
    });
    expect(after.statusCode).toBe(404);
  });

  it('refuses to DELETE a locked safety skill', async () => {
    const res = await handle.app.inject({
      method: 'DELETE',
      url: '/api/skills/browser-apply',
      headers: auth(handle.token),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/safety-critical|cannot be removed/i);
  });
});
