import { startFixtureServer, type FixtureServerHandle } from '../../start-server.js';
import { FIXTURE_JOBS_PAGE_1, FIXTURE_JOBS_PAGE_2 } from './pages.js';

/**
 * Boot a Fastify fixture that mimics the SerpAPI Google Jobs endpoint.
 *
 * - `GET /search.json` without `next_page_token` → page 1 (two listings)
 * - `GET /search.json?next_page_token=pg2`        → page 2 (one listing)
 *
 * All other query params (engine, q, api_key, location) are accepted and
 * ignored so the real `searchGoogleJobs` iterator can be used unchanged.
 */
export async function startGoogleJobsFixture(): Promise<FixtureServerHandle> {
  return startFixtureServer(async (app) => {
    app.get('/search.json', async (req) => {
      const query = req.query as Record<string, string | undefined>;
      if (query['next_page_token'] === 'pg2') return FIXTURE_JOBS_PAGE_2;
      return FIXTURE_JOBS_PAGE_1;
    });
  });
}
