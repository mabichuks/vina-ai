import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/http/static.js → ../../public  ⇒  packages/server/public
const PUBLIC_DIR = path.resolve(here, '..', '..', 'public');

/**
 * Serve the built frontend from `packages/server/public/` with SPA index
 * fallback for client-side routes. Skipped if the build output isn't there
 * yet so dev runs without `pnpm --filter @vina/web build` don't fail to start.
 */
export async function registerStatic(app: FastifyInstance): Promise<void> {
  if (!fs.existsSync(PUBLIC_DIR)) {
    app.log.warn({ publicDir: PUBLIC_DIR }, 'no built frontend; skipping static serving');
    return;
  }

  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
  });

  // SPA index fallback: any GET that doesn't match an /api or /ws route
  // and has no asset extension serves index.html so React Router can take over.
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0] ?? req.url;
    if (
      req.method !== 'GET' ||
      url.startsWith('/api/') ||
      url.startsWith('/ws') ||
      /\.[a-zA-Z0-9]{1,8}$/.test(url)
    ) {
      void reply.status(404).send({ code: 'not_found', message: 'Not found' });
      return;
    }
    void reply.type('text/html').sendFile('index.html');
  });
}
