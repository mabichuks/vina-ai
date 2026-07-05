import { startFixtureServer, type FixtureServerHandle } from '../../start-server.js';
import {
  easyApplyDetailPage,
  externalNoUrlDetailPage,
  externalRedirectDetailPage,
  feedPage,
  guestSearchResultsPage,
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
 * - `GET /jobs/search`      — search results with three listing cards (authed or guest)
 * - `GET /jobs/search-guest` — guest SERP with public_jobs_* tracking attributes
 * - `GET /authwall`         — guest SERP with authwall modal
 * - `GET /jobs/view/easy`   — Easy Apply detail
 * - `GET /jobs/view/ext`    — external-redirect detail (with href)
 * - `GET /jobs/view/ndi`    — external-redirect detail (no href, degraded)
 */
export async function startLinkedInFixture(
  opts: { serp?: 'authed' | 'guest' } = {},
): Promise<FixtureServerHandle> {
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
    ): Promise<unknown> =>
      reply
        .type('text/html')
        .send(opts.serp === 'guest' ? guestSearchResultsPage() : searchResultsPage());
    app.get('/jobs/search', respondWithSearchResults);
    app.get('/jobs/search/', respondWithSearchResults);
    // Always-on guest routes so adapter tests don't need a second fixture boot.
    app.get('/jobs/search-guest', async (_req, reply) =>
      reply.type('text/html').send(guestSearchResultsPage()),
    );
    app.get('/authwall', async (_req, reply) =>
      reply.type('text/html').send(guestSearchResultsPage()),
    );
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
