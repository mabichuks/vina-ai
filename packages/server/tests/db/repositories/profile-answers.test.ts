import { describe, expect, it } from 'vitest';
import {
  deleteAnswer,
  findAnswer,
  upsertAnswer,
} from '../../../src/db/repositories/profile-answers.js';
import { freshTestDb } from '../helpers.js';

describe('profile_answers repository', () => {
  it('upsert inserts on first call, updates on second, bumps updated_at', async () => {
    const db = freshTestDb();
    const first = upsertAnswer(db, 'years_of_experience', 'Years', '8');
    await new Promise((r) => setTimeout(r, 5));
    const second = upsertAnswer(db, 'years_of_experience', 'Years', '9');
    expect(second.value).toBe('9');
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at).not.toBe(first.updated_at);
    db.close();
  });

  it('delete returns true once, false thereafter', () => {
    const db = freshTestDb();
    upsertAnswer(db, 'k', 'l', 'v');
    expect(deleteAnswer(db, 'k')).toBe(true);
    expect(findAnswer(db, 'k')).toBeNull();
    expect(deleteAnswer(db, 'k')).toBe(false);
    db.close();
  });
});
