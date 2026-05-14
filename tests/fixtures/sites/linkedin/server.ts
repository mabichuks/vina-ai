import { startFixtureServer, type FixtureServerHandle } from '../../start-server.js';
import {
  easyApplyDetailPage,
  externalNoUrlDetailPage,
  externalRedirectDetailPage,
  feedPage,
  jobsHomePage,
  loginPage,
  searchResultsPage,
} from './pages.js';

/**
 * Boot a Fastify fixture serving canned HTML that mirrors LinkedIn's
 * relevant DOM structure. Routes:
 *
 * - `GET /login`            — login form
 * - `POST /login`           — redirect → `/feed` (always succeeds)
 * - `GET /feed`             — authed feed page
 * - `GET /jobs/search`      — search results with three listing cards
 * - `GET /jobs/view/easy`   — Easy Apply detail
 * - `GET /jobs/view/ext`    — external-redirect detail (with href)
 * - `GET /jobs/view/ndi`    — external-redirect detail (no href, degraded)
 */
export async function startLinkedInFixture(): Promise<FixtureServerHandle> {
  return startFixtureServer(async (app) => {
    app.get('/login', async (_req, reply) => reply.type('text/html').send(loginPage()));
    app.post('/login', async (_req, reply) => reply.redirect('/feed'));
    app.get('/feed', async (_req, reply) => reply.type('text/html').send(feedPage()));
    // Adapter navigates here, finds the keyword input, presses Enter; the
    // form submits to /jobs/search/ which renders the SRP cards.
    app.get('/jobs/', async (_req, reply) => reply.type('text/html').send(jobsHomePage()));
    app.get('/jobs', async (_req, reply) => reply.type('text/html').send(jobsHomePage()));
    const respondWithSearchResults = async (
      _req: unknown,
      reply: { type: (mime: string) => { send: (body: string) => unknown } },
    ): Promise<unknown> => reply.type('text/html').send(searchResultsPage());
    app.get('/jobs/search', respondWithSearchResults);
    app.get('/jobs/search/', respondWithSearchResults);
    app.get(
      '/jobs/view/easy',
      async (_req, reply) => reply.type('text/html').send(easyApplyDetailPage()),
    );
    app.get(
      '/jobs/view/ext',
      async (_req, reply) => reply.type('text/html').send(externalRedirectDetailPage()),
    );
    app.get(
      '/jobs/view/ndi',
      async (_req, reply) => reply.type('text/html').send(externalNoUrlDetailPage()),
    );
  });
}
