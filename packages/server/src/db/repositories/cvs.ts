import type { Database as DatabaseType } from 'better-sqlite3';
import { ConflictError, NotFoundError, newId, type Cv, type CvInput } from '@vina/shared';

interface CvRow {
  id: string;
  label: string;
  original_filename: string;
  mime_type: Cv['mime_type'];
  file_path: string;
  extracted_text: string | null;
  is_default: number;
  created_at: string;
}

function rowToCv(row: CvRow): Cv {
  return { ...row, is_default: row.is_default === 1 };
}

export function listCvs(db: DatabaseType): Cv[] {
  const rows = db.prepare(`SELECT * FROM cvs ORDER BY created_at DESC, id DESC`).all() as CvRow[];
  return rows.map(rowToCv);
}

export function findCvById(db: DatabaseType, id: string): Cv | null {
  const row = db.prepare(`SELECT * FROM cvs WHERE id = ?`).get(id) as CvRow | undefined;
  return row ? rowToCv(row) : null;
}

export function insertCv(db: DatabaseType, input: CvInput): Cv {
  const id = newId();
  const now = new Date().toISOString();
  // Auto-promote the first ever CV (or the next one if no current default
  // exists) so the manual-apply pipeline always has something to point at.
  // Without this an upload that doesn't explicitly set is_default leaves the
  // user with CVs but no default — the handler then says "no CV" misleadingly.
  const hasAnyDefault =
    (db.prepare(`SELECT 1 FROM cvs WHERE is_default = 1 LIMIT 1`).get() as unknown) !== undefined;
  const isDefault = input.is_default || !hasAnyDefault ? 1 : 0;

  const tx = db.transaction(() => {
    if (isDefault === 1) {
      db.prepare(`UPDATE cvs SET is_default = 0`).run();
    }
    db.prepare(
      `INSERT INTO cvs
         (id, label, original_filename, mime_type, file_path, extracted_text, is_default, created_at)
       VALUES (@id, @label, @original_filename, @mime_type, @file_path, @extracted_text, @is_default, @created_at)`,
    ).run({
      id,
      label: input.label,
      original_filename: input.original_filename,
      mime_type: input.mime_type,
      file_path: input.file_path,
      extracted_text: input.extracted_text ?? null,
      is_default: isDefault,
      created_at: now,
    });
  });
  tx();

  const row = findCvById(db, id);
  if (!row) throw new Error('insertCv: row missing immediately after insert');
  return row;
}

export function updateCv(
  db: DatabaseType,
  id: string,
  patch: Partial<Pick<CvInput, 'label' | 'extracted_text'>>,
): Cv {
  const current = findCvById(db, id);
  if (!current) throw new NotFoundError(`CV ${id} not found`);

  const next = { ...current, ...patch };
  db.prepare(`UPDATE cvs SET label = ?, extracted_text = ? WHERE id = ?`).run(
    next.label,
    next.extracted_text,
    id,
  );
  return next;
}

/** Set the default CV. Atomic — clears all `is_default` then sets the target. */
export function setDefaultCv(db: DatabaseType, id: string): Cv {
  const cv = findCvById(db, id);
  if (!cv) throw new NotFoundError(`CV ${id} not found`);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE cvs SET is_default = 0`).run();
    db.prepare(`UPDATE cvs SET is_default = 1 WHERE id = ?`).run(id);
  });
  tx();

  return { ...cv, is_default: true };
}

/**
 * Deletes a CV. Throws ConflictError if any application references it
 * (foreign key is RESTRICT in the schema).
 */
export function deleteCv(db: DatabaseType, id: string): void {
  const cv = findCvById(db, id);
  if (!cv) throw new NotFoundError(`CV ${id} not found`);

  const refCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM applications WHERE cv_id = ?`).get(id) as {
      n: number;
    }
  ).n;
  if (refCount > 0) {
    throw new ConflictError(
      `CV ${id} is referenced by ${refCount} application(s)`,
      { application_count: refCount },
      'cv_in_use',
    );
  }
  db.prepare(`DELETE FROM cvs WHERE id = ?`).run(id);
}
