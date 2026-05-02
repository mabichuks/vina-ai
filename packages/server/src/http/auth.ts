import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthError } from '@vina/shared';
import type { ServerConfig } from '../config.js';

/** Routes that may be hit without the bearer token. */
const PUBLIC_PATHS = new Set<string>(['/api/bootstrap']);

function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? null;
}

/**
 * Register a global `onRequest` hook that requires a matching bearer token on
 * every `/api/*` route except those in `PUBLIC_PATHS`. Mismatch → AuthError,
 * which the error handler turns into a 401 envelope.
 */
export function registerBearerAuth(app: FastifyInstance, config: ServerConfig): void {
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (PUBLIC_PATHS.has(req.url.split('?')[0] ?? req.url)) return;

    const token = extractToken(req);
    if (!token) {
      throw new AuthError('Missing bearer token');
    }
    if (token !== config.bearerToken) {
      throw new AuthError('Invalid bearer token', undefined, 'auth_invalid');
    }
  });
}
