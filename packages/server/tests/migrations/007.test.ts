import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '..', '..', 'migrations');

function freshDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  migrate(db, { migrationsDir });
  return db;
}

describe('migration 007', () => {
  it('adds easy_apply_mode and limit columns to settings', () => {
    const db = freshDb();
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('easy_apply_mode');
    expect(names).toContain('autonomous_apply_dry_run');
    expect(names).toContain('apply_daily_cap');
    expect(names).toContain('apply_min_interval_seconds');
    expect(names).toContain('apply_listing_max_age_days');
    expect(names).toContain('apply_consecutive_failure_limit');
    expect(names).not.toContain('mode');
    expect(names).not.toContain('approval');
    db.close();
  });

  it('seeds defaults for new settings columns', () => {
    const db = freshDb();
    const row = db
      .prepare(`SELECT * FROM settings WHERE id = 'app'`)
      .get() as Record<string, unknown>;
    expect(row.easy_apply_mode).toBe('manual');
    expect(row.autonomous_apply_dry_run).toBe(0);
    expect(row.apply_daily_cap).toBe(10);
    expect(row.apply_min_interval_seconds).toBe(300);
    expect(row.apply_listing_max_age_days).toBe(14);
    expect(row.apply_consecutive_failure_limit).toBe(5);
    db.close();
  });

  it('creates apply_rate_limit row keyed app', () => {
    const db = freshDb();
    const row = db
      .prepare(`SELECT * FROM apply_rate_limit WHERE id = 'app'`)
      .get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.successful_today).toBe(0);
    expect(row?.consecutive_failures).toBe(0);
    expect(row?.last_attempt_at).toBeNull();
    expect(row?.last_success_at).toBeNull();
    expect(row?.day_bucket).toBeTypeOf('string');
    db.close();
  });
});
