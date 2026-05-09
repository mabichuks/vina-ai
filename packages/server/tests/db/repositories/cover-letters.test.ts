import { describe, expect, it } from 'vitest';
import {
  deleteCoverLetter,
  findCoverLetterById,
  insertCoverLetter,
  listCoverLetters,
  setDefaultCoverLetter,
} from '../../../src/db/repositories/cover-letters.js';
import { freshTestDb } from '../helpers.js';

function newInput(label = 'Default') {
  return {
    label,
    original_filename: `${label.toLowerCase()}.pdf`,
    mime_type: 'application/pdf' as const,
    file_path: `cl/${label.toLowerCase()}.pdf`,
  };
}

describe('cover_letters repository', () => {
  it('insert + list + find', () => {
    const db = freshTestDb();
    const a = insertCoverLetter(db, newInput('A'));
    expect(findCoverLetterById(db, a.id)).toEqual(a);
    expect(listCoverLetters(db)).toHaveLength(1);
    db.close();
  });

  it('only one default at a time', () => {
    const db = freshTestDb();
    const a = insertCoverLetter(db, { ...newInput('A'), is_default: true });
    const b = insertCoverLetter(db, { ...newInput('B'), is_default: true });
    expect(findCoverLetterById(db, a.id)?.is_default).toBe(false);
    expect(findCoverLetterById(db, b.id)?.is_default).toBe(true);

    setDefaultCoverLetter(db, a.id);
    expect(findCoverLetterById(db, a.id)?.is_default).toBe(true);
    expect(findCoverLetterById(db, b.id)?.is_default).toBe(false);
    db.close();
  });

  it('delete removes the row', () => {
    const db = freshTestDb();
    const a = insertCoverLetter(db, newInput('A'));
    deleteCoverLetter(db, a.id);
    expect(findCoverLetterById(db, a.id)).toBeNull();
    db.close();
  });
});
