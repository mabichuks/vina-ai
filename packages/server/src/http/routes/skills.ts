import type { FastifyInstance } from 'fastify';
import {
  NotFoundError,
  SkillCreateSchema,
  SkillUpdateSchema,
  ValidationError,
} from '@vina/shared';
import type { SkillsService } from '../../services/skills-service.js';
import { parse } from '../parse.js';

function toResponse(skill: {
  id: string;
  name: string;
  description: string;
  applies_to: string[];
  capabilities: string[];
  editable_by_user: boolean;
  version: number;
  source: 'default' | 'override' | 'user';
  body: string;
}): {
  id: string;
  name: string;
  description: string;
  applies_to: string[];
  capabilities: string[];
  editable_by_user: boolean;
  version: number;
  source: 'default' | 'override' | 'user';
  body: string;
} {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    applies_to: [...skill.applies_to],
    capabilities: [...skill.capabilities],
    editable_by_user: skill.editable_by_user,
    version: skill.version,
    source: skill.source,
    body: skill.body,
  };
}

export async function skillRoutes(
  app: FastifyInstance,
  deps: { skills: SkillsService },
): Promise<void> {
  const { skills } = deps;

  app.get('/api/skills', async () => {
    const all = await skills.list();
    return { items: all.map(toResponse) };
  });

  app.get('/api/skills/:id', async (req) => {
    const { id } = req.params as { id: string };
    try {
      const skill = await skills.get(id);
      return toResponse(skill);
    } catch (err) {
      if (err instanceof Error && /not found/.test(err.message)) {
        throw new NotFoundError(`skill '${id}' not found`);
      }
      throw err;
    }
  });

  // Create-or-update. POST and PUT are aliases here because a new user skill
  // and an override-on-a-packaged-skill take the same write path through the
  // service.
  app.post('/api/skills/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(SkillCreateSchema, req.body);
    try {
      const skill = await skills.write(id, input.body);
      return toResponse(skill);
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw err;
    }
  });

  app.put('/api/skills/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(SkillUpdateSchema, req.body);
    try {
      const skill = await skills.write(id, input.body);
      return toResponse(skill);
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw err;
    }
  });

  app.delete('/api/skills/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await skills.remove(id);
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw err;
    }
    reply.code(204);
    return null;
  });
}
