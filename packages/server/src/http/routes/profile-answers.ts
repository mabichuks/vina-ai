import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { NotFoundError } from '@vina/shared';
import {
  deleteAnswer,
  listAnswers,
} from '../../db/repositories/profile-answers.js';

export async function profileAnswersRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType },
): Promise<void> {
  const { db } = deps;

  app.get('/api/profile-answers', async () => ({ answers: listAnswers(db) }));

  app.delete('/api/profile-answers', async (_req, reply) => {
    db.prepare(`DELETE FROM profile_answers`).run();
    return reply.status(204).send();
  });

  app.delete('/api/profile-answers/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    const ok = deleteAnswer(db, key);
    if (!ok) throw new NotFoundError(`No saved answer with key ${key}`);
    return reply.status(204).send();
  });
}
