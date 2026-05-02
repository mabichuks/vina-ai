import { describe, expect, it } from 'vitest';
import { ConflictError, newId } from '@vina/shared';
import type { Database as DatabaseType } from 'better-sqlite3';
import { deleteCv, findCvById, insertCv, setDefaultCv } from '../../../src/db/repositories/cvs.js';
import {
  insertCoverLetter,
  setDefaultCoverLetter,
  findCoverLetterById,
} from '../../../src/db/repositories/cover-letters.js';
import { freshTestDb } from '../helpers.js';

function newInput(label: string) {
  return {
    label,
    original_filename: `${label.toLowerCase()}.pdf`,
    mime_type: 'application/pdf' as const,
    file_path: `${label.toLowerCase()}.pdf`,
  };
}

function seedJobAndApp(db: DatabaseType, cvId: string) {
  db.prepare(
    `INSERT INTO jobs (id, site_id, external_id, url, apply_method, title, company, description, discovered_at, status)
     VALUES ('01J', 'linkedin', 'x', 'u', 'auto', 't', 'c', 'd', '2026-04-28T10:00:00Z', 'new')`,
  ).run();
  db.prepare(
    `INSERT INTO applications (id, job_id, cv_id, apply_method, status, started_at)
     VALUES (?, '01J', ?, 'auto', 'queued', '2026-04-28T10:00:00Z')`,
  ).run(newId(), cvId);
}

describe('cvs / cover_letters repositories', () => {
  it('only one CV is default at any time', () => {
    const db = freshTestDb();
    const a = insertCv(db, { ...newInput('A'), is_default: true });
    const b = insertCv(db, { ...newInput('B'), is_default: true });
    expect(findCvById(db, a.id)?.is_default).toBe(false);
    expect(findCvById(db, b.id)?.is_default).toBe(true);

    setDefaultCv(db, a.id);
    expect(findCvById(db, a.id)?.is_default).toBe(true);
    expect(findCvById(db, b.id)?.is_default).toBe(false);
    db.close();
  });

  it('only one cover letter is default at any time', () => {
    const db = freshTestDb();
    const a = insertCoverLetter(db, { ...newInput('A'), is_default: true });
    const b = insertCoverLetter(db, { ...newInput('B'), is_default: true });
    expect(findCoverLetterById(db, a.id)?.is_default).toBe(false);
    setDefaultCoverLetter(db, a.id);
    expect(findCoverLetterById(db, a.id)?.is_default).toBe(true);
    expect(findCoverLetterById(db, b.id)?.is_default).toBe(false);
    db.close();
  });

  it('deleteCv blocks when an application references it; succeeds otherwise', () => {
    const db = freshTestDb();
    const referenced = insertCv(db, newInput('A'));
    seedJobAndApp(db, referenced.id);
    expect(() => deleteCv(db, referenced.id)).toThrow(ConflictError);

    const orphan = insertCv(db, newInput('B'));
    deleteCv(db, orphan.id);
    expect(findCvById(db, orphan.id)).toBeNull();
    db.close();
  });
});
