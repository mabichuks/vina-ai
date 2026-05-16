import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createSearchHandler } from '../../src/queue/handlers/search.js';
import { createScoreHandler } from '../../src/queue/handlers/score.js';
import { createEventBus } from '../../src/events/bus.js';
import { freshTestDb } from '../db/helpers.js';
import { insertProfile } from '../../src/db/repositories/profile.js';
import { insertCv } from '../../src/db/repositories/cvs.js';
import { upsertSearchPreferences } from '../../src/db/repositories/search-preferences.js';
import { setSerpApiKey } from '../../src/services/settings-service.js';
import { _resetVaultForTests, initVault } from '../../src/secrets/vault.js';
import { findJobById, listJobs, updateJobStatus } from '../../src/db/repositories/jobs.js';
import { listPending } from '../../src/db/repositories/task-queue.js';
import {
  searchGoogleJobs,
  type GoogleJobsListing,
  type GoogleJobsSearchInput,
} from '../../src/services/serpapi-service.js';
import {
  startGoogleJobsFixture,
} from '../../../../tests/fixtures/sites/google/server.js';
import type { FixtureServerHandle } from '../../../../tests/fixtures/start-server.js';

let db: DatabaseType;
let fixture: FixtureServerHandle;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-google-e2e-'));
  process.env['VINA_DISABLE_KEYTAR'] = '1';
  _resetVaultForTests();
  await initVault(tmpDir);

  db = freshTestDb();
  fixture = await startGoogleJobsFixture();

  insertProfile(db, { full_name: 'Pat', email: 'p@x.com', bio: 'Engineer' });
  insertCv(db, {
    label: 'main',
    original_filename: 'cv.pdf',
    mime_type: 'application/pdf',
    file_path: '/tmp/cv.pdf',
    extracted_text: 'TS, Postgres, AWS',
    is_default: true,
  });
  upsertSearchPreferences(db, {
    description: 'Senior backend',
    keywords: ['typescript'],
    locations: ['Remote'],
    work_models: ['remote'],
    seniority: ['senior'],
    excluded_companies: [],
  });
  // Store a key so the search handler doesn't bail with "key not configured".
  setSerpApiKey(db, 'fixture-key');
});

afterEach(async () => {
  delete process.env['VINA_DISABLE_KEYTAR'];
  await fixture.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Wraps `searchGoogleJobs` so it points at the local fixture instead of the
 * real SerpAPI endpoint. Rewrites only the origin; all query params (engine,
 * q, api_key, next_page_token, …) are preserved so the iterator's pagination
 * logic runs unmodified.
 */
function makeFixtureSearch(
  fixtureUrl: string,
): (
  input: GoogleJobsSearchInput,
  opts: { apiKey: string; signal?: AbortSignal },
) => AsyncIterable<GoogleJobsListing> {
  return (input, opts) =>
    searchGoogleJobs(input, {
      apiKey: opts.apiKey,
      signal: opts.signal,
      maxPages: 3,
      retryDelayMs: 1,
      fetchImpl: async (url) => {
        const original = new URL(typeof url === 'string' ? url : String(url));
        // Keep path + query string; swap origin to the fixture server.
        const rewritten = new URL(original.pathname + original.search, fixtureUrl);
        return fetch(rewritten);
      },
    });
}

describe('Google Jobs slice — end-to-end', () => {
  it('search → score → applied flow against the SerpAPI fixture', async () => {
    const bus = createEventBus();

    // browserManager is not used for api-kind sites; pass a minimal stub so
    // the type-checker is satisfied without importing the full automation pkg.
    const fakeBrowserManager = {
      getContext: async () => ({ newPage: async () => ({}) }),
      closeAll: async () => {},
    } as never;

    const search = createSearchHandler({
      db,
      bus,
      browserManager: fakeBrowserManager,
      adapters: {},
      serpapiSearch: makeFixtureSearch(fixture.url),
    });

    await search({ site_id: 'google' });

    // All three fixture listings must land in the DB.
    const jobs = listJobs(db, { site_id: 'google' });
    expect(jobs.map((j) => j.external_id).sort()).toEqual(['g-1', 'g-2', 'g-3']);

    // Google Jobs are always manual-apply (no Easy Apply equivalent).
    expect(jobs.every((j) => j.apply_method === 'manual')).toBe(true);

    // Every listing must carry an external apply URL.
    expect(jobs.every((j) => j.external_apply_url !== null)).toBe(true);

    // `via` field is stored in original_source.
    expect(jobs.find((j) => j.external_id === 'g-1')?.original_source).toBe('via Greenhouse');

    // Salary propagated for the first listing.
    expect(jobs.find((j) => j.external_id === 'g-1')?.salary_text).toBe('$180K');

    // Run the score handler with a fake model that always returns score=80.
    const fakeModel = {
      withStructuredOutput: () => ({
        invoke: async () => ({ score: 80, justification: 'Good match.' }),
      }),
    } as unknown as BaseChatModel;

    const score = createScoreHandler({
      db,
      bus,
      buildModel: async () => fakeModel,
    });

    for (const t of listPending(db).filter((p) => p.kind === 'score')) {
      await score(JSON.parse(t.payload) as { job_id: string });
    }

    const scored = listJobs(db, { status: 'scored', site_id: 'google' });
    expect(scored.length).toBe(3);
    expect(scored.every((j) => j.match_score === 80)).toBe(true);

    // Status flip: simulate the user clicking "Mark as applied".
    updateJobStatus(db, scored[0]!.id, 'applied_manually');
    expect(findJobById(db, scored[0]!.id)?.status).toBe('applied_manually');
  }, 30_000);
});
