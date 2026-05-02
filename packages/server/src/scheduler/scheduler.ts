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
    const enabledSites = listSites(options.db).filter((s) => s.enabled);
    if (enabledSites.length === 0) {
      log.info({ scheduleId }, 'no enabled sites; skipping fire');
    }
    for (const site of enabledSites) {
      enqueue(options.db, { kind: 'search', payload: { site_id: site.id } });
    }
    const now = new Date().toISOString();
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
      for (const [, task] of jobs) {
        void task.stop();
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
