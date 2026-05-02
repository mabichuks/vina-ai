import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { NotFoundError, ProfileInputSchema } from '@vina/shared';
import { findProfile, insertProfile, updateProfile } from '../../db/repositories/profile.js';
import { parse } from '../parse.js';

export async function profileRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType },
): Promise<void> {
  const { db } = deps;

  app.get('/api/profile', async () => {
    const row = findProfile(db);
    if (!row) throw new NotFoundError('Profile not yet created');
    return row;
  });

  app.post('/api/profile', async (req) => {
    const input = parse(ProfileInputSchema, req.body);
    return insertProfile(db, input);
  });

  app.patch('/api/profile', async (req) => {
    const input = parse(ProfileInputSchema.partial(), req.body);
    return updateProfile(db, input);
  });
}
