import { z } from 'zod';
import { APPLICATION_EVENT_KINDS, APPLICATION_STATUSES, APPLY_METHODS } from '../enums.js';

const isoDate = z.iso.datetime();

export const ApplicationSchema = z.object({
  id: z.string().min(1),
  job_id: z.string().min(1),
  cv_id: z.string().min(1),
  cover_letter_id: z.string().min(1).nullable(),
  apply_method: z.enum(APPLY_METHODS),
  tailored_cv_path: z.string().nullable(),
  tailored_cover_letter_path: z.string().nullable(),
  status: z.enum(APPLICATION_STATUSES),
  started_at: isoDate,
  submitted_at: isoDate.nullable(),
  applied_manually_at: isoDate.nullable(),
  applied_manually_notes: z.string().nullable(),
  failure_reason: z.string().nullable(),
  form_state: z.string().nullable(),
});
export type Application = z.infer<typeof ApplicationSchema>;

export const ApplicationEventSchema = z.object({
  id: z.string().min(1),
  application_id: z.string().min(1),
  kind: z.enum(APPLICATION_EVENT_KINDS),
  payload: z.string().nullable(),
  screenshot_path: z.string().nullable(),
  created_at: isoDate,
});
export type ApplicationEvent = z.infer<typeof ApplicationEventSchema>;

/**
 * Body for `POST /applications/:id/mark-applied` (manual-apply path).
 * Both fields optional — `applied_at` defaults to "now" server-side.
 */
export const MarkAppliedRequestSchema = z.object({
  applied_at: isoDate.optional(),
  notes: z.string().optional(),
});
export type MarkAppliedRequest = z.infer<typeof MarkAppliedRequestSchema>;
