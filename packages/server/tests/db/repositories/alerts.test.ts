import { describe, expect, it } from 'vitest';
import { NotFoundError } from '@vina/shared';
import { dismissAlert, insertAlert, resolveAlert } from '../../../src/db/repositories/alerts.js';
import { freshTestDb } from '../helpers.js';

describe('alerts repository', () => {
  it('insertAlert serialises object payloads', () => {
    const db = freshTestDb();
    const a = insertAlert(db, {
      kind: 'missing_field',
      severity: 'action_required',
      title: 'Need years_of_experience',
      description: '',
      payload: { field: 'years_of_experience' },
    });
    expect(a.payload).toBe('{"field":"years_of_experience"}');
    db.close();
  });

  it('resolve and dismiss are both idempotent', () => {
    const db = freshTestDb();
    const a = insertAlert(db, {
      kind: 'general',
      severity: 'info',
      title: 'x',
      description: '',
    });

    const resolved = resolveAlert(db, a.id, '5 years');
    const resolvedAgain = resolveAlert(db, a.id, 'IGNORED');
    expect(resolvedAgain.resolution_value).toBe('5 years');
    expect(resolvedAgain.resolved_at).toBe(resolved.resolved_at);

    const b = insertAlert(db, {
      kind: 'general',
      severity: 'info',
      title: 'y',
      description: '',
    });
    const dismissed = dismissAlert(db, b.id);
    const dismissedAgain = dismissAlert(db, b.id);
    expect(dismissedAgain.resolved_at).toBe(dismissed.resolved_at);
    db.close();
  });

  it('resolve/dismiss on missing id throws NotFoundError', () => {
    const db = freshTestDb();
    expect(() => resolveAlert(db, 'absent')).toThrow(NotFoundError);
    expect(() => dismissAlert(db, 'absent')).toThrow(NotFoundError);
    db.close();
  });
});
