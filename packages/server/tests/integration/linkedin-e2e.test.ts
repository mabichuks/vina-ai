import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ScoreMessages, StructuredScorer } from '@vina/orchestrator';
import {
  createBrowserManager,
  linkedInAdapter,
  type BrowserManagerHandle,
} from '@vina/automation';
import { startLinkedInFixture } from '../../../../tests/fixtures/sites/linkedin/server.js';
import type { FixtureServerHandle } from '../../../../tests/fixtures/start-server.js';
import { findJobById, listJobs, updateJobStatus } from '../../src/db/repositories/jobs.js';
import { listPending } from '../../src/db/repositories/task-queue.js';
import { insertCv } from '../../src/db/repositories/cvs.js';
import { insertProfile } from '../../src/db/repositories/profile.js';
import { upsertSearchPreferences } from '../../src/db/repositories/search-preferences.js';
import { createEventBus } from '../../src/events/bus.js';
import { createSearchHandler } from '../../src/queue/handlers/search.js';
import { createScoreHandler } from '../../src/queue/handlers/score.js';
import { freshTestDb } from '../db/helpers.js';

function fakeScorer(score: number): StructuredScorer {
  return {
    withStructuredOutput: () => ({
      invoke: async (_messages: ScoreMessages) => ({
        score,
        justification: 'Strong match.',
      }),
    }) as never,
  };
}

let fixture: FixtureServerHandle;
beforeAll(async () => {
  fixture = await startLinkedInFixture();
});
afterAll(async () => {
  await fixture.close();
});

let db: DatabaseType;
let dataDir: string;
let bm: BrowserManagerHandle;
beforeEach(() => {
  db = freshTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-e2e-'));
  bm = createBrowserManager({ dataDir });
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
});
afterEach(async () => {
  await bm.closeAll();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('LinkedIn slice end-to-end', () => {
  it('search → score → applied flow against the fixture', async () => {
    const bus = createEventBus();

    const searchHandler = createSearchHandler({
      db,
      bus,
      browserManager: bm,
      adapters: { linkedin: linkedInAdapter },
      feedUrlOverride: `${fixture.url}/feed`,
    });

    await searchHandler({ site_id: 'linkedin' });

    const jobs = listJobs(db, { site_id: 'linkedin' });
    expect(jobs.length).toBeGreaterThan(0);

    const scoreHandler = createScoreHandler({
      db,
      bus,
      buildModel: async () => fakeScorer(85) as unknown as BaseChatModel,
    });
    for (const t of listPending(db).filter((p) => p.kind === 'score')) {
      await scoreHandler(JSON.parse(t.payload) as { job_id: string });
    }

    const scoredJobs = listJobs(db, { status: 'scored' });
    expect(scoredJobs.length).toBe(jobs.length);
    expect(scoredJobs[0]!.match_score).toBe(85);

    // User clicks Mark applied → /applied flips to applied_manually
    updateJobStatus(db, scoredJobs[0]!.id, 'applied_manually');
    expect(findJobById(db, scoredJobs[0]!.id)?.status).toBe('applied_manually');
  }, 90_000);
});
