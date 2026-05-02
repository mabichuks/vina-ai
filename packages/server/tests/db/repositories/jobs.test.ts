import { describe, expect, it } from 'vitest';
import {
  type JobInsertInput,
  insertJob,
  listJobs,
  updateJobScore,
} from '../../../src/db/repositories/jobs.js';
import { freshTestDb } from '../helpers.js';

function jobInput(overrides: Partial<JobInsertInput> = {}): JobInsertInput {
  return {
    site_id: 'linkedin',
    external_id: 'abc',
    url: 'https://x',
    apply_method: 'auto',
    title: 'Senior Backend',
    company: 'Acme',
    description: 'Backend role',
    ...overrides,
  };
}

describe('jobs repository', () => {
  it('insertJob dedups (site_id, external_id), returning the existing row unchanged', () => {
    const db = freshTestDb();
    const a = insertJob(db, jobInput({ external_id: 'x' }));
    const again = insertJob(db, jobInput({ external_id: 'x', title: 'IGNORED' }));
    expect(again.id).toBe(a.id);
    expect(again.title).toBe(a.title);
    expect(listJobs(db)).toHaveLength(1);
    db.close();
  });

  it('filters by apply_method, min_score, and free-text search', () => {
    const db = freshTestDb();
    const linkedinAuto = insertJob(
      db,
      jobInput({ external_id: 'a', title: 'Senior TypeScript Engineer' }),
    );
    insertJob(
      db,
      jobInput({
        external_id: 'b',
        site_id: 'google',
        apply_method: 'manual',
        external_apply_url: 'https://x.greenhouse.io/jobs/1',
        title: 'Staff Go Engineer',
        company: 'Globex',
        description: 'We use Go and Kafka.',
      }),
    );

    expect(listJobs(db, { apply_method: 'manual' })).toHaveLength(1);

    updateJobScore(db, linkedinAuto.id, 90, 'Strong');
    const highScores = listJobs(db, { min_score: 80 });
    expect(highScores.map((j) => j.id)).toEqual([linkedinAuto.id]);

    expect(listJobs(db, { search: 'kafka' }).map((j) => j.external_id)).toEqual(['b']);
    db.close();
  });
});
