import Fastify, { type FastifyPluginAsync } from 'fastify';

export interface FixtureServerHandle {
  /** Base URL like `http://127.0.0.1:54321`. */
  url: string;
  /** Same as `url`, exposed under `origin` for clarity at adapter call sites. */
  origin: string;
  /** Stop the server. Idempotent. */
  close(): Promise<void>;
}

/**
 * Boot a Fastify app with the given route registrar on an OS-assigned
 * ephemeral port (binds `0.0.0.0:0`). Returns a handle with the running
 * URL and a cleanup function.
 *
 * Used by per-site fixtures (`startLinkedInFixture` today, Indeed/Google
 * later) so each site doesn't duplicate Fastify boot. Logging is disabled
 * to keep test output clean.
 */
export async function startFixtureServer(
  registerRoutes: FastifyPluginAsync,
): Promise<FixtureServerHandle> {
  const app = Fastify({ logger: false });
  await app.register(registerRoutes);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    url,
    origin: url,
    async close() {
      await app.close();
    },
  };
}
