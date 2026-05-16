import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listPending } from '../../src/db/repositories/task-queue.js';
import {
  registerActiveTask,
  _resetActiveTasksForTests,
} from '../../src/queue/active-tasks.js';
import { auth, buildTestApp, type TestAppHandle } from './helpers.js';

let h: TestAppHandle;
beforeEach(async () => {
  h = await buildTestApp();
  _resetActiveTasksForTests();
});
afterEach(async () => {
  _resetActiveTasksForTests();
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

  it('fast-forwards a backoff-waiting retry instead of dedup-ing as in-flight', async () => {
    // Simulate the worker's failure path: bump attempts and push next_attempt_at
    // into the future, so the row is "pending with backoff" — exactly what
    // the user's screenshot-stuck experience hits after a transient failure.
    const a = await h.app.inject({
      method: 'POST',
      url: '/api/searches/run-now',
      headers: auth(h.token),
      payload: { site_id: 'linkedin' },
    });
    const taskId = (a.json() as { task_id: string }).task_id;
    const future = new Date(Date.now() + 60_000).toISOString();
    h.db
      .prepare(`UPDATE task_queue SET attempts = 1, next_attempt_at = ? WHERE id = ?`)
      .run(future, taskId);

    const b = await h.app.inject({
      method: 'POST',
      url: '/api/searches/run-now',
      headers: auth(h.token),
      payload: { site_id: 'linkedin' },
    });
    const body = b.json() as { task_id: string; deduped: boolean; retried?: boolean };
    expect(body.task_id).toBe(taskId);
    expect(body.deduped).toBe(false);
    expect(body.retried).toBe(true);

    const row = h.db
      .prepare(`SELECT next_attempt_at FROM task_queue WHERE id = ?`)
      .get(taskId) as { next_attempt_at: string };
    expect(new Date(row.next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now() + 100);
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

describe('POST /api/searches/cancel', () => {
  it('cancels by task_id and aborts the registered signal', async () => {
    const signal = registerActiveTask('t-known', 'google');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/searches/cancel',
      headers: auth(h.token),
      payload: { task_id: 't-known' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cancelled: 1 });
    expect(signal.aborted).toBe(true);
  });

  it('cancels by site_id and aborts every signal on that site', async () => {
    const s1 = registerActiveTask('a', 'google');
    const s2 = registerActiveTask('b', 'google');
    const s3 = registerActiveTask('c', 'linkedin');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/searches/cancel',
      headers: auth(h.token),
      payload: { site_id: 'google' },
    });
    expect(res.json()).toEqual({ cancelled: 2 });
    expect(s1.aborted).toBe(true);
    expect(s2.aborted).toBe(true);
    expect(s3.aborted).toBe(false);
  });

  it('returns cancelled:0 when the task_id is unknown (200, not 404)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/searches/cancel',
      headers: auth(h.token),
      payload: { task_id: 'ghost' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cancelled: 0 });
  });

  it('prefers task_id when both are provided', async () => {
    const signal = registerActiveTask('only-this-one', 'google');
    const other = registerActiveTask('other', 'google');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/searches/cancel',
      headers: auth(h.token),
      payload: { task_id: 'only-this-one', site_id: 'google' },
    });
    expect(res.json()).toEqual({ cancelled: 1 });
    expect(signal.aborted).toBe(true);
    expect(other.aborted).toBe(false);
  });

  it('rejects requests with neither task_id nor site_id', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/searches/cancel',
      headers: auth(h.token),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
