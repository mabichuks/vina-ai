import { describe, expect, it } from 'vitest';
import { freshTestDb } from '../test-helpers.js';
import { findSiteById, listSites, updateSiteEnabled, updateSiteSession } from './sites.js';

describe('sites repository', () => {
  it('listSites returns the three seeded rows', () => {
    const db = freshTestDb();
    const sites = listSites(db);
    expect(sites.map((s) => s.id).sort()).toEqual(['google', 'indeed', 'linkedin']);
    expect(sites.find((s) => s.id === 'google')?.kind).toBe('api');
    expect(sites.find((s) => s.id === 'linkedin')?.kind).toBe('browser');
    db.close();
  });

  it('updateSiteEnabled flips the enabled flag', () => {
    const db = freshTestDb();
    expect(findSiteById(db, 'linkedin')?.enabled).toBe(false);
    updateSiteEnabled(db, 'linkedin', true);
    expect(findSiteById(db, 'linkedin')?.enabled).toBe(true);
    db.close();
  });

  it('updateSiteSession allows null session_path on api-kind sites', () => {
    const db = freshTestDb();
    const updated = updateSiteSession(db, 'google', {
      session_path: null,
      last_search_at: '2026-04-28T12:00:00Z',
    });
    expect(updated.kind).toBe('api');
    expect(updated.session_path).toBeNull();
    expect(updated.last_search_at).toBe('2026-04-28T12:00:00Z');
    db.close();
  });

  it('updateSiteSession sets a session_path on browser-kind sites', () => {
    const db = freshTestDb();
    const updated = updateSiteSession(db, 'linkedin', {
      session_path: 'sessions/linkedin.json',
      session_valid_at: '2026-04-28T12:00:00Z',
    });
    expect(updated.session_path).toBe('sessions/linkedin.json');
    expect(updated.session_valid_at).toBe('2026-04-28T12:00:00Z');
    db.close();
  });
});
