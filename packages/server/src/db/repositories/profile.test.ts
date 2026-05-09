import { describe, expect, it } from 'vitest';
import { ConflictError } from '@vina/shared';
import { freshTestDb } from '../test-helpers.js';
import { findProfile, insertProfile, updateProfile } from './profile.js';

describe('profile repository', () => {
  it('returns null when no profile is set', () => {
    const db = freshTestDb();
    expect(findProfile(db)).toBeNull();
    db.close();
  });

  it('inserts and retrieves the profile', () => {
    const db = freshTestDb();
    const inserted = insertProfile(db, {
      full_name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    expect(inserted.id).toBe('me');
    expect(inserted.full_name).toBe('Ada Lovelace');

    const found = findProfile(db);
    expect(found).toEqual(inserted);
    db.close();
  });

  it('refuses a second insert (single-row semantics)', () => {
    const db = freshTestDb();
    insertProfile(db, { full_name: 'a', email: 'a@b.com' });
    expect(() => insertProfile(db, { full_name: 'b', email: 'b@c.com' })).toThrow(ConflictError);
    db.close();
  });

  it('updates only specified fields and bumps updated_at', async () => {
    const db = freshTestDb();
    const inserted = insertProfile(db, { full_name: 'Ada', email: 'ada@example.com' });
    // Sleep 5ms so updated_at differs from created_at.
    await new Promise((r) => setTimeout(r, 5));

    const updated = updateProfile(db, { phone: '+44 7700 900000' });
    expect(updated.phone).toBe('+44 7700 900000');
    expect(updated.full_name).toBe('Ada');
    expect(updated.email).toBe('ada@example.com');
    expect(updated.updated_at).not.toBe(inserted.updated_at);
    expect(updated.created_at).toBe(inserted.created_at);
    db.close();
  });

  it('updateProfile throws when no profile exists', () => {
    const db = freshTestDb();
    expect(() => updateProfile(db, { full_name: 'x' })).toThrow(ConflictError);
    db.close();
  });
});
