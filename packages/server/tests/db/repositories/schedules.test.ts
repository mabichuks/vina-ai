import { describe, expect, it } from 'vitest';
import { NotFoundError } from '@vina/shared';
import {
  deleteSchedule,
  findScheduleById,
  insertSchedule,
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
