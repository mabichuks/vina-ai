import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { EVENTS } from '@vina/shared';
import { createSearchHandler } from '../../../src/queue/handlers/search.js';
import { AbortedError } from '../../../src/queue/handlers/errors.js';
import { createEventBus } from '../../../src/events/bus.js';
import { listJobs } from '../../../src/db/repositories/jobs.js';
import { setSerpApiKey } from '../../../src/services/settings-service.js';
import { _resetVaultForTests, initVault } from '../../../src/secrets/vault.js';
import { upsertSearchPreferences } from '../../../src/db/repositories/search-preferences.js';
import type { GoogleJobsListing } from '../../../src/services/serpapi-service.js';
import { freshTestDb } from '../../db/helpers.js';

let db: DatabaseType;
let tmpDir: string;
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-search-cancel-'));
  process.env['VINA_DISABLE_KEYTAR'] = '1';
  _resetVaultForTests();
  await initVault(tmpDir);
  db = freshTestDb();
  upsertSearchPreferences(db, {
    description: 'Senior backend',
    keywords: ['typescript'],
    locations: ['Remote'],
    work_models: ['remote'],
    seniority: ['senior'],
    excluded_companies: [],
  });
});
afterEach(() => {
  delete process.env['VINA_DISABLE_KEYTAR'];
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const FAKE_BM = {
  getContext: async () => ({ newPage: async () => ({}) }),
  closeAll: async () => {},
} as never;

const listing = (id: string, overrides: Partial<GoogleJobsListing> = {}): GoogleJobsListing => ({
  external_id: id,
  title: `Engineer ${id}`,
  company: 'Acme',
  location: 'Remote',
  description: 'Build things.',
  via: 'via Greenhouse',
  apply_url: `https://gh.io/${id}`,
  salary_text: '$180K',
  ...overrides,
});

describe('search handler — cancellation', () => {
  it('mid-iteration abort persists jobs already yielded, throws AbortedError, emits search:cancelled (not search:completed)', async () => {
    setSerpApiKey(db, 'k');
    const ac = new AbortController();
    const bus = createEventBus();

    const cancelled: unknown[] = [];
    const completed: unknown[] = [];
    bus.on(EVENTS.SEARCH_CANCELLED, (p) => cancelled.push(p));
    bus.on(EVENTS.SEARCH_COMPLETED, (p) => completed.push(p));

    // Yields 4 listings; aborts after the 2nd so the next iteration check trips.
    async function* iter(): AsyncIterable<GoogleJobsListing> {
      yield listing('a');
      yield listing('b');
      // Trigger abort before the third listing is consumed by the handler.
      ac.abort();
      yield listing('c');
      yield listing('d');
    }

    const handler = createSearchHandler({
      db,
      bus,
      browserManager: FAKE_BM,
      adapters: {},
      serpapiSearch: () => iter(),
    });

    await expect(
      handler({
        site_id: 'google',
        task_id: 't1',
        _signal: ac.signal,
      } as never),
    ).rejects.toBeInstanceOf(AbortedError);

    const jobs = listJobs(db, { site_id: 'google' });
    expect(jobs.map((j) => j.external_id).sort()).toEqual(['a', 'b']);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({
      task_id: 't1',
      site_id: 'google',
      listings_added: 2,
      scored: 2,
    });
    expect(completed).toHaveLength(0);
  });

  it('pre-aborted controller persists zero jobs and emits empty search:cancelled', async () => {
    setSerpApiKey(db, 'k');
    const ac = new AbortController();
    ac.abort();
    const bus = createEventBus();
    const cancelled: unknown[] = [];
    bus.on(EVENTS.SEARCH_CANCELLED, (p) => cancelled.push(p));

    async function* iter(): AsyncIterable<GoogleJobsListing> {
      yield listing('a');
      yield listing('b');
    }

    const handler = createSearchHandler({
      db,
      bus,
      browserManager: FAKE_BM,
      adapters: {},
      serpapiSearch: () => iter(),
    });

    await expect(
      handler({
        site_id: 'google',
        task_id: 't1',
        _signal: ac.signal,
      } as never),
    ).rejects.toBeInstanceOf(AbortedError);

    const jobs = listJobs(db, { site_id: 'google' });
    expect(jobs).toHaveLength(0);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toEqual({
      task_id: 't1',
      site_id: 'google',
      listings_added: 0,
      scored: 0,
    });
  });
});
