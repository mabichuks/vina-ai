import fs from 'node:fs';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { newId, ValidationError, type Cv } from '@vina/shared';
import { insertCv as insertCvRow, updateCv } from '../db/repositories/cvs.js';
import { extractTextFromBuffer } from './extract-text.js';

export type AcceptedMime =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const ACCEPTED_MIMES: ReadonlySet<string> = new Set<AcceptedMime>([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

/**
 * Strip path separators and collapse anything that isn't alphanumeric / dot
 * / dash / underscore. Prevents directory traversal and weird edge cases.
 */
export function sanitiseFilename(input: string): string {
  // Take the basename — drops any leading directory components.
  const base = input.replace(/^.*[/\\]/, '');
  // Replace anything not in the safe set with `_`.
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'file';
}

export interface UploadCvInput {
  label: string;
  original_filename: string;
  mime_type: string;
  buffer: Buffer;
  is_default?: boolean;
}

/**
 * Persist an uploaded CV to disk + DB, then run text extraction in the
 * background-ish (we await but don't block the row insert on it).
 */
export async function uploadCv(
  db: DatabaseType,
  filesDir: string,
  input: UploadCvInput,
): Promise<Cv> {
  if (!ACCEPTED_MIMES.has(input.mime_type)) {
    throw new ValidationError(
      `Unsupported mime type: ${input.mime_type}`,
      undefined,
      'unsupported_mime',
    );
  }

  const id = newId();
  const safeName = sanitiseFilename(input.original_filename);
  const relPath = path.join('cvs', `${id}_${safeName}`);
  const absPath = path.join(filesDir, relPath);

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, input.buffer);

  const row = insertCvRow(db, {
    label: input.label,
    original_filename: safeName,
    mime_type: input.mime_type as AcceptedMime,
    file_path: relPath,
    is_default: input.is_default,
  });

  // PRD-075/076: extraction failure must not error the upload.
  const text = await extractTextFromBuffer(input.buffer, input.mime_type);
  if (text) {
    return updateCv(db, row.id, { extracted_text: text });
  }
  return row;
}

/** Resolve a CV row's stored relative path to an absolute on-disk path. */
export function resolveCvPath(filesDir: string, row: Cv): string {
  return path.join(filesDir, row.file_path);
}
