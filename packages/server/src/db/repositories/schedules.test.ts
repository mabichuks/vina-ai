import { describe, expect, it } from 'vitest';
import { NotFoundError } from '@vina/shared';
import { freshTestDb } from '../test-helpers.js';
import {
  deleteSchedule,
  findScheduleById,
  insertSchedule,
  listSchedules,
  updateSchedule,
} from './schedules.js';

describe('schedules repository', () => {
  it('insert + find + list', () => {
    const db = freshTestDb();
    const a = insertSchedule(db, { cron_expression: '0 9 * * *' });
    expect(a.enabled).toBe(true);
    expect(findScheduleById(db, a.id)).toEqual(a);
    expect(listSchedules(db)).toHaveLength(1);
    db.close();
  });

  it('update changes specified fields and leaves others alone', () => {
    const db = freshTestDb();
    const s = insertSchedule(db, { cron_expression: '0 9 * * *' });
    const updated = updateSchedule(db, s.id, {
      enabled: false,
      next_run_at: '2026-04-29T09:00:00Z',
    });
    expect(updated.enabled).toBe(false);
    expect(updated.cron_expression).toBe('0 9 * * *');
    expect(updated.next_run_at).toBe('2026-04-29T09:00:00Z');
    db.close();
  });

  it('delete removes the row', () => {
    const db = freshTestDb();
    const s = insertSchedule(db, { cron_expression: '0 9 * * *' });
    deleteSchedule(db, s.id);
    expect(findScheduleById(db, s.id)).toBeNull();
    db.close();
  });

  it('update of missing id throws NotFoundError', () => {
    const db = freshTestDb();
    expect(() => updateSchedule(db, 'absent', { enabled: true })).toThrow(NotFoundError);
    db.close();
  });
});
