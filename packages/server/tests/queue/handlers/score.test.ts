import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { ScoreMessages, StructuredScorer } from '@vina/orchestrator';
import { ScoreSchema } from '@vina/orchestrator';
import { NotFoundError } from '@vina/shared';
import { findJobById, insertJob } from '../../../src/db/repositories/jobs.js';
import { insertProfile } from '../../../src/db/repositories/profile.js';
import { upsertSearchPreferences } from '../../../src/db/repositories/search-preferences.js';
import { createEventBus } from '../../../src/events/bus.js';
import { createScoreHandler } from '../../../src/queue/handlers/score.js';
import { freshTestDb } from '../../db/helpers.js';

function fakeScorer(score: number, justification = 'fake'): StructuredScorer {
  return {
    withStructuredOutput: () => ({
      invoke: async (_messages: ScoreMessages) => {
        ScoreSchema.parse({ score, justification }); // sanity
        return { score, justification };
      },
    }) as never,
  };
}

let db: DatabaseType;
beforeEach(() => {
  db = freshTestDb();
  insertProfile(db, { full_name: 'Ada Lovelace', email: 'ada@x.com', bio: 'Engineer' });
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

describe('score handler', () => {
  it('writes match_score + justification and transitions status to scored', async () => {
    const job = insertJob(db, {
      site_id: 'linkedin',
      external_id: 'ext1',
      url: 'https://x',
      apply_method: 'auto',
      title: 'Senior TS Engineer',
      company: 'Acme',
      description: 'TS backend role',
    });

    const handler = createScoreHandler({
      db,
      bus: createEventBus(),
      buildModel: async () => fakeScorer(82, 'Strong title and skill match'),
    });

    await handler({ job_id: job.id });

    const fresh = findJobById(db, job.id);
    expect(fresh?.match_score).toBe(82);
    expect(fresh?.match_justification).toBe('Strong title and skill match');
    expect(fresh?.status).toBe('scored');
  });

  it('clamps + rounds out-of-range model output before persisting', async () => {
    const job = insertJob(db, {
      site_id: 'linkedin',
      external_id: 'ext2',
      url: 'https://x',
      apply_method: 'auto',
      title: 'Junior dev',
      company: 'Acme',
      description: 'Junior',
    });

    const handler = createScoreHandler({
      db,
      bus: createEventBus(),
      buildModel: async () => fakeScorer(150, 'over'),
    });

    await handler({ job_id: job.id });
    expect(findJobById(db, job.id)?.match_score).toBe(100);
  });

  it('throws if the job no longer exists', async () => {
    const handler = createScoreHandler({
      db,
      bus: createEventBus(),
      buildModel: async () => fakeScorer(50),
    });
    await expect(handler({ job_id: 'missing' })).rejects.toThrow(NotFoundError);
  });
});
