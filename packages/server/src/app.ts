import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { ServerConfig } from './config.js';
import { errorHandler } from './http/error-handler.js';
import { registerBearerAuth } from './http/auth.js';
import { coverLetterRoutes } from './http/routes/cover-letters.js';
import { cvRoutes } from './http/routes/cvs.js';
import { llmProviderRoutes } from './http/routes/llm-providers.js';
import { profileRoutes } from './http/routes/profile.js';
import { scheduleRoutes } from './http/routes/schedules.js';
import { searchPreferencesRoutes } from './http/routes/search-preferences.js';
import { settingsRoutes } from './http/routes/settings.js';
import { siteRoutes } from './http/routes/sites.js';
import { systemRoutes } from './http/routes/system.js';
import { registerStatic } from './http/static.js';
import { MAX_UPLOAD_BYTES } from './http/upload-limits.js';
import { registerWebSocket } from './http/ws.js';
import type { EventBus } from './events/bus.js';

export interface BuildAppDeps {
  db: DatabaseType;
  config: ServerConfig;
  version: string;
  startedAt: string;
  bus: EventBus;
}

export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.config.logLevel },
    disableRequestLogging: deps.config.logLevel !== 'debug',
  });

  app.setErrorHandler(errorHandler);
  registerBearerAuth(app, deps.config);

  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });

  await registerWebSocket(app, deps.config, deps.bus);
  await app.register(async (api) => {
    await systemRoutes(api, deps);
    await profileRoutes(api, { db: deps.db });
    await cvRoutes(api, { db: deps.db, config: deps.config });
    await coverLetterRoutes(api, { db: deps.db, config: deps.config });
    await searchPreferencesRoutes(api, { db: deps.db });
    await scheduleRoutes(api, { db: deps.db });
    await settingsRoutes(api, { db: deps.db });
    await llmProviderRoutes(api, { db: deps.db });
    await siteRoutes(api, { db: deps.db, config: deps.config });
  });
  await registerStatic(app);

  return app;
}
