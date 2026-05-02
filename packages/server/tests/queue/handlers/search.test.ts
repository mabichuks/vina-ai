import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { listJobs } from '../../../src/db/repositories/jobs.js';
import { listPending } from '../../../src/db/repositories/task-queue.js';
import { createEventBus } from '../../../src/events/bus.js';
import { createSearchHandler } from '../../../src/queue/handlers/search.js';
import { freshTestDb } from '../../db/helpers.js';

let db: DatabaseType;
beforeEach(() => {
  db = freshTestDb();
});
afterEach(() => {
  db.close();
});

describe('search handler (M10 stub)', () => {
  it('inserts a synthetic job for the requested site and enqueues a score task', async () => {
    const bus = createEventBus();
    const handler = createSearchHandler({ db, bus });

    await handler({ site_id: 'linkedin' });

    const jobs = listJobs(db, { site_id: 'linkedin' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      site_id: 'linkedin',
      apply_method: 'auto',
      status: 'new',
    });

    const pending = listPending(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe('score');
    expect(JSON.parse(pending[0]!.payload)).toEqual({ job_id: jobs[0]!.id });
  });

  it('rejects unknown site ids', async () => {
    const handler = createSearchHandler({ db, bus: createEventBus() });
    await expect(handler({ site_id: 'unknown' })).rejects.toThrow(/site/i);
  });
});
