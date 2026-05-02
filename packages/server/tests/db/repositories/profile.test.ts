import { describe, expect, it } from 'vitest';
import { ConflictError } from '@vina/shared';
import { findProfile, insertProfile, updateProfile } from '../../../src/db/repositories/profile.js';
import { freshTestDb } from '../helpers.js';

describe('profile repository', () => {
  it('insert + find, then refuses a second insert (single-row)', () => {
    const db = freshTestDb();
    expect(findProfile(db)).toBeNull();
    const a = insertProfile(db, { full_name: 'Ada', email: 'ada@example.com' });
    expect(findProfile(db)).toEqual(a);
    expect(() => insertProfile(db, { full_name: 'b', email: 'b@c.com' })).toThrow(ConflictError);
    db.close();
  });

  it('updateProfile bumps updated_at, leaves unspecified fields alone', async () => {
    const db = freshTestDb();
    const a = insertProfile(db, { full_name: 'Ada', email: 'ada@example.com' });
    await new Promise((r) => setTimeout(r, 5));
    const updated = updateProfile(db, { phone: '+44 7700 900000' });
    expect(updated.phone).toBe('+44 7700 900000');
    expect(updated.full_name).toBe('Ada');
    expect(updated.created_at).toBe(a.created_at);
    expect(updated.updated_at).not.toBe(a.updated_at);
    db.close();
  });

  it('updateProfile on missing row throws ConflictError', () => {
    const db = freshTestDb();
    expect(() => updateProfile(db, { full_name: 'x' })).toThrow(ConflictError);
    db.close();
  });
});
