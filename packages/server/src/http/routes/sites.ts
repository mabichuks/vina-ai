import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { ConflictError, NotFoundError, newId } from '@vina/shared';
import {
  findSiteById,
  listSites,
  updateSiteEnabled,
  updateSiteSession,
} from '../../db/repositories/sites.js';
import {
  clearSerpApiKey,
  getDecryptedSerpApiKey,
  hasSerpApiKey,
  setSerpApiKey,
} from '../../services/settings-service.js';
import { validateSerpApiKey } from '../../services/serpapi-service.js';
import type { LinkedInConnectService } from '../../services/linkedin-connect-service.js';
import type { ServerConfig } from '../../config.js';
import { parse } from '../parse.js';

const IdParamsSchema = z.object({ id: z.string().min(1) });
const TogglePatchSchema = z.object({ enabled: z.boolean() });

interface SiteResponse {
  id: string;
  display_name: string;
  kind: 'browser' | 'api';
  enabled: boolean;
  has_session: boolean;
  session_valid_at: string | null;
  last_search_at: string | null;
}

export async function siteRoutes(
  app: FastifyInstance,
  deps: {
    db: DatabaseType;
    config: ServerConfig;
    linkedInConnectService: LinkedInConnectService;
  },
): Promise<void> {
  const { db, config, linkedInConnectService } = deps;

  app.get(
    '/api/sites',
    async (): Promise<SiteResponse[]> =>
      listSites(db).map((s) => ({
        id: s.id,
        display_name: s.display_name,
        kind: s.kind,
        enabled: s.enabled,
        has_session: s.session_path !== null,
        session_valid_at: s.session_valid_at,
        last_search_at: s.last_search_at,
      })),
  );

  app.patch('/api/sites/:id', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const { enabled } = parse(TogglePatchSchema, req.body);
    const site = findSiteById(db, id);
    if (!site) throw new NotFoundError(`Site ${id} not found`);

    if (id === 'google' && enabled && !hasSerpApiKey(db)) {
      throw new ConflictError(
        'Cannot enable Google Jobs without a configured SerpAPI key',
        undefined,
      );
    }
    return updateSiteEnabled(db, id, enabled);
  });

  // PRD-085: stub for browser-kind login. Real Playwright integration is
  // Phase 11 (PRD-130). For now we synthesise a login_id and immediately
  // mark the session as valid so the wizard's UX flow is testable end-to-end.
  app.post('/api/sites/:id/login', async (req, reply) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const site = findSiteById(db, id);
    if (!site) throw new NotFoundError(`Site ${id} not found`);
    if (site.kind === 'api') {
      return reply.status(405).send({
        code: 'method_not_allowed',
        message: 'API-kind sites authenticate via /test, not /login',
      });
    }
    const login_id = newId();
    updateSiteSession(db, id, {
      session_path: `${config.sessionsDir}/${id}.json`,
      session_valid_at: new Date().toISOString(),
    });
    return { status: 'pending' as const, login_id };
  });

  const TestKeyBodySchema = z
    .object({ key: z.string().min(1).optional() })
    .optional();

  // PRD-086: SerpAPI test for the google site, 405 for browser-kind.
  // When a `{ key }` body is provided, validates the candidate key and
  // persists+enables on success (no mutation on failure). When no key is in
  // the body, validates the already-stored key without any mutation.
  app.post('/api/sites/:id/test', async (req, reply) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const site = findSiteById(db, id);
    if (!site) throw new NotFoundError(`Site ${id} not found`);
    if (site.kind === 'browser') {
      return reply.status(405).send({
        code: 'method_not_allowed',
        message: 'Browser-kind sites authenticate via /login, not /test',
      });
    }

    const body = parse(TestKeyBodySchema, req.body ?? {}, 'request body');
    if (body?.key) {
      const result = await validateSerpApiKey(body.key);
      if (result.ok) {
        setSerpApiKey(db, body.key);
        updateSiteEnabled(db, id, true);
      }
      return result;
    }

    const stored = getDecryptedSerpApiKey(db);
    if (!stored) return { ok: false as const, reason: 'no_key_configured' as const };
    return validateSerpApiKey(stored);
  });

  app.get('/api/sites/linkedin/status', async () => linkedInConnectService.getStatus());

  app.post('/api/sites/linkedin/connect', async (_req, reply) => {
    await linkedInConnectService.startConnect();
    return reply.status(202).send({ attempting: true });
  });

  app.delete('/api/sites/linkedin/connect', async (_req, reply) => {
    await linkedInConnectService.cancelConnect();
    return reply.status(204).send();
  });

  app.delete('/api/sites/linkedin', async (_req, reply) => {
    await linkedInConnectService.disconnect();
    return reply.status(204).send();
  });

  app.delete('/api/sites/google', async (_req, reply) => {
    clearSerpApiKey(db);
    updateSiteEnabled(db, 'google', false);
    updateSiteSession(db, 'google', { session_path: null, session_valid_at: null });
    return reply.status(204).send();
  });

  // PRD-087: clear the session for browser sites; 405 for api sites.
  app.delete('/api/sites/:id/session', async (req, reply) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const site = findSiteById(db, id);
    if (!site) throw new NotFoundError(`Site ${id} not found`);
    if (site.kind === 'api') {
      return reply.status(405).send({
        code: 'method_not_allowed',
        message: 'API-kind sites have no session to clear',
      });
    }
    if (site.session_path) {
      try {
        fs.rmSync(site.session_path, { recursive: true, force: true });
      } catch (err) {
        // Don't error the route if the file's already gone; just log.
        app.log.warn({ err, path: site.session_path }, 'failed to remove session');
      }
    }
    return updateSiteSession(db, id, { session_path: null, session_valid_at: null });
  });
}
