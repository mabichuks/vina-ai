import type { FastifyInstance } from 'fastify';
import { NotFoundError, PromptUpdateSchema, ValidationError } from '@vina/shared';
import type { PromptsService } from '../../services/prompts-service.js';
import { parse } from '../parse.js';

export async function promptRoutes(
  app: FastifyInstance,
  deps: { prompts: PromptsService },
): Promise<void> {
  const { prompts } = deps;

  app.get('/api/prompts', async () => {
    const items = await prompts.list();
    return { items };
  });

  app.get('/api/prompts/:id', async (req) => {
    const { id } = req.params as { id: string };
    try {
      const detail = await prompts.get(id);
      return {
        ...detail.summary,
        default_body: detail.default_body,
        override_body: detail.override_body,
        active_body: detail.active_body,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError(`prompt '${id}' not found`);
      }
      throw err;
    }
  });

  app.put('/api/prompts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(PromptUpdateSchema, req.body);
    try {
      await prompts.update(id, input.body);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError(`prompt '${id}' not found`);
      }
      if (err instanceof ValidationError) throw err;
      throw err;
    }
    const detail = await prompts.get(id);
    return {
      ...detail.summary,
      default_body: detail.default_body,
      override_body: detail.override_body,
      active_body: detail.active_body,
    };
  });

  app.delete('/api/prompts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await prompts.revert(id);
    reply.code(204);
    return null;
  });
}
