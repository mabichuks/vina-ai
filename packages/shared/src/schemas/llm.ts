import { z } from 'zod';
import { LLM_PROVIDER_KINDS } from '../enums.js';

const isoDate = z.iso.datetime();

/**
 * Response shape: never carries the raw API key. Only `has_api_key: boolean`,
 * derived from whether `encrypted_api_key` is populated.
 */
export const LlmProviderSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(LLM_PROVIDER_KINDS),
  label: z.string().min(1),
  model: z.string().min(1),
  base_url: z.url().nullable(),
  has_api_key: z.boolean(),
  created_at: isoDate,
});
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

/**
 * Input shape: the raw plaintext `api_key` is required for `anthropic`/`openai`
 * and optional/absent for `ollama` (local).
 */
export const LlmProviderInputSchema = z
  .object({
    kind: z.enum(LLM_PROVIDER_KINDS),
    label: z.string().min(1),
    model: z.string().min(1),
    base_url: z.url().nullable().optional(),
    api_key: z.string().min(1).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.kind !== 'ollama' && !input.api_key) {
      ctx.addIssue({
        code: 'custom',
        path: ['api_key'],
        message: `api_key is required when kind='${input.kind}'`,
      });
    }
  });
export type LlmProviderInput = z.infer<typeof LlmProviderInputSchema>;
