import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '@vina/shared';
import {
  deleteCoverLetter,
  findCoverLetterById,
  listCoverLetters,
  setDefaultCoverLetter,
} from '../../db/repositories/cover-letters.js';
import { resolveCoverLetterPath, uploadCoverLetter } from '../../services/cover-letter-service.js';
import type { ServerConfig } from '../../config.js';
import { parse } from '../parse.js';
import { MAX_UPLOAD_BYTES } from '../upload-limits.js';

const IdParamsSchema = z.object({ id: z.string().min(1) });

export async function coverLetterRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType; config: ServerConfig },
): Promise<void> {
  const { db, config } = deps;

  app.get('/api/cover-letters', async () => listCoverLetters(db));

  app.post('/api/cover-letters', async (req) => {
    const part = await req.file();
    if (!part) throw new ValidationError('No file uploaded', undefined, 'no_file');

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
      const e = err as { code?: string };
      if (e.code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new ValidationError(
          `File exceeds the maximum upload size`,
          { limit_bytes: MAX_UPLOAD_BYTES },
          'file_too_large',
        );
      }
      throw err;
    }

    return uploadCoverLetter(db, config.filesDir, {
      label,
      original_filename: part.filename,
      mime_type: part.mimetype,
      buffer,
      is_default,
    });
  });

  app.get('/api/cover-letters/:id/download', async (req, reply) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const row = findCoverLetterById(db, id);
    if (!row) throw new NotFoundError(`Cover letter ${id} not found`);

    const abs = resolveCoverLetterPath(config.filesDir, row);
    if (!fs.existsSync(abs)) {
      throw new NotFoundError(`Cover letter file missing from disk for ${id}`);
    }
    return reply
      .header('Content-Disposition', `attachment; filename="${row.original_filename}"`)
      .type(row.mime_type)
      .send(fs.createReadStream(abs));
  });

  app.delete('/api/cover-letters/:id', async (req, reply) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const row = findCoverLetterById(db, id);
    if (!row) throw new NotFoundError(`Cover letter ${id} not found`);
    deleteCoverLetter(db, id);
    try {
      fs.rmSync(resolveCoverLetterPath(config.filesDir, row), { force: true });
    } catch {
      // ignore
    }
    return reply.status(204).send();
  });

  app.post('/api/cover-letters/:id/default', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    return setDefaultCoverLetter(db, id);
  });
}
