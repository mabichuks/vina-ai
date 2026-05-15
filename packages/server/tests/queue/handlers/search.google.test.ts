import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { createSearchHandler } from '../../../src/queue/handlers/search.js';
import { createEventBus } from '../../../src/events/bus.js';
import { listJobs } from '../../../src/db/repositories/jobs.js';
import { listPending } from '../../../src/db/repositories/task-queue.js';
import { listAlerts } from '../../../src/db/repositories/alerts.js';
import { setSerpApiKey } from '../../../src/services/settings-service.js';
import { _resetVaultForTests, initVault } from '../../../src/secrets/vault.js';
import { upsertSearchPreferences } from '../../../src/db/repositories/search-preferences.js';
import {
  SerpapiKeyInvalidError,
  SerpapiQuotaExhaustedError,
  type GoogleJobsListing,
} from '../../../src/services/serpapi-service.js';
import { freshTestDb } from '../../db/helpers.js';

let db: DatabaseType;
let tmpDir: string;
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-google-search-'));
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const FAKE_BM = { getContext: async () => ({ newPage: async () => ({}) }), closeAll: async () => {} } as never;

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

async function* iterListings(...items: GoogleJobsListing[]): AsyncIterable<GoogleJobsListing> {
  for (const x of items) yield x;
}

describe('search handler — google branch', () => {
  it('inserts listings as manual-apply with original_source and enqueues score tasks', async () => {
    setSerpApiKey(db, 'fake-key');
    const handler = createSearchHandler({
      db,
      bus: createEventBus(),
      browserManager: FAKE_BM,
      adapters: {},
      serpapiSearch: () => iterListings(listing('a'), listing('b')),
    });

    await handler({ site_id: 'google' });

    const jobs = listJobs(db, { site_id: 'google' });
    expect(jobs.map((j) => j.external_id).sort()).toEqual(['a', 'b']);
    expect(jobs[0]!.apply_method).toBe('manual');
    expect(jobs[0]!.external_apply_url).toMatch(/^https:\/\/gh\.io\//);
    expect(jobs[0]!.original_source).toBe('via Greenhouse');

    const pending = listPending(db).filter((p) => p.kind === 'score');
    expect(pending.length).toBe(2);
  });

  it('emits a serpapi_key_missing alert and fails fast when no key configured', async () => {
    const handler = createSearchHandler({
      db,
      bus: createEventBus(),
      browserManager: FAKE_BM,
      adapters: {},
      serpapiSearch: () => {
        throw new Error('should not be called');
      },
    });

    await expect(handler({ site_id: 'google' })).rejects.toThrow();

    const alerts = listAlerts(db, { status: 'open' });
    expect(alerts.some((a) => a.kind === 'serpapi_key_missing')).toBe(true);
  });

  it('maps SerpapiKeyInvalidError to a serpapi_key_invalid alert', async () => {
    setSerpApiKey(db, 'bad-key');
    const handler = createSearchHandler({
      db,
      bus: createEventBus(),
      browserManager: FAKE_BM,
      adapters: {},
      serpapiSearch: () => {
        // eslint-disable-next-line require-yield
        async function* boom(): AsyncIterable<GoogleJobsListing> {
          throw new SerpapiKeyInvalidError('Invalid API key');
        }
        return boom();
      },
    });

    await expect(handler({ site_id: 'google' })).rejects.toBeInstanceOf(SerpapiKeyInvalidError);
    const alerts = listAlerts(db, { status: 'open' });
    expect(alerts.some((a) => a.kind === 'serpapi_key_invalid')).toBe(true);
  });

  it('maps SerpapiQuotaExhaustedError to a serpapi_quota_exhausted alert', async () => {
    setSerpApiKey(db, 'good-but-tapped-out');
    const handler = createSearchHandler({
      db,
      bus: createEventBus(),
      browserManager: FAKE_BM,
      adapters: {},
      serpapiSearch: () => {
        // eslint-disable-next-line require-yield
        async function* boom(): AsyncIterable<GoogleJobsListing> {
          throw new SerpapiQuotaExhaustedError();
        }
        return boom();
      },
    });

    await expect(handler({ site_id: 'google' })).rejects.toBeInstanceOf(SerpapiQuotaExhaustedError);
    const alerts = listAlerts(db, { status: 'open' });
    expect(alerts.some((a) => a.kind === 'serpapi_quota_exhausted')).toBe(true);
  });

  it('quota-exhausted increments schedule consecutive_failures when schedule_id is set', async () => {
    setSerpApiKey(db, 'k');
    const { insertSchedule, findScheduleById } = await import('../../../src/db/repositories/schedules.js');
    const sched = insertSchedule(db, { cron_expression: '*/15 * * * *' });

    const handler = createSearchHandler({
      db,
      bus: createEventBus(),
      browserManager: FAKE_BM,
      adapters: {},
      serpapiSearch: () => {
        async function* boom(): AsyncIterable<GoogleJobsListing> {
          throw new SerpapiQuotaExhaustedError();
        }
        return boom();
      },
    });

    await expect(handler({ site_id: 'google', schedule_id: sched.id })).rejects.toBeInstanceOf(
      SerpapiQuotaExhaustedError,
    );
    expect(findScheduleById(db, sched.id)?.consecutive_failures).toBe(1);
  });
});
