import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ScoreMessages, StructuredScorer } from '@vina/orchestrator';
import { findJobById, insertJob } from '../../src/db/repositories/jobs.js';
import { insertProfile } from '../../src/db/repositories/profile.js';
import { upsertSearchPreferences } from '../../src/db/repositories/search-preferences.js';
import { enqueue } from '../../src/db/repositories/task-queue.js';
import { createEventBus } from '../../src/events/bus.js';
import { createSearchHandler } from '../../src/queue/handlers/search.js';
import { createScoreHandler } from '../../src/queue/handlers/score.js';
import { createWorker, type TaskHandler, type TaskHandlers } from '../../src/queue/worker.js';
import { freshTestDb } from '../db/helpers.js';

function fakeScorer(score: number): StructuredScorer {
  return {
    withStructuredOutput: () => ({
      invoke: async (_m: ScoreMessages) => ({ score, justification: 'ok' }),
    }) as never,
  };
}

const adapt = <P>(h: (p: P) => Promise<void>): TaskHandler => (p) => h(p as P);

let db: DatabaseType;
beforeEach(() => {
  db = freshTestDb();
  insertProfile(db, { full_name: 'Ada', email: 'ada@x.com', bio: 'Engineer' });
  upsertSearchPreferences(db, {
    description: 'TS backend',
    keywords: ['typescript'],
    locations: ['Remote'],
    work_models: ['remote'],
    seniority: ['senior'],
    excluded_companies: [],
  });
});
afterEach(() => db.close());

describe('M10 pipeline', () => {
  it('fake job + score task → match_score updated end-to-end', async () => {
    const bus = createEventBus();
    const job = insertJob(db, {
      site_id: 'linkedin',
      external_id: 'fake-1',
      url: 'https://x',
      apply_method: 'auto',
      title: 'Senior TS Engineer',
      company: 'Acme',
      description: 'TS backend role',
    });

    const handlers: TaskHandlers = {
      search: adapt(createSearchHandler({ db, bus })),
      score: adapt(
        createScoreHandler({
          db,
          bus,
          buildModel: async () => fakeScorer(77) as unknown as BaseChatModel,
        }),
      ),
    };
    const worker = createWorker({ db, bus, handlers, pollIntervalMs: 5 });

    enqueue(db, { kind: 'score', payload: { job_id: job.id } });
    worker.start();
    await vi.waitFor(
      () => {
        const fresh = findJobById(db, job.id);
        expect(fresh?.match_score).toBe(77);
        expect(fresh?.status).toBe('scored');
      },
      { timeout: 2_000, interval: 25 },
    );
    await worker.stop();
  });
});
