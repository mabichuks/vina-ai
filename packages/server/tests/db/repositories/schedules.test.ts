import { describe, expect, it } from 'vitest';
import { NotFoundError } from '@vina/shared';
import {
  deleteSchedule,
  findScheduleById,
  incrementScheduleFailures,
  insertSchedule,
  resetScheduleFailures,
  setSchedulePaused,
  updateSchedule,
} from '../../../src/db/repositories/schedules.js';
import { freshTestDb } from '../helpers.js';

describe('schedules repository', () => {
  it('CRUD over a row', () => {
    const db = freshTestDb();
    const s = insertSchedule(db, { cron_expression: '0 9 * * *' });
    expect(s.enabled).toBe(true);

    const updated = updateSchedule(db, s.id, {
      enabled: false,
      next_run_at: '2026-04-29T09:00:00Z',
    });
    expect(updated.enabled).toBe(false);
    expect(updated.cron_expression).toBe('0 9 * * *');

    deleteSchedule(db, s.id);
    expect(findScheduleById(db, s.id)).toBeNull();
    db.close();
  });

  it('update on missing id throws NotFoundError', () => {
    const db = freshTestDb();
    expect(() => updateSchedule(db, 'absent', { enabled: true })).toThrow(NotFoundError);
    db.close();
  });
});

describe('schedule failure tracking helpers', () => {
  it('initialises consecutive_failures to 0 and paused to false', () => {
    const db = freshTestDb();
    const s = insertSchedule(db, { cron_expression: '*/15 * * * *' });
    const fresh = findScheduleById(db, s.id)!;
    expect(fresh.consecutive_failures).toBe(0);
    expect(fresh.paused).toBe(false);
    db.close();
  });

  it('increments and resets consecutive_failures', () => {
    const db = freshTestDb();
    const s = insertSchedule(db, { cron_expression: '*/15 * * * *' });
    incrementScheduleFailures(db, s.id);
    incrementScheduleFailures(db, s.id);
    expect(findScheduleById(db, s.id)?.consecutive_failures).toBe(2);
    resetScheduleFailures(db, s.id);
    expect(findScheduleById(db, s.id)?.consecutive_failures).toBe(0);
    db.close();
  });

  it('flips paused via setSchedulePaused', () => {
    const db = freshTestDb();
    const s = insertSchedule(db, { cron_expression: '*/15 * * * *' });
    setSchedulePaused(db, s.id, true);
    expect(findScheduleById(db, s.id)?.paused).toBe(true);
    setSchedulePaused(db, s.id, false);
    expect(findScheduleById(db, s.id)?.paused).toBe(false);
    db.close();
  });
});
