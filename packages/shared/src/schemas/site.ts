import { z } from 'zod';
import { SITE_KINDS } from '../enums.js';

const isoDate = z.iso.datetime();

export const SiteSchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string().min(1),
    kind: z.enum(SITE_KINDS),
    enabled: z.boolean(),
    session_path: z.string().min(1).nullable(),
    session_valid_at: isoDate.nullable(),
    last_search_at: isoDate.nullable(),
  })
  .superRefine((row, ctx) => {
    // api-kind sites are stateless on session — both session columns must be null.
    if (row.kind === 'api') {
      if (row.session_path !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['session_path'],
          message: "session_path must be null for kind='api'",
        });
      }
      if (row.session_valid_at !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['session_valid_at'],
          message: "session_valid_at must be null for kind='api'",
        });
      }
    }
  });
export type Site = z.infer<typeof SiteSchema>;
