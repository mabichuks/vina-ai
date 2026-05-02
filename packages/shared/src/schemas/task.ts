import { z } from 'zod';
import { TASK_KINDS, TASK_STATUSES } from '../enums.js';

const isoDate = z.iso.datetime();

export const TaskSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(TASK_KINDS),
  payload: z.string(),
  priority: z.number().int(),
  attempts: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(),
  next_attempt_at: isoDate,
  started_at: isoDate.nullable(),
  failed_reason: z.string().nullable(),
  status: z.enum(TASK_STATUSES),
  created_at: isoDate,
});
export type Task = z.infer<typeof TaskSchema>;
