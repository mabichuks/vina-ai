import { describe, expect, it } from 'vitest';
import { freshTestDb } from '../test-helpers.js';
import { getOrInitSearchPreferences, upsertSearchPreferences } from './search-preferences.js';

describe('search_preferences repository', () => {
  it('getOrInit creates defaults on first call', () => {
    const db = freshTestDb();
    const prefs = getOrInitSearchPreferences(db);
    expect(prefs.id).toBe('default');
    expect(prefs.score_threshold).toBe(70);
    expect(prefs.keywords).toEqual([]);
    expect(prefs.work_models).toEqual([]);

    const again = getOrInitSearchPreferences(db);
    expect(again.updated_at).toBe(prefs.updated_at);
    db.close();
  });

  it('upsert applies a partial patch and leaves other fields alone', async () => {
    const db = freshTestDb();
    const seed = upsertSearchPreferences(db, {
      description: 'Senior backend, remote',
      keywords: ['typescript', 'go'],
      work_models: ['remote'],
      seniority: ['senior'],
    });

    await new Promise((r) => setTimeout(r, 5));

    const updated = upsertSearchPreferences(db, { score_threshold: 85 });
    expect(updated.score_threshold).toBe(85);
    expect(updated.description).toBe('Senior backend, remote');
    expect(updated.keywords).toEqual(['typescript', 'go']);
    expect(updated.work_models).toEqual(['remote']);
    expect(updated.updated_at).not.toBe(seed.updated_at);
    db.close();
  });

  it('round-trips JSON-encoded array fields', () => {
    const db = freshTestDb();
    upsertSearchPreferences(db, {
      excluded_companies: ['EvilCorp', 'WorseCorp'],
      locations: ['Remote', 'Berlin'],
    });
    const prefs = getOrInitSearchPreferences(db);
    expect(prefs.excluded_companies).toEqual(['EvilCorp', 'WorseCorp']);
    expect(prefs.locations).toEqual(['Remote', 'Berlin']);
    db.close();
  });
});
