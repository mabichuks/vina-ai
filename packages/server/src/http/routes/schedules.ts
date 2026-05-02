import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { ValidationError } from '@vina/shared';
import {
  deleteSchedule,
  insertSchedule,
  listSchedules,
  updateSchedule,
} from '../../db/repositories/schedules.js';
import { parse } from '../parse.js';

const CreateScheduleSchema = z.object({
  cron_expression: z.string().min(1),
  enabled: z.boolean().optional(),
});

const UpdateScheduleSchema = z.object({
  cron_expression: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

const IdParamsSchema = z.object({ id: z.string().min(1) });

function assertValidCron(expr: string): void {
  try {
    CronExpressionParser.parse(expr);
  } catch {
    throw new ValidationError(`Invalid cron expression: ${expr}`, undefined, 'invalid_cron');
  }
}

export async function scheduleRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType },
): Promise<void> {
  const { db } = deps;

  app.get('/api/schedules', async () => listSchedules(db));

  app.post('/api/schedules', async (req) => {
    const input = parse(CreateScheduleSchema, req.body);
    assertValidCron(input.cron_expression);
    return insertSchedule(db, input);
  });

  app.patch('/api/schedules/:id', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const input = parse(UpdateScheduleSchema, req.body);
    if (input.cron_expression) assertValidCron(input.cron_expression);
    return updateSchedule(db, id, input);
  });

  app.delete('/api/schedules/:id', async (req, reply) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    deleteSchedule(db, id);
    return reply.status(204).send();
  });
}
