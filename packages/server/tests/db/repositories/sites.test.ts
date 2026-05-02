import { describe, expect, it } from 'vitest';
import {
  findSiteById,
  listSites,
  updateSiteEnabled,
  updateSiteSession,
} from '../../../src/db/repositories/sites.js';
import { freshTestDb } from '../helpers.js';

describe('sites repository', () => {
  it('listSites returns the three seeded rows with correct kinds', () => {
    const db = freshTestDb();
    const sites = listSites(db);
    expect(sites.map((s) => s.id).sort()).toEqual(['google', 'indeed', 'linkedin']);
    expect(sites.find((s) => s.id === 'google')?.kind).toBe('api');
    expect(sites.find((s) => s.id === 'linkedin')?.kind).toBe('browser');
    db.close();
  });

  it('updates enabled and session fields independently', () => {
    const db = freshTestDb();
    updateSiteEnabled(db, 'linkedin', true);
    expect(findSiteById(db, 'linkedin')?.enabled).toBe(true);

    const updated = updateSiteSession(db, 'linkedin', {
      session_path: 'sessions/linkedin.json',
      session_valid_at: '2026-04-28T07:00:00Z',
    });
    expect(updated.session_path).toBe('sessions/linkedin.json');
    db.close();
  });
});
