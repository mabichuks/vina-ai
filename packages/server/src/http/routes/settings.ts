import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { ConflictError, SettingsUpdateSchema, ValidationError, type Settings } from '@vina/shared';
import {
  getOrInitSettings,
  updateSettings,
  type SettingsRow,
} from '../../db/repositories/settings.js';
import { findLlmProviderById } from '../../db/repositories/llm-providers.js';
import { findSiteById, updateSiteEnabled } from '../../db/repositories/sites.js';
import { clearSerpApiKey, setSerpApiKey } from '../../services/settings-service.js';
import { validateSerpApiKey } from '../../services/serpapi-service.js';
import { parse } from '../parse.js';

/**
 * Convert the DB row (with raw `encrypted_serpapi_key: Buffer | null`) into
 * the public `Settings` shape that exposes only `has_serpapi_key`.
 */
function toResponse(row: SettingsRow): Settings {
  return {
    id: 'app',
    easy_apply_mode: row.easy_apply_mode,
    autonomous_apply_dry_run: row.autonomous_apply_dry_run,
    apply_daily_cap: row.apply_daily_cap,
    apply_min_interval_seconds: row.apply_min_interval_seconds,
    apply_listing_max_age_days: row.apply_listing_max_age_days,
    apply_consecutive_failure_limit: row.apply_consecutive_failure_limit,
    browser_headful: row.browser_headful,
    browser_stealth: row.browser_stealth,
    paused: row.paused,
    active_llm_provider_id: row.active_llm_provider_id,
    has_serpapi_key: row.encrypted_serpapi_key !== null,
    updated_at: row.updated_at,
  };
}

export async function settingsRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType },
): Promise<void> {
  const { db } = deps;

  app.get('/api/settings', async () => toResponse(getOrInitSettings(db)));

  app.patch('/api/settings', async (req) => {
    const input = parse(SettingsUpdateSchema, req.body);

    if (input.active_llm_provider_id) {
      const provider = findLlmProviderById(db, input.active_llm_provider_id);
      if (!provider) {
        throw new ConflictError(`LLM provider ${input.active_llm_provider_id} does not exist`);
      }
    }

    if (input.serpapi_key !== undefined) {
      if (input.serpapi_key === null) {
        clearSerpApiKey(db);
      } else {
        const result = await validateSerpApiKey(input.serpapi_key);
        if (!result.ok) {
          throw new ValidationError(
            `SerpAPI key validation failed (${result.reason})`,
            { reason: result.reason },
            'serpapi_key_invalid',
          );
        }
        setSerpApiKey(db, input.serpapi_key);
      }
    }

    // Apply the non-secret fields. The serpapi_key path above already
    // touched the row; one more update is fine — settings is a singleton.
    const row = updateSettings(db, {
      ...(input.easy_apply_mode !== undefined && { easy_apply_mode: input.easy_apply_mode }),
      ...(input.autonomous_apply_dry_run !== undefined && {
        autonomous_apply_dry_run: input.autonomous_apply_dry_run,
      }),
      ...(input.apply_daily_cap !== undefined && { apply_daily_cap: input.apply_daily_cap }),
      ...(input.apply_min_interval_seconds !== undefined && {
        apply_min_interval_seconds: input.apply_min_interval_seconds,
      }),
      ...(input.apply_listing_max_age_days !== undefined && {
        apply_listing_max_age_days: input.apply_listing_max_age_days,
      }),
      ...(input.apply_consecutive_failure_limit !== undefined && {
        apply_consecutive_failure_limit: input.apply_consecutive_failure_limit,
      }),
      ...(input.browser_headful !== undefined && {
        browser_headful: input.browser_headful,
      }),
      ...(input.browser_stealth !== undefined && {
        browser_stealth: input.browser_stealth,
      }),
      ...(input.paused !== undefined && { paused: input.paused }),
      ...(input.active_llm_provider_id !== undefined && {
        active_llm_provider_id: input.active_llm_provider_id,
      }),
    });
    return toResponse(row);
  });

  app.delete('/api/settings/serpapi-key', async () => {
    clearSerpApiKey(db);
    // Auto-disable Google Jobs since it can't function without a key.
    if (findSiteById(db, 'google')?.enabled) {
      updateSiteEnabled(db, 'google', false);
    }
    return toResponse(getOrInitSettings(db));
  });
}
