import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { SearchPreferencesInputSchema } from '@vina/shared';
import {
  getOrInitSearchPreferences,
  upsertSearchPreferences,
} from '../../db/repositories/search-preferences.js';
import { parse } from '../parse.js';

export async function searchPreferencesRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType },
): Promise<void> {
  const { db } = deps;

  app.get('/api/search-preferences', async () => getOrInitSearchPreferences(db));

  app.put('/api/search-preferences', async (req) => {
    const input = parse(SearchPreferencesInputSchema, req.body);
    return upsertSearchPreferences(db, input);
  });
}
