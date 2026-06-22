import type { Database as DatabaseType } from 'better-sqlite3';
import { createLogger } from '@vina/shared';

const log = createLogger('queue.maintenance');

/**
 * Delete terminal `task_queue` rows (status in completed/failed/cancelled)
 * older than `maxAgeDays`. Returns the number of rows removed. Safe to run
 * as often as once per hour.
 *
 * Uses `created_at` for the age check since that is the only timestamp
 * present on every row regardless of whether it was ever claimed.
 */
export function pruneTaskQueue(db: DatabaseType, maxAgeDays: number): number {
  const result = db
    .prepare(
      `DELETE FROM task_queue
        WHERE status IN ('completed', 'failed', 'cancelled')
          AND created_at < datetime('now', ?)`,
    )
    .run(`-${maxAgeDays} days`);
  if (result.changes > 0) {
    log.info({ removed: result.changes, maxAgeDays }, 'pruned task_queue rows');
  }
  return result.changes;
}
