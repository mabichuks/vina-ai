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

  it('cancellation persists listings up to the abort, flips task to cancelled, emits search:cancelled, no completed', async () => {
    const { createWorker } = await import('../../src/queue/worker.js');
    const { enqueue, findById } = await import('../../src/db/repositories/task-queue.js');
    const {
      cancelActiveTask,
      _resetActiveTasksForTests,
    } = await import('../../src/queue/active-tasks.js');

    _resetActiveTasksForTests();

    const bus = createEventBus();
    const events: Array<{ name: string; payload: unknown }> = [];
    bus.on('search:cancelled', (p) => events.push({ name: 'search:cancelled', payload: p }));
    bus.on('search:completed', (p) => events.push({ name: 'search:completed', payload: p }));

    const fakeBrowserManager = {
      getContext: async () => ({ newPage: async () => ({}) }),
      closeAll: async () => {},
    } as never;

    // A controllable iterator: yields the first listing immediately, then
    // suspends on a promise we resolve only after cancelActiveTask has run.
    // This guarantees the handler insertJob path runs for at least one row
    // before the signal flips, so we exercise the "mid-iteration abort"
    // contract rather than "abort before any yield".
    let yieldedFirstResolve!: () => void;
    const yieldedFirst = new Promise<void>((resolve) => {
      yieldedFirstResolve = resolve;
    });
    let releaseSecond!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    async function* controlledSearch(
      _input: GoogleJobsSearchInput,
      opts: { apiKey: string; signal?: AbortSignal },
    ): AsyncIterable<GoogleJobsListing> {
      yield {
        external_id: 'cancel-1',
        title: 'Engineer',
        company: 'Acme',
        location: 'Remote',
        description: 'Build things.',
        via: 'via Greenhouse',
        apply_url: 'https://gh.io/cancel-1',
        salary_text: '$200K',
      };
      yieldedFirstResolve();
      await release;
      if (opts.signal?.aborted) return;
      yield {
        external_id: 'cancel-2',
        title: 'Engineer 2',
        company: 'Acme',
        location: 'Remote',
        description: 'More things.',
        via: 'via Greenhouse',
        apply_url: 'https://gh.io/cancel-2',
        salary_text: '$210K',
      };
    }

    const searchHandler = createSearchHandler({
      db,
      bus,
      browserManager: fakeBrowserManager,
      adapters: {},
      serpapiSearch: controlledSearch as never,
    });

    const task = enqueue(db, { kind: 'search', payload: { site_id: 'google' } });
    const worker = createWorker({
      db,
      bus,
      pollIntervalMs: 25,
      handlers: { search: searchHandler },
    });

    worker.start();

    // Wait for the first yield to land, then cancel + release the iterator.
    await yieldedFirst;
    cancelActiveTask(task.id);
    releaseSecond();

    const settled = await new Promise<boolean>((resolve) => {
      const t0 = Date.now();
      const poll = (): void => {
        const row = findById(db, task.id);
        if (
          row &&
          (row.status === 'cancelled' || row.status === 'completed' || row.status === 'failed')
        ) {
          return resolve(true);
        }
        if (Date.now() - t0 > 5_000) return resolve(false);
        setTimeout(poll, 50);
      };
      poll();
    });
    await worker.stop(5_000);

    expect(settled).toBe(true);
    const row = findById(db, task.id)!;
    expect(row.status).toBe('cancelled');
    expect(row.failed_reason).toBe('cancelled_by_user');

    const jobs = listJobs(db, { site_id: 'google' });
    expect(jobs.map((j) => j.external_id).sort()).toEqual(['cancel-1']);

    const cancelledEvents = events.filter((e) => e.name === 'search:cancelled');
    expect(cancelledEvents.length).toBe(1);
    expect(
      (cancelledEvents[0]!.payload as { listings_added: number }).listings_added,
    ).toBe(jobs.length);

    expect(events.find((e) => e.name === 'search:completed')).toBeUndefined();
  }, 15_000);
});
