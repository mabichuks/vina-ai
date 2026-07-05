import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import {
  getRateLimit,
  recordAttempt,
  recordSuccess,
  recordFailure,
  resetConsecutiveFailures,
} from '../../src/db/repositories/apply-rate-limit.js';

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('apply-rate-limit repository', () => {
  it("starts at zeros with today's day_bucket", () => {
    const db = freshDb();
    const rl = getRateLimit(db);
    expect(rl.successful_today).toBe(0);
    expect(rl.consecutive_failures).toBe(0);
    expect(rl.last_attempt_at).toBeNull();
    expect(rl.last_success_at).toBeNull();
    expect(rl.day_bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('recordAttempt updates last_attempt_at and rolls the day when needed', () => {
    const db = freshDb();
    db.prepare(`UPDATE apply_rate_limit SET day_bucket = '1999-01-01', successful_today = 7`).run();
    recordAttempt(db, '2026-06-21T10:00:00.000Z', '2026-06-21');
    const rl = getRateLimit(db);
    expect(rl.day_bucket).toBe('2026-06-21');
    expect(rl.successful_today).toBe(0); // rolled
    expect(rl.last_attempt_at).toBe('2026-06-21T10:00:00.000Z');
  });

  it('recordSuccess increments successful_today and resets consecutive_failures', () => {
    const db = freshDb();
    db.prepare(`UPDATE apply_rate_limit SET consecutive_failures = 3`).run();
    recordSuccess(db, '2026-06-21T10:01:00.000Z', '2026-06-21');
    const rl = getRateLimit(db);
    expect(rl.successful_today).toBe(1);
    expect(rl.consecutive_failures).toBe(0);
    expect(rl.last_success_at).toBe('2026-06-21T10:01:00.000Z');
  });

  it('recordFailure increments consecutive_failures', () => {
    const db = freshDb();
    recordFailure(db);
    recordFailure(db);
    const rl = getRateLimit(db);
    expect(rl.consecutive_failures).toBe(2);
  });

  it('resetConsecutiveFailures zeroes the counter', () => {
    const db = freshDb();
    recordFailure(db);
    recordFailure(db);
    resetConsecutiveFailures(db);
    expect(getRateLimit(db).consecutive_failures).toBe(0);
  });
});
