import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { ValidationError } from '@vina/shared';
import type { ServerConfig } from '../../config.js';
import { findProfile } from '../../db/repositories/profile.js';
import { listCvs } from '../../db/repositories/cvs.js';
import { findLlmProviderById, listLlmProviders } from '../../db/repositories/llm-providers.js';
import { findSiteById, listSites } from '../../db/repositories/sites.js';
import { getOrInitSettings, updateSettings } from '../../db/repositories/settings.js';
import { listAlerts } from '../../db/repositories/alerts.js';
import { hasSerpApiKey } from '../../services/settings-service.js';
import { countByStatus } from '../../db/repositories/task-queue.js';
import { listSchedules } from '../../db/repositories/schedules.js';
import { nextRunAt } from '../../scheduler/cron.js';

export interface SystemRouteDeps {
  db: DatabaseType;
  config: ServerConfig;
  version: string;
  startedAt: string;
}

const TABLES_TO_RESET = [
  'profile',
  'cvs',
  'cover_letters',
  'search_preferences',
  'settings',
  'schedules',
  'llm_providers',
  'jobs',
  'applications',
  'application_events',
  'alerts',
  'profile_answers',
  'chat_messages',
  'task_queue',
  'audit_log',
];

function isOnboarded(db: DatabaseType): boolean {
  if (!findProfile(db)) return false;
  if (listLlmProviders(db).length === 0) return false;
  // Having providers configured isn't enough — the user must have selected
  // one as active, otherwise the orchestrator has nothing to call.
  if (!getOrInitSettings(db).active_llm_provider_id) return false;
  if (listCvs(db).length === 0) return false;
  // Has-credentials, NOT enabled: a paused source still counts as configured.
  // Browser-kind sources are credentialed by a Playwright session on disk
  // (`session_path`); the api-kind google row is credentialed by a stored
  // SerpAPI key. Checking `enabled` here would trap users in the wizard the
  // moment they paused a source via the Settings toggle.
  const sites = listSites(db);
  const serpApiKeyPresent = hasSerpApiKey(db);
  const hasAnyCredentials = sites.some((s) => {
    if (s.kind === 'browser') return s.session_path !== null;
    if (s.kind === 'api' && s.id === 'google') return serpApiKeyPresent;
    return false;
  });
  if (!hasAnyCredentials) return false;
  return true;
}

export async function systemRoutes(app: FastifyInstance, deps: SystemRouteDeps): Promise<void> {
  const { db, config, version, startedAt } = deps;

  app.get('/api/bootstrap', async () => ({
    version,
    token: config.bearerToken,
    onboarded: isOnboarded(db),
  }));

  app.get('/api/system/status', async () => {
    const settings = getOrInitSettings(db);
    const provider = settings.active_llm_provider_id
      ? findLlmProviderById(db, settings.active_llm_provider_id)
      : null;

    const pending = countByStatus(db, 'pending');
    const running = countByStatus(db, 'running');

    // Earliest next_run_at across enabled schedules — null if no schedule has
    // a value yet. Falls back to computing from the cron expression for rows
    // whose next_run_at is null but whose schedule is enabled (e.g. inserted
    // before Task 9's route changes persist next_run_at on insert).
    const enabled = listSchedules(db).filter((s) => s.enabled);
    let earliest: string | null = null;
    for (const s of enabled) {
      const next = s.next_run_at ?? nextRunAt(s.cron_expression);
      if (earliest === null || next < earliest) earliest = next;
    }

    const linkedin = findSiteById(db, 'linkedin');
    const schedulePaused = listSchedules(db).some((s) => s.paused);

    const sitesList = listSites(db);
    const google = sitesList.find((s) => s.id === 'google');
    const openAlerts = listAlerts(db, { status: 'open' });
    const hasGoogleAlert = (kind: string): boolean =>
      openAlerts.some((a) => a.site_id === 'google' && a.kind === kind);

    const google_state: 'not_configured' | 'connected' | 'key_invalid' | 'quota_exhausted' =
      hasGoogleAlert('serpapi_key_invalid') ? 'key_invalid' :
      hasGoogleAlert('serpapi_quota_exhausted') ? 'quota_exhausted' :
      (google?.enabled && hasSerpApiKey(db)) ? 'connected' :
      'not_configured';

    return {
      version,
      started_at: startedAt,
      scheduler: { running: !settings.paused, next_run_at: earliest },
      queue: { pending, running },
      active_provider: provider ? { kind: provider.kind, model: provider.model } : null,
      sources: sitesList.map((s) => ({
        id: s.id,
        kind: s.kind,
        enabled: s.enabled,
        ok: s.kind === 'browser' ? s.session_valid_at !== null : null,
      })),
      linkedin_connected: linkedin?.session_valid_at !== null && linkedin?.session_valid_at !== undefined,
      linkedin_last_search_at: linkedin?.last_search_at ?? null,
      google_state,
      google_last_search_at: google?.last_search_at ?? null,
      schedule_paused: schedulePaused,
    };
  });

  app.get('/api/system/chromium', async () => {
    const { getChromiumInfo } = await import('@vina/automation');
    return getChromiumInfo();
  });

  app.post('/api/system/pause', async () => {
    updateSettings(db, { paused: true });
    return { paused: true };
  });

  app.post('/api/system/resume', async () => {
    updateSettings(db, { paused: false });
    return { paused: false };
  });

  app.post('/api/system/reset', async (req) => {
    const body = req.body as { confirm?: unknown } | undefined;
    if (body?.confirm !== 'reset') {
      throw new ValidationError('Body must include confirm: "reset"');
    }

    const tx = db.transaction(() => {
      for (const table of TABLES_TO_RESET) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
    });
    tx();

    // Wipe runtime artefacts. Keep the directories so subsequent writes succeed.
    for (const dir of [config.filesDir, config.sessionsDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
    }

    return { ok: true };
  });
}
