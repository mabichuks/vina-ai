import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listPending } from '../../src/db/repositories/task-queue.js';
import { auth, buildTestApp, type TestAppHandle } from './helpers.js';

let h: TestAppHandle;
beforeEach(async () => {
  h = await buildTestApp();
});
afterEach(async () => {
  await h.cleanup();
});

describe('POST /api/searches/run-now', () => {
  it('enqueues a search task with site_id=linkedin and no schedule_id', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/searches/run-now',
      headers: auth(h.token),
      payload: { site_id: 'linkedin' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { task_id: string; deduped: boolean };
    expect(body.task_id).toBeTruthy();
    expect(body.deduped).toBe(false);

    const task = listPending(h.db).find((t) => t.kind === 'search');
    expect(task).toBeDefined();
    const payload = JSON.parse(task!.payload) as { site_id: string; schedule_id?: string };
    expect(payload.site_id).toBe('linkedin');
    expect(payload.schedule_id).toBeUndefined();
  });

  it('returns the existing task id when one is already pending (idempotent)', async () => {
    const a = await h.app.inject({
      method: 'POST',
      url: '/api/searches/run-now',
      headers: auth(h.token),
      payload: { site_id: 'linkedin' },
    });
    const b = await h.app.inject({
      method: 'POST',
      url: '/api/searches/run-now',
      headers: auth(h.token),
      payload: { site_id: 'linkedin' },
    });
    expect(a.json().task_id).toBe(b.json().task_id);
    expect(b.json().deduped).toBe(true);
    expect(listPending(h.db).filter((t) => t.kind === 'search')).toHaveLength(1);
  });

  it('404s on unknown site', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/searches/run-now',
      headers: auth(h.token),
      payload: { site_id: 'nope' },
    });
    expect(res.statusCode).toBe(404);
  });
});
