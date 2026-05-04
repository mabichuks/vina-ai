import { startFixtureServer, type FixtureServerHandle } from '../../start-server.js';
import {
  easyApplyDetailPage,
  externalNoUrlDetailPage,
  externalRedirectDetailPage,
  feedPage,
  loginPage,
  searchResultsPage,
} from './pages.js';

export type LinkedInFixtureHandle = FixtureServerHandle;

/**
 * Boot a Fastify fixture serving canned HTML that mirrors LinkedIn's
 * relevant DOM structure. Routes:
 *
 * - `GET /login`            — login form
 * - `POST /login`           — 302 → `/feed` (always succeeds)
 * - `GET /feed`             — authed feed page
 * - `GET /jobs/search`      — search results with three listing cards
 * - `GET /jobs/view/easy`   — Easy Apply detail
 * - `GET /jobs/view/ext`    — external-redirect detail (with href)
 * - `GET /jobs/view/ndi`    — external-redirect detail (no href, degraded)
 */
export async function startLinkedInFixture(): Promise<LinkedInFixtureHandle> {
  return startFixtureServer(async (app) => {
    app.get('/login', async (_req, reply) => {
      void reply.type('text/html').send(loginPage());
    });
    app.post('/login', async (_req, reply) => {
      void reply.redirect('/feed', 302);
    });
    app.get('/feed', async (_req, reply) => {
      void reply.type('text/html').send(feedPage());
    });
    app.get('/jobs/search', async (_req, reply) => {
      void reply.type('text/html').send(searchResultsPage());
    });
    app.get('/jobs/view/easy', async (_req, reply) => {
      void reply.type('text/html').send(easyApplyDetailPage());
    });
    app.get('/jobs/view/ext', async (_req, reply) => {
      void reply.type('text/html').send(externalRedirectDetailPage());
    });
    app.get('/jobs/view/ndi', async (_req, reply) => {
      void reply.type('text/html').send(externalNoUrlDetailPage());
    });
  });
}
