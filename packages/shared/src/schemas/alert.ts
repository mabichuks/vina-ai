import { z } from 'zod';
import { ALERT_KINDS, ALERT_SEVERITIES, ALERT_STATUSES } from '../enums.js';

const isoDate = z.iso.datetime();

export const AlertSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(ALERT_KINDS),
  severity: z.enum(ALERT_SEVERITIES),
  title: z.string().min(1),
  description: z.string(),
  application_id: z.string().min(1).nullable(),
  site_id: z.string().min(1).nullable(),
  payload: z.string().nullable(),
  status: z.enum(ALERT_STATUSES),
  resolution_value: z.string().nullable(),
  created_at: isoDate,
  resolved_at: isoDate.nullable(),
});
export type Alert = z.infer<typeof AlertSchema>;
