import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { insertSchedule } from '../../src/db/repositories/schedules.js';
import { updateSiteEnabled } from '../../src/db/repositories/sites.js';
import { listPending } from '../../src/db/repositories/task-queue.js';
import { createEventBus } from '../../src/events/bus.js';
import { createScheduler } from '../../src/scheduler/scheduler.js';
import { freshTestDb } from '../db/helpers.js';

let db: DatabaseType;
beforeEach(() => {
  db = freshTestDb();
});
afterEach(() => db.close());

describe('scheduler', () => {
  it('on fire, enqueues a search task per enabled site and updates last/next_run_at', async () => {
    updateSiteEnabled(db, 'linkedin', true);
    updateSiteEnabled(db, 'indeed', true);
    // google stays disabled
    const schedule = insertSchedule(db, { cron_expression: '0 0 * * *' });

    const sched = createScheduler({ db, bus: createEventBus(), poke: () => undefined });
    // Synthetic fire — bypasses node-cron timing
    sched.fireNow(schedule.id);

    const pending = listPending(db);
    expect(pending.map((t) => t.kind)).toEqual(['search', 'search']);
    const sites = pending
      .map((t) => (JSON.parse(t.payload) as { site_id: string }).site_id)
      .sort();
    expect(sites).toEqual(['indeed', 'linkedin']);

    const refreshed = db
      .prepare(`SELECT last_run_at, next_run_at FROM schedules WHERE id = ?`)
      .get(schedule.id) as { last_run_at: string | null; next_run_at: string | null };
    expect(refreshed.last_run_at).toMatch(/^\d{4}-/);
    expect(refreshed.next_run_at).toMatch(/^\d{4}-/);
  });

  it('skips disabled schedules at boot', () => {
    insertSchedule(db, { cron_expression: '* * * * *', enabled: false });
    const sched = createScheduler({ db, bus: createEventBus(), poke: () => undefined });
    sched.start();
    expect(sched.activeJobCount()).toBe(0);
    sched.stop();
  });

  it('pokes the worker on fire so tasks run promptly', () => {
    updateSiteEnabled(db, 'linkedin', true);
    const schedule = insertSchedule(db, { cron_expression: '0 0 * * *' });

    const poke = vi.fn();
    const sched = createScheduler({ db, bus: createEventBus(), poke });
    sched.fireNow(schedule.id);

    expect(poke).toHaveBeenCalledTimes(1);
  });
});
