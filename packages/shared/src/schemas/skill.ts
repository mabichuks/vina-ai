import { z } from 'zod';

const SkillSource = z.enum(['default', 'override', 'user']);

/** Summary metadata, returned by the list endpoint. */
export const SkillSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  applies_to: z.array(z.string()),
  capabilities: z.array(z.string()),
  editable_by_user: z.boolean(),
  version: z.number().int().nonnegative(),
  source: SkillSource,
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

/** Detail returned by `GET /api/skills/:id`. */
export const SkillDetailSchema = SkillSummarySchema.extend({
  body: z.string(),
});
export type SkillDetail = z.infer<typeof SkillDetailSchema>;

/** Body to `PUT /api/skills/:id` — the new override body (full file with frontmatter). */
export const SkillUpdateSchema = z.object({
  body: z.string().min(1),
});
export type SkillUpdate = z.infer<typeof SkillUpdateSchema>;

/** Body to `POST /api/skills` — creating a user-authored skill. */
export const SkillCreateSchema = z.object({
  body: z.string().min(1),
});
export type SkillCreate = z.infer<typeof SkillCreateSchema>;
