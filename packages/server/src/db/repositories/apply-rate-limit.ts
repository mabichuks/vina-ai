import type { Database as DatabaseType } from 'better-sqlite3';
import { VinaError } from '@vina/shared';

export interface ApplyRateLimit {
  id: 'app';
  successful_today: number;
  consecutive_failures: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  day_bucket: string;
}

export function getRateLimit(db: DatabaseType): ApplyRateLimit {
  const row = db
    .prepare(`SELECT * FROM apply_rate_limit WHERE id = 'app'`)
    .get() as ApplyRateLimit | undefined;
  if (!row) throw new VinaError('setup_error', 'apply_rate_limit row missing — migration not applied');
  return row;
}

/**
 * Stamp an attempt. If `day_bucket` differs from `today`, the daily success
 * count rolls to zero before the timestamp is set — keeps the count in sync
 * with the configured "day" regardless of polling cadence.
 */
export function recordAttempt(
  db: DatabaseType,
  nowIso: string,
  today: string,
): void {
  db.prepare(`
    UPDATE apply_rate_limit
       SET successful_today = CASE WHEN day_bucket = ? THEN successful_today ELSE 0 END,
           day_bucket       = ?,
           last_attempt_at  = ?
     WHERE id = 'app'
  `).run(today, today, nowIso);
}

export function recordSuccess(
  db: DatabaseType,
  nowIso: string,
  today: string,
): void {
  db.prepare(`
    UPDATE apply_rate_limit
       SET successful_today      = CASE WHEN day_bucket = ? THEN successful_today + 1 ELSE 1 END,
           day_bucket            = ?,
           consecutive_failures  = 0,
           last_attempt_at       = ?,
           last_success_at       = ?
     WHERE id = 'app'
  `).run(today, today, nowIso, nowIso);
}

/** No `today` parameter — failures don't affect `successful_today` (day-scoped),
 *  and `consecutive_failures` is day-agnostic circuit-breaker state. */
export function recordFailure(db: DatabaseType): void {
  db.prepare(`
    UPDATE apply_rate_limit
       SET consecutive_failures = consecutive_failures + 1
     WHERE id = 'app'
  `).run();
}

export function resetConsecutiveFailures(db: DatabaseType): void {
  db.prepare(`UPDATE apply_rate_limit SET consecutive_failures = 0 WHERE id = 'app'`).run();
}
