import fs from 'node:fs';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { newId, ValidationError, type CoverLetter } from '@vina/shared';
import { insertCoverLetter as insertRow } from '../db/repositories/cover-letters.js';
import { extractTextFromBuffer } from './extract-text.js';
import { sanitiseFilename, type AcceptedMime } from './cv-service.js';

const ACCEPTED_MIMES: ReadonlySet<string> = new Set<AcceptedMime>([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export interface UploadCoverLetterInput {
  label: string;
  original_filename: string;
  mime_type: string;
  buffer: Buffer;
  is_default?: boolean;
}

export async function uploadCoverLetter(
  db: DatabaseType,
  filesDir: string,
  input: UploadCoverLetterInput,
): Promise<CoverLetter> {
  if (!ACCEPTED_MIMES.has(input.mime_type)) {
    throw new ValidationError(
      `Unsupported mime type: ${input.mime_type}`,
      undefined,
      'unsupported_mime',
    );
  }

  const id = newId();
  const safeName = sanitiseFilename(input.original_filename);
  const relPath = path.join('cover-letters', `${id}_${safeName}`);
  const absPath = path.join(filesDir, relPath);

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, input.buffer);

  const text = await extractTextFromBuffer(input.buffer, input.mime_type);

  return insertRow(db, {
    label: input.label,
    original_filename: safeName,
    mime_type: input.mime_type as AcceptedMime,
    file_path: relPath,
    extracted_text: text || undefined,
    is_default: input.is_default,
  });
}

export function resolveCoverLetterPath(filesDir: string, row: CoverLetter): string {
  return path.join(filesDir, row.file_path);
}
