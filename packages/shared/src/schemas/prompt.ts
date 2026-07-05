import { z } from 'zod';

/** Summary metadata, returned by the list endpoint. */
export const PromptSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  graph: z.string().min(1),
  editable_by_user: z.boolean(),
  variables: z.array(z.string()),
  version: z.number().int().nonnegative(),
  is_overridden: z.boolean(),
});
export type PromptSummary = z.infer<typeof PromptSummarySchema>;

/** Detail returned by `GET /api/prompts/:id`. */
export const PromptDetailSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  graph: z.string().min(1),
  editable_by_user: z.boolean(),
  variables: z.array(z.string()),
  version: z.number().int().nonnegative(),
  is_overridden: z.boolean(),
  /** The packaged default body (the bytes from `packages/orchestrator/prompts/<id>.md`). */
  default_body: z.string(),
  /** The active override body, if any (the bytes from `<dataDir>/prompts/<id>.md`). */
  override_body: z.string().nullable(),
  /** What the loader would currently render — equals override_body if present, else default_body. */
  active_body: z.string(),
});
export type PromptDetail = z.infer<typeof PromptDetailSchema>;

/** Body to `PUT /api/prompts/:id` — the new override body, full file with frontmatter. */
export const PromptUpdateSchema = z.object({
  body: z.string().min(1),
});
export type PromptUpdate = z.infer<typeof PromptUpdateSchema>;
