import { describe, expect, it } from 'vitest';
import { appendMessage, clearAll, listRecent } from '../../../src/db/repositories/chat-messages.js';
import { upsertAnswer } from '../../../src/db/repositories/profile-answers.js';
import { freshTestDb } from '../helpers.js';

describe('chat_messages repository', () => {
  it('listRecent returns latest first, capped at the limit', () => {
    const db = freshTestDb();
    for (let i = 0; i < 60; i++) appendMessage(db, { role: 'user', content: `q${i}` });

    const recent = listRecent(db, 50);
    expect(recent).toHaveLength(50);
    expect(recent[0]?.content).toBe('q59');
    expect(recent[49]?.content).toBe('q10');
    db.close();
  });

  it('paginates older messages stably even when timestamps share a millisecond', () => {
    const db = freshTestDb();
    for (let i = 0; i < 5; i++) appendMessage(db, { role: 'user', content: `q${i}` });
    const all = listRecent(db, 5);
    const older = listRecent(db, 10, all[1]!.id);
    expect(older.map((m) => m.content)).toEqual(['q2', 'q1', 'q0']);
    db.close();
  });

  it('clearAll truncates messages without affecting other tables', () => {
    const db = freshTestDb();
    appendMessage(db, { role: 'user', content: 'q' });
    upsertAnswer(db, 'k', 'l', 'v');
    clearAll(db);
    expect(listRecent(db, 10)).toHaveLength(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM profile_answers`).get() as { n: number }).n).toBe(
      1,
    );
    db.close();
  });
});
