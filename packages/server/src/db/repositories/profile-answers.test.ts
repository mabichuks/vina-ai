import { describe, expect, it } from 'vitest';
import { freshTestDb } from '../test-helpers.js';
import { deleteAnswer, findAnswer, listAnswers, upsertAnswer } from './profile-answers.js';

describe('profile_answers repository', () => {
  it('upsert inserts when key is new', () => {
    const db = freshTestDb();
    const a = upsertAnswer(db, 'years_of_experience', 'Years of experience', '8');
    expect(a.value).toBe('8');
    expect(findAnswer(db, 'years_of_experience')).toEqual(a);
    db.close();
  });

  it('upsert updates when key exists and bumps updated_at', async () => {
    const db = freshTestDb();
    const first = upsertAnswer(db, 'years_of_experience', 'Years', '8');
    await new Promise((r) => setTimeout(r, 5));
    const second = upsertAnswer(db, 'years_of_experience', 'Years', '9');
    expect(second.value).toBe('9');
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at).not.toBe(first.updated_at);
    db.close();
  });

  it('list returns alphabetical-by-key', () => {
    const db = freshTestDb();
    upsertAnswer(db, 'years_of_experience', 'Y', '8');
    upsertAnswer(db, 'salary_expectation', 'S', '£100k');
    upsertAnswer(db, 'work_authorization_uk', 'W', 'yes');
    expect(listAnswers(db).map((a) => a.key)).toEqual([
      'salary_expectation',
      'work_authorization_uk',
      'years_of_experience',
    ]);
    db.close();
  });

  it('delete removes the row', () => {
    const db = freshTestDb();
    upsertAnswer(db, 'k', 'l', 'v');
    expect(deleteAnswer(db, 'k')).toBe(true);
    expect(findAnswer(db, 'k')).toBeNull();
    expect(deleteAnswer(db, 'k')).toBe(false);
    db.close();
  });
});
