import type { Database as DatabaseType } from 'better-sqlite3';
import { findJobById } from '../db/repositories/jobs.js';
import { getOrInitSettings } from '../db/repositories/settings.js';
import { getOrInitSearchPreferences } from '../db/repositories/search-preferences.js';
import { getRateLimit } from '../db/repositories/apply-rate-limit.js';

/**
 * The external-ATS submit gate (issue #21). Mirrors `checkEasyApplyGate`'s
 * cap/velocity/freshness/idempotency/circuit-breaker checks but requires
 * `apply_method === 'manual'` (the inverse of the Easy Apply gate) — external
 * submissions are the manual-apply pipeline's submit path.
 *
 * Pure — never mutates state. Callers update rate-limit state after attempt
 * outcomes are known, exactly as the Easy Apply gate does.
 */

export type ExternalGateBlockReason =
  | 'below_threshold'
  | 'listing_stale'
  | 'daily_cap_reached'
  | 'velocity_throttle'
  | 'circuit_breaker_tripped'
  | 'apply_task_in_flight'
  | 'job_not_found'
  | 'wrong_apply_method'
  | 'system_paused';

export type ExternalGateDecision =
  | { decision: 'allow' }
  | { decision: 'dry_run' }
  | { decision: 'block'; reason: ExternalGateBlockReason; detail?: string };

export interface ExternalGateInput {
  jobId: string;
  nowIso: string;
  /** YYYY-MM-DD in local time used for rate-limit bucketing. */
  today: string;
  /** Current application — excluded from the in-flight scan so the gate doesn't block its own task. */
  excludeApplicationId?: string;
}

export function checkExternalSubmitGate(
  db: DatabaseType,
  input: ExternalGateInput,
): ExternalGateDecision {
  const job = findJobById(db, input.jobId);
  if (!job) return { decision: 'block', reason: 'job_not_found' };
  if (job.apply_method !== 'manual') {
    return { decision: 'block', reason: 'wrong_apply_method' };
  }

  const settings = getOrInitSettings(db);
  if (settings.paused) return { decision: 'block', reason: 'system_paused' };

  const prefs = getOrInitSearchPreferences(db);
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

  // Idempotency: block when an external form-fill task for the same job is
  // already pending/running (a retried submit must not double-submit).
  const inFlight = input.excludeApplicationId
    ? db
        .prepare(
          `
          SELECT t.id FROM task_queue t
           JOIN applications a ON a.id = json_extract(t.payload, '$.application_id')
           WHERE t.kind = 'external_form_fill'
             AND t.status IN ('pending', 'running')
             AND a.job_id = ?
             AND a.id != ?
           LIMIT 1
        `,
        )
        .get(input.jobId, input.excludeApplicationId)
    : db
        .prepare(
          `
          SELECT t.id FROM task_queue t
           JOIN applications a ON a.id = json_extract(t.payload, '$.application_id')
           WHERE t.kind = 'external_form_fill'
             AND t.status IN ('pending', 'running')
             AND a.job_id = ?
           LIMIT 1
        `,
        )
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
    const sinceLast = (Date.parse(input.nowIso) - Date.parse(rl.last_attempt_at)) / 1000;
    if (sinceLast < settings.apply_min_interval_seconds) {
      return { decision: 'block', reason: 'velocity_throttle' };
    }
  }

  return settings.autonomous_apply_dry_run ? { decision: 'dry_run' } : { decision: 'allow' };
}
