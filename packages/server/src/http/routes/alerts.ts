import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { ALERT_STATUSES, NotFoundError } from '@vina/shared';
import {
  dismissAlert,
  findAlertById,
  listAlerts,
  resolveAlert,
} from '../../db/repositories/alerts.js';
import { resumeFromAlertResolution } from '../../services/apply-resume-service.js';
import type { EventBus } from '../../events/bus.js';
import { parse } from '../parse.js';

const ListQuerySchema = z.object({
  status: z.enum(ALERT_STATUSES).default('open'),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
});

const IdParamsSchema = z.object({ id: z.string().min(1) });

const ResolveBodySchema = z
  .object({ value: z.string().optional() })
  .optional();

export async function alertRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType; bus: EventBus; poke: () => void },
): Promise<void> {
  const { db, bus, poke } = deps;

  app.get('/api/alerts', async (req) => {
    const q = parse(ListQuerySchema, req.query, 'query');
    const items = listAlerts(db, {
      status: q.status,
      limit: q.page_size,
      offset: (q.page - 1) * q.page_size,
    });
    return { items, page: q.page, page_size: q.page_size };
  });

  app.post('/api/alerts/:id/resolve', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const existing = findAlertById(db, id);
    if (!existing) throw new NotFoundError(`Alert ${id} not found`);
    const body = parse(ResolveBodySchema, req.body ?? {}, 'body');
    const value = body?.value;
    const next = resolveAlert(db, id, value);
    bus.emit('alert:resolved', { id });
    // Resume the application if this was an apply-related alert.
    const outcome = resumeFromAlertResolution(db, next, value ?? null);
    if (outcome.resumed) poke();
    return next;
  });

  app.post('/api/alerts/:id/dismiss', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    if (!findAlertById(db, id)) throw new NotFoundError(`Alert ${id} not found`);
    const next = dismissAlert(db, id);
    bus.emit('alert:dismissed', { id });
    return next;
  });
}
