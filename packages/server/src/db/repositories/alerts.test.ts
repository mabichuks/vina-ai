import { describe, expect, it } from 'vitest';
import { NotFoundError } from '@vina/shared';
import { freshTestDb } from '../test-helpers.js';
import { dismissAlert, findAlertById, insertAlert, listAlerts, resolveAlert } from './alerts.js';

describe('alerts repository', () => {
  it('insert + list + filter by status', () => {
    const db = freshTestDb();
    const a = insertAlert(db, {
      kind: 'general',
      severity: 'info',
      title: 'Heads up',
      description: '',
    });
    expect(findAlertById(db, a.id)).toEqual(a);
    expect(listAlerts(db, { status: 'open' })).toHaveLength(1);
    db.close();
  });

  it('serialises object payloads to JSON', () => {
    const db = freshTestDb();
    const a = insertAlert(db, {
      kind: 'missing_field',
      severity: 'action_required',
      title: 'Need years_of_experience',
      description: 'q',
      payload: { field: 'years_of_experience' },
    });
    expect(a.payload).toBe('{"field":"years_of_experience"}');
    db.close();
  });

  it('resolveAlert is idempotent', () => {
    const db = freshTestDb();
    const a = insertAlert(db, {
      kind: 'general',
      severity: 'info',
      title: 'x',
      description: '',
    });
    const first = resolveAlert(db, a.id, '5 years');
    expect(first.status).toBe('resolved');
    expect(first.resolution_value).toBe('5 years');
    expect(first.resolved_at).not.toBeNull();

    const second = resolveAlert(db, a.id, 'IGNORED');
    // Idempotent: returns the same row, NOT updated to 'IGNORED'.
    expect(second.resolution_value).toBe('5 years');
    expect(second.resolved_at).toBe(first.resolved_at);
    db.close();
  });

  it('dismissAlert is idempotent', () => {
    const db = freshTestDb();
    const a = insertAlert(db, {
      kind: 'general',
      severity: 'info',
      title: 'x',
      description: '',
    });
    const first = dismissAlert(db, a.id);
    expect(first.status).toBe('dismissed');
    const second = dismissAlert(db, a.id);
    expect(second.resolved_at).toBe(first.resolved_at);
    db.close();
  });

  it('resolve/dismiss on missing id throws NotFoundError', () => {
    const db = freshTestDb();
    expect(() => resolveAlert(db, 'absent')).toThrow(NotFoundError);
    expect(() => dismissAlert(db, 'absent')).toThrow(NotFoundError);
    db.close();
  });
});
