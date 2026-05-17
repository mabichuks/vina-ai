import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from '@vina/shared';
import type {
  SaveTailoredCoverLetterInput,
  SaveTailoredFileResult,
} from '@vina/orchestrator';

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function writer(
  subdir: string,
  extension: 'docx' | 'pdf',
  dataDir: string,
): (input: SaveTailoredCoverLetterInput) => Promise<SaveTailoredFileResult> {
  return async ({ application_id, docx }) => {
    if (!SAFE_ID.test(application_id)) {
      throw new ValidationError(`invalid application_id: ${application_id}`);
    }
    const dir = path.join(dataDir, 'files', subdir);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${application_id}.${extension}`);
    fs.writeFileSync(target, docx, { mode: 0o600 });
    return { path: target };
  };
}

export function saveTailoredCoverLetterImpl(
  dataDir: string,
): (input: SaveTailoredCoverLetterInput) => Promise<SaveTailoredFileResult> {
  return writer('tailored-cover-letters', 'docx', dataDir);
}

export function saveTailoredCoverLetterPdfImpl(
  dataDir: string,
): (input: SaveTailoredCoverLetterInput) => Promise<SaveTailoredFileResult> {
  return writer('tailored-cover-letters-pdf', 'pdf', dataDir);
}
