import { z } from 'zod';
import { EASY_APPLY_MODES } from '../enums.js';

const isoDate = z.iso.datetime();

/**
 * The settings *response* shape. Never contains the raw SerpAPI key — only
 * `has_serpapi_key` derived from whether the encrypted column is populated.
 */
export const SettingsSchema = z.object({
  id: z.literal('app'),
  easy_apply_mode: z.enum(EASY_APPLY_MODES),
  autonomous_apply_dry_run: z.boolean(),
  apply_daily_cap: z.number().int().min(1).max(100),
  apply_min_interval_seconds: z.number().int().min(0).max(3600),
  apply_listing_max_age_days: z.number().int().min(1).max(365),
  apply_consecutive_failure_limit: z.number().int().min(1).max(50),
  browser_headful: z.boolean(),
  browser_stealth: z.boolean(),
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
  easy_apply_mode: z.enum(EASY_APPLY_MODES).optional(),
  autonomous_apply_dry_run: z.boolean().optional(),
  apply_daily_cap: z.number().int().min(1).max(100).optional(),
  apply_min_interval_seconds: z.number().int().min(0).max(3600).optional(),
  apply_listing_max_age_days: z.number().int().min(1).max(365).optional(),
  apply_consecutive_failure_limit: z.number().int().min(1).max(50).optional(),
  browser_headful: z.boolean().optional(),
  browser_stealth: z.boolean().optional(),
  paused: z.boolean().optional(),
  active_llm_provider_id: z.string().nullable().optional(),
  serpapi_key: z.string().min(1).nullable().optional(),
});
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;
