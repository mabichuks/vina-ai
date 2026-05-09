import { describe, expect, it } from 'vitest';
import { freshTestDb } from '../test-helpers.js';
import { getOrInitSettings, updateSettings } from './settings.js';

describe('settings repository', () => {
  it('getOrInit creates defaults on first call', () => {
    const db = freshTestDb();
    const s = getOrInitSettings(db);
    expect(s.id).toBe('app');
    expect(s.mode).toBe('supervised');
    expect(s.approval).toBe('review-first');
    expect(s.paused).toBe(false);
    expect(s.encrypted_serpapi_key).toBeNull();
    db.close();
  });

  it('updateSettings does not affect unspecified columns', () => {
    const db = freshTestDb();
    const seed = getOrInitSettings(db);

    const updated = updateSettings(db, { paused: true });
    expect(updated.paused).toBe(true);
    expect(updated.mode).toBe(seed.mode);
    expect(updated.approval).toBe(seed.approval);
    expect(updated.browser_headful).toBe(seed.browser_headful);
    db.close();
  });

  it('stores and reads back a ciphertext serpapi key', () => {
    const db = freshTestDb();
    const ciphertext = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    updateSettings(db, { encrypted_serpapi_key: ciphertext });

    const s = getOrInitSettings(db);
    expect(s.encrypted_serpapi_key).toBeInstanceOf(Buffer);
    expect(Buffer.compare(s.encrypted_serpapi_key!, ciphertext)).toBe(0);
    db.close();
  });

  it('passing null for serpapi key clears it; undefined leaves it alone', () => {
    const db = freshTestDb();
    updateSettings(db, { encrypted_serpapi_key: Buffer.from('abc') });

    // undefined: leaves alone
    updateSettings(db, { paused: true });
    let s = getOrInitSettings(db);
    expect(s.encrypted_serpapi_key).toBeInstanceOf(Buffer);

    // explicit null: clears
    updateSettings(db, { encrypted_serpapi_key: null });
    s = getOrInitSettings(db);
    expect(s.encrypted_serpapi_key).toBeNull();
    db.close();
  });
});
