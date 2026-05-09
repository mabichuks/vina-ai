import { describe, expect, it } from 'vitest';
import { freshTestDb } from '../test-helpers.js';
import { appendMessage, clearAll, listRecent } from './chat-messages.js';
import { upsertAnswer } from './profile-answers.js';

describe('chat_messages repository', () => {
  it('listRecent returns latest first, capped at the limit', () => {
    const db = freshTestDb();
    for (let i = 0; i < 60; i++) {
      appendMessage(db, { role: 'user', content: `q${i}` });
    }
    const recent = listRecent(db, 50);
    expect(recent).toHaveLength(50);
    expect(recent[0]?.content).toBe('q59');
    expect(recent[49]?.content).toBe('q10');
    db.close();
  });

  it('listRecent with beforeId paginates older messages', () => {
    const db = freshTestDb();
    for (let i = 0; i < 5; i++) {
      appendMessage(db, { role: 'user', content: `q${i}` });
    }
    const all = listRecent(db, 5);
    const before = all[1]!; // second-newest
    const older = listRecent(db, 10, before.id);
    expect(older.map((m) => m.content)).toEqual(['q2', 'q1', 'q0']);
    db.close();
  });

  it('serialises object metadata to JSON', () => {
    const db = freshTestDb();
    const msg = appendMessage(db, {
      role: 'assistant',
      content: 'Hi',
      metadata: { alert_id: '01HALERT' },
    });
    expect(msg.metadata).toBe('{"alert_id":"01HALERT"}');
    db.close();
  });

  it('clearAll truncates messages without affecting other tables', () => {
    const db = freshTestDb();
    appendMessage(db, { role: 'user', content: 'q' });
    upsertAnswer(db, 'k', 'l', 'v');
    clearAll(db);
    expect(listRecent(db, 10)).toHaveLength(0);
    // profile_answers untouched.
    expect((db.prepare(`SELECT COUNT(*) AS n FROM profile_answers`).get() as { n: number }).n).toBe(
      1,
    );
    db.close();
  });
});
