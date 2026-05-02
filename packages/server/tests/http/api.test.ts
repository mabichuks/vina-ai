import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { insertCv } from '../../src/db/repositories/cvs.js';
import { insertLlmProvider } from '../../src/db/repositories/llm-providers.js';
import { insertProfile } from '../../src/db/repositories/profile.js';
import { updateSettings } from '../../src/db/repositories/settings.js';
import { updateSiteEnabled } from '../../src/db/repositories/sites.js';
import { buildTestApp, type TestAppHandle } from './helpers.js';

let handle: TestAppHandle;
let app: FastifyInstance;
let db: DatabaseType;
let token: string;

beforeEach(async () => {
  handle = await buildTestApp();
  app = handle.app;
  db = handle.db;
  token = handle.token;
});
afterEach(async () => {
  await handle.cleanup();
});

const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

describe('bearer auth', () => {
  it('lets /api/bootstrap through without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/bootstrap' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects protected routes without/with bad tokens and accepts the right one', async () => {
    const without = await app.inject({ method: 'GET', url: '/api/system/status' });
    expect(without.statusCode).toBe(401);
    expect(without.json()).toMatchObject({ code: 'auth_error' });

    const wrong = await app.inject({
      method: 'GET',
      url: '/api/system/status',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: 'auth_invalid' });

    const good = await app.inject({
      method: 'GET',
      url: '/api/system/status',
      headers: auth(),
    });
    expect(good.statusCode).toBe(200);
  });
});

describe('GET /api/bootstrap', () => {
  it('returns the bearer token and onboarded toggles only when every prerequisite exists', async () => {
    const fresh = (await app.inject({ method: 'GET', url: '/api/bootstrap' })).json() as {
      token: string;
      onboarded: boolean;
    };
    expect(fresh.token).toBe(token);
    expect(fresh.onboarded).toBe(false);

    insertProfile(db, { full_name: 'Ada', email: 'ada@x.com' });
    const provider = insertLlmProvider(db, { kind: 'anthropic', label: 'C', model: 'm' });
    insertCv(db, {
      label: 'A',
      original_filename: 'cv.pdf',
      mime_type: 'application/pdf',
      file_path: 'cv.pdf',
    });
    // Provider exists but isn't selected as active, and no site is enabled.
    let res = (await app.inject({ method: 'GET', url: '/api/bootstrap' })).json() as {
      onboarded: boolean;
    };
    expect(res.onboarded).toBe(false);

    updateSiteEnabled(db, 'linkedin', true);
    res = (await app.inject({ method: 'GET', url: '/api/bootstrap' })).json() as {
      onboarded: boolean;
    };
    // Still false — no active LLM provider yet.
    expect(res.onboarded).toBe(false);

    updateSettings(db, { active_llm_provider_id: provider.id });
    res = (await app.inject({ method: 'GET', url: '/api/bootstrap' })).json() as {
      onboarded: boolean;
    };
    expect(res.onboarded).toBe(true);
  });
});

describe('system routes', () => {
  it('GET /api/system/status returns the documented shape with all three sources', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/status',
      headers: auth(),
    });
    const body = res.json() as {
      version: string;
      started_at: string;
      sources: { id: string; kind: string }[];
    };
    expect(res.statusCode).toBe(200);
    expect(body.version).toBe('0.0.0-test');
    expect(new Date(body.started_at).getTime()).toBeLessThanOrEqual(Date.now());
    expect(body.sources.map((s) => s.id).sort()).toEqual(['google', 'indeed', 'linkedin']);
  });

  it('pause/resume flips settings.paused and shows in /status.scheduler.running', async () => {
    await app.inject({ method: 'POST', url: '/api/system/pause', headers: auth() });
    let status = (
      await app.inject({ method: 'GET', url: '/api/system/status', headers: auth() })
    ).json() as { scheduler: { running: boolean } };
    expect(status.scheduler.running).toBe(false);

    await app.inject({ method: 'POST', url: '/api/system/resume', headers: auth() });
    status = (
      await app.inject({ method: 'GET', url: '/api/system/status', headers: auth() })
    ).json() as { scheduler: { running: boolean } };
    expect(status.scheduler.running).toBe(true);
  });

  it('POST /api/system/reset requires confirm:"reset", preserves seeded sites, flips onboarded back', async () => {
    insertProfile(db, { full_name: 'Ada', email: 'a@b.com' });
    insertLlmProvider(db, { kind: 'anthropic', label: 'C', model: 'm' });
    insertCv(db, {
      label: 'A',
      original_filename: 'cv.pdf',
      mime_type: 'application/pdf',
      file_path: 'cv.pdf',
    });
    updateSiteEnabled(db, 'linkedin', true);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/system/reset',
      headers: auth(),
      payload: { confirm: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'validation_error' });

    const ok = await app.inject({
      method: 'POST',
      url: '/api/system/reset',
      headers: auth(),
      payload: { confirm: 'reset' },
    });
    expect(ok.statusCode).toBe(200);

    const sitesCount = (db.prepare(`SELECT COUNT(*) AS n FROM sites`).get() as { n: number }).n;
    expect(sitesCount).toBe(3);

    const after = (await app.inject({ method: 'GET', url: '/api/bootstrap' })).json() as {
      onboarded: boolean;
    };
    expect(after.onboarded).toBe(false);
  });
});
