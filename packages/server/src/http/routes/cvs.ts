import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '@vina/shared';
import { deleteCv, findCvById, listCvs, setDefaultCv } from '../../db/repositories/cvs.js';
import { resolveCvPath, uploadCv } from '../../services/cv-service.js';
import type { ServerConfig } from '../../config.js';
import { parse } from '../parse.js';

const IdParamsSchema = z.object({ id: z.string().min(1) });

export async function cvRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType; config: ServerConfig },
): Promise<void> {
  const { db, config } = deps;

  app.get('/api/cvs', async () => listCvs(db));

  app.post('/api/cvs', async (req) => {
    const part = await req.file();
    if (!part) throw new ValidationError('No file uploaded', undefined, 'no_file');

    // The label can ride along as a multipart field, or default to the
    // filename minus extension if absent.
    const labelField = part.fields['label'];
    const label =
      Array.isArray(labelField) || !labelField || labelField.type !== 'field'
        ? part.filename.replace(/\.[^.]+$/, '')
        : String(labelField.value);

    const isDefaultField = part.fields['is_default'];
    const is_default =
      !Array.isArray(isDefaultField) &&
      isDefaultField &&
      isDefaultField.type === 'field' &&
      String(isDefaultField.value) === 'true';

    let buffer: Buffer;
    try {
      buffer = await part.toBuffer();
    } catch (err) {
      // @fastify/multipart raises a `RequestFileTooLargeError` once the limit
      // bites; surface as a 413.
      const e = err as { code?: string; message?: string };
      if (e.code === 'FST_REQ_FILE_TOO_LARGE') {
        return await Promise.reject(
          new ValidationError(
            `File exceeds the maximum upload size`,
            { limit_bytes: 10 * 1024 * 1024 },
            'file_too_large',
          ),
        );
      }
      throw err;
    }

    return uploadCv(db, config.filesDir, {
      label,
      original_filename: part.filename,
      mime_type: part.mimetype,
      buffer,
      is_default,
    });
  });

  app.get('/api/cvs/:id/download', async (req, reply) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const row = findCvById(db, id);
    if (!row) throw new NotFoundError(`CV ${id} not found`);

    const abs = resolveCvPath(config.filesDir, row);
    if (!fs.existsSync(abs)) {
      throw new NotFoundError(`CV file missing from disk for ${id}`);
    }
    return reply
      .header('Content-Disposition', `attachment; filename="${row.original_filename}"`)
      .type(row.mime_type)
      .send(fs.createReadStream(abs));
  });

  app.delete('/api/cvs/:id', async (req, reply) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const row = findCvById(db, id);
    if (!row) throw new NotFoundError(`CV ${id} not found`);
    deleteCv(db, id); // throws ConflictError if referenced
    // Best-effort file cleanup. The DB row is the source of truth — if the
    // file's already gone we don't error.
    try {
      fs.rmSync(resolveCvPath(config.filesDir, row), { force: true });
    } catch {
      // ignore
    }
    return reply.status(204).send();
  });

  app.post('/api/cvs/:id/default', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    return setDefaultCv(db, id);
  });
}
