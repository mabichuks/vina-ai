import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, newId } from '@vina/shared';
import type { Database as DatabaseType } from 'better-sqlite3';
import { freshTestDb } from '../test-helpers.js';
import { deleteCv, findCvById, insertCv, listCvs, setDefaultCv, updateCv } from './cvs.js';

function newCvInput(label = 'Default') {
  return {
    label,
    original_filename: `${label.toLowerCase()}.pdf`,
    mime_type: 'application/pdf' as const,
    file_path: `cvs/${label.toLowerCase()}.pdf`,
  };
}

function seedJobAndApp(db: DatabaseType, cvId: string): string {
  db.prepare(
    `INSERT INTO jobs (id, site_id, external_id, url, apply_method,
                       title, company, description, discovered_at, status)
     VALUES ('01J', 'linkedin', 'x', 'u', 'auto', 't', 'c', 'd', '2026-04-28T10:00:00Z', 'new')`,
  ).run();
  const appId = newId();
  db.prepare(
    `INSERT INTO applications (id, job_id, cv_id, apply_method, status, started_at)
     VALUES (?, '01J', ?, 'auto', 'queued', '2026-04-28T10:00:00Z')`,
  ).run(appId, cvId);
  return appId;
}

describe('cvs repository', () => {
  it('insert + find + list', () => {
    const db = freshTestDb();
    const inserted = insertCv(db, newCvInput('A'));
    expect(findCvById(db, inserted.id)).toEqual(inserted);
    expect(listCvs(db)).toHaveLength(1);
    db.close();
  });

  it('only one CV is default at a time', () => {
    const db = freshTestDb();
    const a = insertCv(db, { ...newCvInput('A'), is_default: true });
    const b = insertCv(db, { ...newCvInput('B'), is_default: true });

    expect(findCvById(db, a.id)?.is_default).toBe(false);
    expect(findCvById(db, b.id)?.is_default).toBe(true);

    setDefaultCv(db, a.id);
    expect(findCvById(db, a.id)?.is_default).toBe(true);
    expect(findCvById(db, b.id)?.is_default).toBe(false);

    const defaults = listCvs(db).filter((c) => c.is_default);
    expect(defaults).toHaveLength(1);
    db.close();
  });

  it('updateCv changes label without touching is_default', () => {
    const db = freshTestDb();
    const cv = insertCv(db, { ...newCvInput('A'), is_default: true });
    const updated = updateCv(db, cv.id, { label: 'A renamed' });
    expect(updated.label).toBe('A renamed');
    expect(updated.is_default).toBe(true);
    db.close();
  });

  it('deleteCv errors with ConflictError when an application references it', () => {
    const db = freshTestDb();
    const cv = insertCv(db, newCvInput('A'));
    seedJobAndApp(db, cv.id);
    expect(() => deleteCv(db, cv.id)).toThrow(ConflictError);
    db.close();
  });

  it('deleteCv removes a row that is unreferenced', () => {
    const db = freshTestDb();
    const cv = insertCv(db, newCvInput('A'));
    deleteCv(db, cv.id);
    expect(findCvById(db, cv.id)).toBeNull();
    db.close();
  });

  it('setDefaultCv on missing id throws NotFoundError', () => {
    const db = freshTestDb();
    expect(() => setDefaultCv(db, 'absent')).toThrow(NotFoundError);
    db.close();
  });
});
