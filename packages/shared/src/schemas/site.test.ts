import { describe, expect, it } from 'vitest';
import { SiteSchema } from './site.js';

describe('SiteSchema', () => {
  it('parses an api-kind site with null session_path', () => {
    const site = {
      id: 'google',
      display_name: 'Google Jobs',
      kind: 'api' as const,
      enabled: true,
      session_path: null,
      session_valid_at: null,
      last_search_at: '2026-04-28T08:00:00Z',
    };
    expect(SiteSchema.parse(site)).toEqual(site);
  });

  it('parses a browser-kind site with a session_path', () => {
    const site = {
      id: 'linkedin',
      display_name: 'LinkedIn',
      kind: 'browser' as const,
      enabled: true,
      session_path: 'sessions/linkedin.json',
      session_valid_at: '2026-04-28T07:00:00Z',
      last_search_at: '2026-04-28T08:00:00Z',
    };
    expect(SiteSchema.parse(site)).toEqual(site);
  });

  it('rejects api-kind site that carries a session_path', () => {
    expect(() =>
      SiteSchema.parse({
        id: 'google',
        display_name: 'Google Jobs',
        kind: 'api',
        enabled: true,
        session_path: 'should-not-exist.json',
        session_valid_at: null,
        last_search_at: null,
      }),
    ).toThrow();
  });
});
