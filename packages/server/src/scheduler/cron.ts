import { CronExpressionParser } from 'cron-parser';

/**
 * Compute the next firing time for a cron expression, formatted as an ISO
 * UTC timestamp. Used both by the scheduler (after a fire) and by the
 * schedule-route handlers (on insert/update) so the DB always reflects the
 * canonical next time.
 *
 * Throws if the expression is invalid — the route layer validates the same
 * way before persisting, so this is a defensive check.
 */
export function nextRunAt(expression: string, from: Date = new Date()): string {
  const it = CronExpressionParser.parse(expression, { currentDate: from });
  return it.next().toDate().toISOString();
}
