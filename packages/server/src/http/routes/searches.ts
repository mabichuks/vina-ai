import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { NotFoundError } from '@vina/shared';
import { findSiteById } from '../../db/repositories/sites.js';
import { enqueue, listPending } from '../../db/repositories/task-queue.js';
import { parse } from '../parse.js';

const BodySchema = z.object({ site_id: z.string().min(1) });

export async function searchRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType; poke: () => void },
): Promise<void> {
  const { db, poke } = deps;

  app.post('/api/searches/run-now', async (req, reply) => {
    const body = parse(BodySchema, req.body);
    const site = findSiteById(db, body.site_id);
    if (!site) throw new NotFoundError(`Site ${body.site_id} not found`);

    const inFlight = listPending(db).find(
      (t) =>
        t.kind === 'search' &&
        (JSON.parse(t.payload) as { site_id?: string }).site_id === site.id,
    );
    if (inFlight) {
      return reply.status(202).send({ task_id: inFlight.id, deduped: true });
    }

    const task = enqueue(db, { kind: 'search', payload: { site_id: site.id } });
    poke();
    return reply.status(202).send({ task_id: task.id, deduped: false });
  });
}
