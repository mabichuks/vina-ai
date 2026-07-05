import { describe, expect, it } from 'vitest';
import { freshTestDb } from './helpers.js';
import { getOrInitSettings, updateSettings } from '../../src/db/repositories/settings.js';

describe('settings repository (autonomous easy apply)', () => {
  it('returns defaults for new fields', () => {
    const db = freshTestDb();
    const s = getOrInitSettings(db);
    expect(s.easy_apply_mode).toBe('manual');
    expect(s.autonomous_apply_dry_run).toBe(false);
    expect(s.apply_daily_cap).toBe(10);
    expect(s.apply_min_interval_seconds).toBe(300);
    expect(s.apply_listing_max_age_days).toBe(14);
    expect(s.apply_consecutive_failure_limit).toBe(5);
    db.close();
  });

  it('round-trips easy_apply_mode + dry-run + cap updates', () => {
    const db = freshTestDb();
    updateSettings(db, {
      easy_apply_mode: 'autonomous',
      autonomous_apply_dry_run: true,
      apply_daily_cap: 25,
    });
    const s = getOrInitSettings(db);
    expect(s.easy_apply_mode).toBe('autonomous');
    expect(s.autonomous_apply_dry_run).toBe(true);
    expect(s.apply_daily_cap).toBe(25);
    db.close();
  });

  it('partial update leaves other new fields untouched', () => {
    const db = freshTestDb();
    updateSettings(db, { apply_min_interval_seconds: 60 });
    const s = getOrInitSettings(db);
    expect(s.apply_min_interval_seconds).toBe(60);
    // Unchanged fields stay at their defaults.
    expect(s.easy_apply_mode).toBe('manual');
    expect(s.apply_listing_max_age_days).toBe(14);
    expect(s.apply_consecutive_failure_limit).toBe(5);
    db.close();
  });
});
