import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { ValidationError } from '@vina/shared';
import type { ServerConfig } from '../../config.js';
import { findProfile } from '../../db/repositories/profile.js';
import { listCvs } from '../../db/repositories/cvs.js';
import { findLlmProviderById, listLlmProviders } from '../../db/repositories/llm-providers.js';
import { listSites } from '../../db/repositories/sites.js';
import { getOrInitSettings, updateSettings } from '../../db/repositories/settings.js';
import { listPending } from '../../db/repositories/task-queue.js';

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
  if (listCvs(db).length === 0) return false;
  if (!listSites(db).some((s) => s.enabled)) return false;
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

    return {
      version,
      started_at: startedAt,
      scheduler: { running: !settings.paused, next_run_at: null },
      queue: { pending: listPending(db).length, running: 0 },
      active_provider: provider ? { kind: provider.kind, model: provider.model } : null,
      sources: listSites(db).map((s) => ({
        id: s.id,
        kind: s.kind,
        enabled: s.enabled,
        ok: s.kind === 'browser' ? s.session_valid_at !== null : null,
      })),
    };
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
