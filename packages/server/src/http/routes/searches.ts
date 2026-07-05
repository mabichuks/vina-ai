import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { NotFoundError } from '@vina/shared';
import { findSiteById } from '../../db/repositories/sites.js';
import {
  cancel as cancelTaskRow,
  enqueue,
  findTaskById,
  listCancellableSearchTasks,
  listPending,
  setNextAttemptAt,
} from '../../db/repositories/task-queue.js';
import {
  cancelActiveTask,
  cancelTasksForSite,
} from '../../queue/active-tasks.js';
import type { EventBus } from '../../events/bus.js';
import { parse } from '../parse.js';

const BodySchema = z.object({ site_id: z.string().min(1) });

const CancelBodySchema = z
  .object({
    task_id: z.string().min(1).optional(),
    site_id: z.string().min(1).optional(),
  })
  .refine((b) => b.task_id || b.site_id, {
    message: 'task_id or site_id must be provided',
  });

export async function searchRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType; poke: () => void; bus: EventBus },
): Promise<void> {
  const { db, poke, bus } = deps;

  app.post('/api/searches/run-now', async (req, reply) => {
    const body = parse(BodySchema, req.body);
    const site = findSiteById(db, body.site_id);
    if (!site) throw new NotFoundError(`Site ${body.site_id} not found`);

    // Existing pending search task for this site. Two sub-cases:
    //   attempts === 0 → freshly enqueued by another caller (a parallel
    //                    click, a schedule fire). Dedup so we don't pile up.
    //   attempts  > 0 → the previous run failed and the worker put the row
    //                    back to 'pending' with a future next_attempt_at for
    //                    backoff. The user clicking "Search now" is an
    //                    explicit override — fast-forward next_attempt_at to
    //                    now and poke the worker so it runs immediately
    //                    instead of telling the user "already searching" for
    //                    something that isn't actually running.
    const inFlight = listPending(db).find(
      (t) =>
        t.kind === 'search' &&
        (JSON.parse(t.payload) as { site_id?: string }).site_id === site.id,
    );
    if (inFlight) {
      if (inFlight.attempts > 0) {
        setNextAttemptAt(db, inFlight.id, new Date().toISOString());
        poke();
        return reply.status(202).send({ task_id: inFlight.id, deduped: false, retried: true });
      }
      return reply.status(202).send({ task_id: inFlight.id, deduped: true });
    }

    const task = enqueue(db, { kind: 'search', payload: { site_id: site.id } });
    poke();
    return reply.status(202).send({ task_id: task.id, deduped: false });
  });

  /**
   * Cancel one task: abort the live signal if it's running, flip the row so
   * a pending retry never runs. When nothing is executing the task (backoff
   * window) no handler will emit `search:cancelled` — emit it here so the
   * UI leaves its retrying state.
   */
  const cancelOne = (taskId: string): number => {
    const row = findTaskById(db, taskId);
    const flipped = row && row.kind === 'search' ? cancelTaskRow(db, taskId) : false;
    const aborted = cancelActiveTask(taskId);
    if (flipped && !aborted && row) {
      let siteId: string | undefined;
      try {
        siteId = (JSON.parse(row.payload) as { site_id?: string }).site_id;
      } catch {
        siteId = undefined;
      }
      bus.emit('search:cancelled', {
        task_id: taskId,
        site_id: siteId ?? 'unknown',
        listings_added: 0,
        scored: 0,
      });
    }
    return flipped || aborted ? 1 : 0;
  };

  app.post('/api/searches/cancel', async (req) => {
    const body = parse(CancelBodySchema, req.body, 'request body');
    if (body.task_id) {
      return { cancelled: cancelOne(body.task_id) };
    }
    // Site-wide: abort live registrations first (authoritative for running
    // work), then flip their rows plus any backoff rows for the site.
    const abortedIds = cancelTasksForSite(body.site_id!);
    for (const id of abortedIds) cancelTaskRow(db, id);
    let flippedExtra = 0;
    for (const row of listCancellableSearchTasks(db, body.site_id!)) {
      if (cancelTaskRow(db, row.id)) {
        flippedExtra += 1;
        let siteId: string | undefined;
        try {
          siteId = (JSON.parse(row.payload) as { site_id?: string }).site_id;
        } catch {
          siteId = undefined;
        }
        bus.emit('search:cancelled', {
          task_id: row.id,
          site_id: siteId ?? body.site_id!,
          listings_added: 0,
          scored: 0,
        });
      }
    }
    return { cancelled: abortedIds.length + flippedExtra };
  });
}
