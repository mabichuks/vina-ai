import { describe, expect, it } from 'vitest';
import {
  getOrInitSearchPreferences,
  upsertSearchPreferences,
} from '../../../src/db/repositories/search-preferences.js';
import { getOrInitSettings, updateSettings } from '../../../src/db/repositories/settings.js';
import { freshTestDb } from '../helpers.js';

describe('search_preferences repository', () => {
  it('getOrInit creates defaults; partial upsert preserves other fields and round-trips JSON arrays', () => {
    const db = freshTestDb();
    const seed = getOrInitSearchPreferences(db);
    expect(seed.score_threshold).toBe(70);
    expect(seed.keywords).toEqual([]);

    upsertSearchPreferences(db, {
      keywords: ['ts', 'go'],
      excluded_companies: ['EvilCorp'],
    });
    const updated = upsertSearchPreferences(db, { score_threshold: 85 });
    expect(updated.score_threshold).toBe(85);
    expect(updated.keywords).toEqual(['ts', 'go']);
    expect(updated.excluded_companies).toEqual(['EvilCorp']);
    db.close();
  });
});

describe('settings repository', () => {
  it('getOrInit creates defaults; partial update preserves untouched columns', () => {
    const db = freshTestDb();
    const seed = getOrInitSettings(db);
    expect(seed.easy_apply_mode).toBe('manual');
    expect(seed.encrypted_serpapi_key).toBeNull();

    const updated = updateSettings(db, { paused: true });
    expect(updated.paused).toBe(true);
    expect(updated.easy_apply_mode).toBe(seed.easy_apply_mode);
    expect(updated.autonomous_apply_dry_run).toBe(seed.autonomous_apply_dry_run);
    db.close();
  });

  it('browser_stealth defaults to false; partial update toggles it and preserves other fields', () => {
    const db = freshTestDb();
    const seed = getOrInitSettings(db);
    expect(seed.browser_stealth).toBe(false);

    const enabled = updateSettings(db, { browser_stealth: true });
    expect(enabled.browser_stealth).toBe(true);
    expect(enabled.browser_headful).toBe(seed.browser_headful);
    expect(enabled.paused).toBe(seed.paused);

    // Untouched field stays as set.
    updateSettings(db, { paused: true });
    expect(getOrInitSettings(db).browser_stealth).toBe(true);
    db.close();
  });

  it('round-trips a ciphertext serpapi key; null clears, undefined leaves alone', () => {
    const db = freshTestDb();
    const cipher = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    updateSettings(db, { encrypted_serpapi_key: cipher });
    expect(Buffer.compare(getOrInitSettings(db).encrypted_serpapi_key!, cipher)).toBe(0);

    updateSettings(db, { paused: true }); // undefined: leaves key alone
    expect(getOrInitSettings(db).encrypted_serpapi_key).toBeInstanceOf(Buffer);

    updateSettings(db, { encrypted_serpapi_key: null });
    expect(getOrInitSettings(db).encrypted_serpapi_key).toBeNull();
    db.close();
  });
});
