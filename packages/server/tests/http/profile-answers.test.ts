import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertAnswer } from '../../src/db/repositories/profile-answers.js';
import { buildTestApp, auth, type TestAppHandle } from './helpers.js';

let h: TestAppHandle;

beforeEach(async () => {
  h = await buildTestApp();
});
afterEach(() => h.cleanup());

describe('profile-answers routes', () => {
  it('GET lists saved answers sorted by key', async () => {
    upsertAnswer(h.db, 'years_typescript', 'Years of TypeScript?', '5');
    upsertAnswer(h.db, 'work_authorisation_us', 'Work authorisation in US?', 'No');

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/profile-answers',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { answers: Array<{ key: string }> };
    expect(body.answers).toHaveLength(2);
    expect(body.answers[0]!.key).toBe('work_authorisation_us');
    expect(body.answers[1]!.key).toBe('years_typescript');
  });

  it('DELETE :key removes a single answer', async () => {
    upsertAnswer(h.db, 'years_typescript', 'Years of TypeScript?', '5');
    upsertAnswer(h.db, 'work_authorisation_us', 'Work authorisation in US?', 'No');

    const del = await h.app.inject({
      method: 'DELETE',
      url: '/api/profile-answers/years_typescript',
      headers: auth(h.token),
    });
    expect(del.statusCode).toBe(204);

    const after = await h.app.inject({
      method: 'GET',
      url: '/api/profile-answers',
      headers: auth(h.token),
    });
    const body = after.json() as { answers: Array<{ key: string }> };
    expect(body.answers).toHaveLength(1);
    expect(body.answers[0]!.key).toBe('work_authorisation_us');
  });

  it('DELETE clears every saved answer', async () => {
    upsertAnswer(h.db, 'a', 'A?', '1');
    upsertAnswer(h.db, 'b', 'B?', '2');

    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/profile-answers',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(204);

    const after = await h.app.inject({
      method: 'GET',
      url: '/api/profile-answers',
      headers: auth(h.token),
    });
    expect((after.json() as { answers: unknown[] }).answers).toHaveLength(0);
  });

  it('DELETE :key returns 404 when the key does not exist', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/profile-answers/no-such-key',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });
});
