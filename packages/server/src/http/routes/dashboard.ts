import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { getRateLimit } from '../../db/repositories/apply-rate-limit.js';
import { getOrInitSettings } from '../../db/repositories/settings.js';

interface RecentRow {
  application_id: string;
  title: string;
  company: string;
  status: string;
  submitted_at: string | null;
  updated_at: string;
}

export async function dashboardRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType },
): Promise<void> {
  const { db } = deps;

  app.get('/api/dashboard/easy-apply', async () => {
    const rl = getRateLimit(db);
    const settings = getOrInitSettings(db);
    const recent = db
      .prepare(
        `SELECT a.id AS application_id, j.title AS title, j.company AS company,
                a.status AS status, a.submitted_at AS submitted_at,
                a.started_at AS updated_at
           FROM applications a
           JOIN jobs j ON j.id = a.job_id
          WHERE a.apply_method = 'auto'
            AND a.started_at >= datetime('now', '-24 hours')
          ORDER BY a.started_at DESC
          LIMIT 20`,
      )
      .all() as RecentRow[];

    return {
      submitted_today: rl.successful_today,
      day_bucket: rl.day_bucket,
      circuit_breaker_tripped:
        rl.consecutive_failures >= settings.apply_consecutive_failure_limit,
      consecutive_failures: rl.consecutive_failures,
      easy_apply_mode: settings.easy_apply_mode,
      daily_cap: settings.apply_daily_cap,
      recent,
    };
  });
}
