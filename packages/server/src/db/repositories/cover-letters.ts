import type { Database as DatabaseType } from 'better-sqlite3';
import { NotFoundError, newId, type CoverLetter, type CoverLetterInput } from '@vina/shared';

interface CoverLetterRow {
  id: string;
  label: string;
  original_filename: string;
  mime_type: CoverLetter['mime_type'];
  file_path: string;
  extracted_text: string | null;
  is_default: number;
  created_at: string;
}

function rowToCoverLetter(row: CoverLetterRow): CoverLetter {
  return { ...row, is_default: row.is_default === 1 };
}

export function listCoverLetters(db: DatabaseType): CoverLetter[] {
  const rows = db
    .prepare(`SELECT * FROM cover_letters ORDER BY created_at DESC, id DESC`)
    .all() as CoverLetterRow[];
  return rows.map(rowToCoverLetter);
}

export function findCoverLetterById(db: DatabaseType, id: string): CoverLetter | null {
  const row = db.prepare(`SELECT * FROM cover_letters WHERE id = ?`).get(id) as
    | CoverLetterRow
    | undefined;
  return row ? rowToCoverLetter(row) : null;
}

export function insertCoverLetter(db: DatabaseType, input: CoverLetterInput): CoverLetter {
  const id = newId();
  const now = new Date().toISOString();
  const isDefault = input.is_default ? 1 : 0;

  const tx = db.transaction(() => {
    if (isDefault === 1) {
      db.prepare(`UPDATE cover_letters SET is_default = 0`).run();
    }
    db.prepare(
      `INSERT INTO cover_letters
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

  const row = findCoverLetterById(db, id);
  if (!row) {
    throw new Error('insertCoverLetter: row missing immediately after insert');
  }
  return row;
}

export function setDefaultCoverLetter(db: DatabaseType, id: string): CoverLetter {
  const cl = findCoverLetterById(db, id);
  if (!cl) throw new NotFoundError(`Cover letter ${id} not found`);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE cover_letters SET is_default = 0`).run();
    db.prepare(`UPDATE cover_letters SET is_default = 1 WHERE id = ?`).run(id);
  });
  tx();

  return { ...cl, is_default: true };
}

export function deleteCoverLetter(db: DatabaseType, id: string): void {
  const cl = findCoverLetterById(db, id);
  if (!cl) throw new NotFoundError(`Cover letter ${id} not found`);
  // applications.cover_letter_id is ON DELETE SET NULL — no conflict check needed.
  db.prepare(`DELETE FROM cover_letters WHERE id = ?`).run(id);
}
