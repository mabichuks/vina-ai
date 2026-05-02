import { z } from 'zod';
import { APPLY_METHODS, JOB_STATUSES } from '../enums.js';

const isoDate = z.iso.datetime();

export const JobSchema = z.object({
  id: z.string().min(1),
  site_id: z.string().min(1),
  external_id: z.string().min(1),
  url: z.url(),
  external_apply_url: z.url().nullable(),
  apply_method: z.enum(APPLY_METHODS),
  original_source: z.string().nullable(),
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().nullable(),
  description: z.string(),
  salary_text: z.string().nullable(),
  posted_at: isoDate.nullable(),
  discovered_at: isoDate,
  match_score: z.number().int().min(0).max(100).nullable(),
  match_justification: z.string().nullable(),
  status: z.enum(JOB_STATUSES),
});
export type Job = z.infer<typeof JobSchema>;
