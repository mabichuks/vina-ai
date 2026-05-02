import { z } from 'zod';
import { APPROVAL_SETTINGS, OPERATING_MODES } from '../enums.js';

const isoDate = z.iso.datetime();

/**
 * The settings *response* shape. Never contains the raw SerpAPI key — only
 * `has_serpapi_key` derived from whether the encrypted column is populated.
 */
export const SettingsSchema = z.object({
  id: z.literal('app'),
  mode: z.enum(OPERATING_MODES),
  approval: z.enum(APPROVAL_SETTINGS),
  browser_headful: z.boolean(),
  paused: z.boolean(),
  active_llm_provider_id: z.string().nullable(),
  has_serpapi_key: z.boolean(),
  updated_at: isoDate,
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Partial update payload. `serpapi_key` is the only place a plaintext key
 * crosses the boundary — sent in, never returned.
 */
export const SettingsUpdateSchema = z.object({
  mode: z.enum(OPERATING_MODES).optional(),
  approval: z.enum(APPROVAL_SETTINGS).optional(),
  browser_headful: z.boolean().optional(),
  paused: z.boolean().optional(),
  active_llm_provider_id: z.string().nullable().optional(),
  serpapi_key: z.string().min(1).nullable().optional(),
});
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;
