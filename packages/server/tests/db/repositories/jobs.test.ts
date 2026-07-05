import { describe, expect, it } from 'vitest';
import {
  type JobInsertInput,
  countJobs,
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
    // `min_score` keeps unscored rows (NULL match_score) in the worklist as
    // "Scoring…" placeholders; only already-scored rows are filtered against
    // the threshold. See jobs.ts:64-66.
    const highScores = listJobs(db, { min_score: 80 });
    const scoredIds = highScores.filter((j) => j.match_score !== null).map((j) => j.id);
    expect(scoredIds).toEqual([linkedinAuto.id]);

    expect(listJobs(db, { search: 'kafka' }).map((j) => j.external_id)).toEqual(['b']);
    db.close();
  });

  it('countJobs applies the same filters as listJobs', () => {
    const db = freshTestDb();
    insertJob(db, jobInput({ external_id: 'c1', status: 'scored' }));
    insertJob(db, jobInput({ external_id: 'c2', status: 'scored' }));
    insertJob(db, jobInput({ external_id: 'c3', status: 'scored' }));
    insertJob(db, jobInput({ external_id: 'c4', status: 'scored' }));
    // Give three of them a high score and one a low score
    const jobs = listJobs(db, { status: 'scored' });
    updateJobScore(db, jobs[0]!.id, 80, 'ok');
    updateJobScore(db, jobs[1]!.id, 85, 'ok');
    updateJobScore(db, jobs[2]!.id, 90, 'ok');
    updateJobScore(db, jobs[3]!.id, 30, 'low');
    expect(countJobs(db, { status: 'scored', min_score: 70 })).toBe(3);
    expect(countJobs(db, {})).toBe(4);
    db.close();
  });
});
