import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { JOB_STATUSES, NotFoundError, type JobStatus } from '@vina/shared';
import { findJobById, listJobs, updateJobStatus } from '../../db/repositories/jobs.js';
import type { EventBus } from '../../events/bus.js';
import { parse } from '../parse.js';

// Accept either a single status or a comma-separated list. The worklist UI
// (Jobs page → New tab) passes `status=new,scored` so unscored listings
// stream into view as "Scoring…" placeholders while their score tasks run.
const JOB_STATUS_SET = new Set<string>(JOB_STATUSES);
const StatusFilterSchema = z
  .string()
  .transform((raw) => raw.split(',').map((s) => s.trim()).filter(Boolean))
  .refine((arr) => arr.every((s) => JOB_STATUS_SET.has(s)), {
    message: 'status must be one or more of the JOB_STATUSES enum, comma-separated',
  })
  .transform((arr) => arr as JobStatus[]);

const ListQuerySchema = z.object({
  status: StatusFilterSchema.optional(),
  min_score: z.coerce.number().int().min(0).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
});

const IdParamsSchema = z.object({ id: z.string().min(1) });

export async function jobRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType; bus: EventBus },
): Promise<void> {
  const { db, bus } = deps;

  app.get('/api/jobs', async (req) => {
    const q = parse(ListQuerySchema, req.query, 'query');
    const offset = (q.page - 1) * q.page_size;
    // Unwrap single-element arrays so the existing repo path stays warm.
    const status =
      q.status && q.status.length === 1 ? q.status[0] : q.status;
    const items = listJobs(db, {
      ...(status && { status }),
      ...(q.min_score !== undefined && { min_score: q.min_score }),
      limit: q.page_size,
      offset,
    });
    return { items, page: q.page, page_size: q.page_size };
  });

  app.get('/api/jobs/:id', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const job = findJobById(db, id);
    if (!job) throw new NotFoundError(`Job ${id} not found`);
    return job;
  });

  app.post('/api/jobs/:id/applied', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    if (!findJobById(db, id)) throw new NotFoundError(`Job ${id} not found`);
    const next = updateJobStatus(db, id, 'applied_manually');
    bus.emit('jobs:updated', { ids: [id] });
    return next;
  });

  app.post('/api/jobs/:id/skip', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    if (!findJobById(db, id)) throw new NotFoundError(`Job ${id} not found`);
    const next = updateJobStatus(db, id, 'skipped');
    bus.emit('jobs:updated', { ids: [id] });
    return next;
  });

  app.post('/api/jobs/:id/scored', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    if (!findJobById(db, id)) throw new NotFoundError(`Job ${id} not found`);
    const next = updateJobStatus(db, id, 'scored');
    bus.emit('jobs:updated', { ids: [id] });
    return next;
  });
}
