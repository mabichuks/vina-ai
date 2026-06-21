import type { Database as DatabaseType } from 'better-sqlite3';
import { findJobById } from '../db/repositories/jobs.js';
import { getOrInitSettings } from '../db/repositories/settings.js';
import { getOrInitSearchPreferences } from '../db/repositories/search-preferences.js';
import { getRateLimit } from '../db/repositories/apply-rate-limit.js';

export type GateBlockReason =
  | 'below_threshold'
  | 'listing_stale'
  | 'daily_cap_reached'
  | 'velocity_throttle'
  | 'circuit_breaker_tripped'
  | 'apply_task_in_flight'
  | 'job_not_found'
  | 'wrong_apply_method'
  | 'system_paused';

export type GateDecision =
  | { decision: 'allow' }
  | { decision: 'dry_run' }
  | { decision: 'block'; reason: GateBlockReason; detail?: string };

export interface GateInput {
  jobId: string;
  nowIso: string;
  /** YYYY-MM-DD in local time used for rate-limit bucketing. */
  today: string;
}

/**
 * Single point of truth for "should this apply run?". Pure — never mutates state.
 * Callers update rate-limit state via the apply-rate-limit repo after attempt
 * outcomes are known.
 *
 * Check order matters — earlier checks take priority and the ordering is
 * documented in the task spec:
 *   1. job_not_found
 *   2. wrong_apply_method
 *   3. system_paused
 *   4. below_threshold
 *   5. listing_stale
 *   6. apply_task_in_flight
 *   7. circuit_breaker_tripped
 *   8. daily_cap_reached
 *   9. velocity_throttle
 *  10. dry_run vs allow
 */
export function checkEasyApplyGate(db: DatabaseType, input: GateInput): GateDecision {
  const job = findJobById(db, input.jobId);
  if (!job) return { decision: 'block', reason: 'job_not_found' };
  if (job.apply_method !== 'auto') {
    return { decision: 'block', reason: 'wrong_apply_method' };
  }

  // Respect the system-wide pause switch: a task already in task_queue when
  // the user pauses should not proceed — the gate is checked at execution time.
  const settings = getOrInitSettings(db);
  if (settings.paused) return { decision: 'block', reason: 'system_paused' };

  const prefs = getOrInitSearchPreferences(db);
  // Unscored jobs (match_score === null) are treated as score 0 — they
  // must complete scoring before they can be allowed through.
  if ((job.match_score ?? 0) < prefs.score_threshold) {
    return { decision: 'block', reason: 'below_threshold' };
  }

  if (job.posted_at) {
    const posted = Date.parse(job.posted_at);
    const now = Date.parse(input.nowIso);
    const ageDays = (now - posted) / (1000 * 60 * 60 * 24);
    if (ageDays > settings.apply_listing_max_age_days) {
      return { decision: 'block', reason: 'listing_stale' };
    }
  }

  // Idempotency JOIN: filter by status + extract application_id from payload.
  // This scans matching task_queue rows (no index on json_extract); acceptable
  // because the queue is small and bounded by the daily cap. If volume grows,
  // an index on applications.job_id would help.
  // Failed tasks may be retried via the alert-resolve flow; only `pending`/`running` block.
  const inFlight = db
    .prepare(`
      SELECT t.id FROM task_queue t
       JOIN applications a ON a.id = json_extract(t.payload, '$.application_id')
       WHERE t.kind = 'apply'
         AND t.status IN ('pending', 'running')
         AND a.job_id = ?
       LIMIT 1
    `)
    .get(input.jobId);
  if (inFlight) return { decision: 'block', reason: 'apply_task_in_flight' };

  const rl = getRateLimit(db);
  if (rl.consecutive_failures >= settings.apply_consecutive_failure_limit) {
    return { decision: 'block', reason: 'circuit_breaker_tripped' };
  }

  if (rl.day_bucket === input.today && rl.successful_today >= settings.apply_daily_cap) {
    return { decision: 'block', reason: 'daily_cap_reached' };
  }

  if (rl.last_attempt_at && settings.apply_min_interval_seconds > 0) {
    const sinceLast =
      (Date.parse(input.nowIso) - Date.parse(rl.last_attempt_at)) / 1000;
    if (sinceLast < settings.apply_min_interval_seconds) {
      return { decision: 'block', reason: 'velocity_throttle' };
    }
  }

  return settings.autonomous_apply_dry_run ? { decision: 'dry_run' } : { decision: 'allow' };
}

/** Render a stable day bucket from an ISO timestamp using the host's local TZ. */
export function dayBucketFromIso(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
