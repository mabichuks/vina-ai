import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { APPLICATION_STATUSES, NotFoundError } from '@vina/shared';
import {
  findApplicationById,
  listApplications,
  markApplicationApplied,
  markApplicationSkipped,
} from '../../db/repositories/applications.js';
import { findJobById } from '../../db/repositories/jobs.js';
import { listAlerts, resolveAlert } from '../../db/repositories/alerts.js';
import type { EventBus } from '../../events/bus.js';
import { parse } from '../parse.js';

const ListQuerySchema = z.object({
  status: z.enum(APPLICATION_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
});
const IdParams = z.object({ id: z.string().min(1) });
const MarkAppliedBody = z.object({ notes: z.string().optional() });
const SkipBody = z.object({ reason: z.string().optional() });

/**
 * When the user clicks Mark applied / Skip, the corresponding open
 * `ready_for_manual_apply` alert becomes stale instantly — resolve it so the
 * Alerts surface doesn't carry an action-required item for a triaged
 * application. Emits `alert:resolved` so the WS layer can invalidate caches.
 */
function autoResolveReadyAlert(
  db: DatabaseType,
  bus: EventBus,
  applicationId: string,
): void {
  const alerts = listAlerts(db, {
    status: 'open',
    application_id: applicationId,
    kind: 'ready_for_manual_apply',
  });
  for (const a of alerts) {
    resolveAlert(db, a.id);
    bus.emit('alert:resolved', { id: a.id });
  }
}

function attachmentFilename(
  jobTitle: string,
  company: string,
  kind: 'cv' | 'cover',
): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
  return `${safe(company)}-${safe(jobTitle)}-${kind}.docx`;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function applicationRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType; bus: EventBus },
): Promise<void> {
  const { db, bus } = deps;

  app.get('/api/applications', async (req) => {
    const q = parse(ListQuerySchema, req.query, 'query');
    const status = q.status ?? 'ready_for_manual_apply';
    const items = listApplications(db, {
      status,
      limit: q.page_size,
      offset: (q.page - 1) * q.page_size,
    });
    return { items, page: q.page, page_size: q.page_size };
  });

  app.get('/api/applications/:id', async (req) => {
    const { id } = parse(IdParams, req.params, 'route params');
    const row = findApplicationById(db, id);
    if (!row) throw new NotFoundError(`Application ${id} not found`);
    return row;
  });

  app.get('/api/applications/:id/tailored-cv', async (req, reply) => {
    const { id } = parse(IdParams, req.params, 'route params');
    const row = findApplicationById(db, id);
    if (!row || !row.tailored_cv_path) {
      throw new NotFoundError(`No tailored CV for ${id}`);
    }
    if (!fs.existsSync(row.tailored_cv_path)) {
      throw new NotFoundError('Tailored CV missing on disk');
    }
    const job = findJobById(db, row.job_id);
    reply.header(
      'Content-Disposition',
      `attachment; filename="${attachmentFilename(job?.title ?? 'job', job?.company ?? 'company', 'cv')}"`,
    );
    reply.type(DOCX_MIME);
    return fs.createReadStream(row.tailored_cv_path);
  });

  app.get('/api/applications/:id/tailored-cover-letter', async (req, reply) => {
    const { id } = parse(IdParams, req.params, 'route params');
    const row = findApplicationById(db, id);
    if (!row || !row.tailored_cover_letter_path) {
      throw new NotFoundError(`No tailored cover letter for ${id}`);
    }
    if (!fs.existsSync(row.tailored_cover_letter_path)) {
      throw new NotFoundError('Cover letter missing on disk');
    }
    const job = findJobById(db, row.job_id);
    reply.header(
      'Content-Disposition',
      `attachment; filename="${attachmentFilename(job?.title ?? 'job', job?.company ?? 'company', 'cover')}"`,
    );
    reply.type(DOCX_MIME);
    return fs.createReadStream(row.tailored_cover_letter_path);
  });

  app.post('/api/applications/:id/mark-applied', async (req) => {
    const { id } = parse(IdParams, req.params, 'route params');
    const body = parse(MarkAppliedBody, req.body ?? {});
    const next = markApplicationApplied(db, id, undefined, body.notes);
    autoResolveReadyAlert(db, bus, id);
    const appliedAt = next.applied_manually_at ?? new Date().toISOString();
    bus.emit('application:applied_manually', {
      application_id: id,
      applied_at: appliedAt,
    });
    bus.emit('jobs:updated', { ids: [next.job_id] });
    return next;
  });

  app.post('/api/applications/:id/skip', async (req) => {
    const { id } = parse(IdParams, req.params, 'route params');
    const body = parse(SkipBody, req.body ?? {});
    const next = markApplicationSkipped(db, id, body.reason);
    autoResolveReadyAlert(db, bus, id);
    bus.emit('application:skipped', {
      application_id: id,
      skipped_at: new Date().toISOString(),
      reason: body.reason,
    });
    bus.emit('jobs:updated', { ids: [next.job_id] });
    return next;
  });
}
