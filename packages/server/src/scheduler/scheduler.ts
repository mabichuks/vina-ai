import cron, { type ScheduledTask } from 'node-cron';
import type { Database as DatabaseType } from 'better-sqlite3';
import { createLogger } from '@vina/shared';
import {
  findScheduleById,
  listSchedules,
  updateSchedule,
} from '../db/repositories/schedules.js';
import { listSites } from '../db/repositories/sites.js';
import { enqueue } from '../db/repositories/task-queue.js';
import type { EventBus } from '../events/bus.js';
import { nextRunAt } from './cron.js';

const log = createLogger('scheduler');

/*
 * M10 deferral: schedule changes via POST/PATCH/DELETE only take effect on
 * the next daemon restart. `start()` reads the schedules table once and
 * registers every enabled row with node-cron; subsequent inserts/updates
 * are NOT reflected in the running scheduler. Live refresh is tracked as a
 * follow-up — likely a `subscribeToScheduleChanges(db, scheduler)` module
 * that re-registers per row.
 */

export interface SchedulerOptions {
  db: DatabaseType;
  bus: EventBus;
  /** Called after enqueuing tasks so the worker wakes immediately. */
  poke: () => void;
}

export interface SchedulerHandle {
  start(): void;
  stop(): void;
  /** Test seam — synthesise a fire without waiting for cron to tick. */
  fireNow(scheduleId: string): void;
  /** Test/inspection helper — count of active node-cron jobs. */
  activeJobCount(): number;
}

export function createScheduler(options: SchedulerOptions): SchedulerHandle {
  const jobs = new Map<string, ScheduledTask>();

  function fire(scheduleId: string): void {
    const schedule = findScheduleById(options.db, scheduleId);
    if (!schedule) {
      log.warn({ scheduleId }, 'fire on missing schedule');
      return;
    }
    if (schedule.paused) {
      log.info({ scheduleId }, 'schedule paused; skipping fire');
      return;
    }
    const enabledSites = listSites(options.db).filter((s) => s.enabled);
    const now = new Date().toISOString();
    if (enabledSites.length === 0) {
      // The cron tick still happened — record it so the UI reflects reality —
      // but skip the poke since nothing was enqueued for the worker to do.
      log.info({ scheduleId }, 'no enabled sites; skipping fire');
      updateSchedule(options.db, scheduleId, {
        last_run_at: now,
        next_run_at: nextRunAt(schedule.cron_expression, new Date(now)),
      });
      return;
    }
    for (const site of enabledSites) {
      enqueue(options.db, {
        kind: 'search',
        payload: { site_id: site.id, schedule_id: scheduleId },
      });
    }
    updateSchedule(options.db, scheduleId, {
      last_run_at: now,
      next_run_at: nextRunAt(schedule.cron_expression, new Date(now)),
    });
    // Worker emits real queue:updated counts after its next tick;
    // poke() makes that tick imminent rather than waiting for the poll cadence.
    options.poke();
  }

  return {
    start(): void {
      for (const schedule of listSchedules(options.db)) {
        if (!schedule.enabled) continue;
        if (!cron.validate(schedule.cron_expression)) {
          log.error({ scheduleId: schedule.id, expr: schedule.cron_expression }, 'invalid cron');
          continue;
        }
        const task = cron.schedule(schedule.cron_expression, () => fire(schedule.id));
        jobs.set(schedule.id, task);
        log.info({ scheduleId: schedule.id, expr: schedule.cron_expression }, 'registered cron');
      }
    },
    stop(): void {
      // node-cron@4 types `task.stop()` as `void | Promise<void>` — sync in
      // some paths, async in others. `Promise.resolve` normalises both so
      // we can attach a single rejection handler. Daemon shutdown does not
      // await these — they fire-and-log so cleanup races stay visible in
      // logs without blocking the rest of the shutdown sequence.
      for (const [scheduleId, task] of jobs) {
        Promise.resolve(task.stop()).catch((err: unknown) =>
          log.warn({ err, scheduleId }, 'cron stop rejected'),
        );
      }
      jobs.clear();
    },
    fireNow(scheduleId: string): void {
      fire(scheduleId);
    },
    activeJobCount(): number {
      return jobs.size;
    },
  };
}
