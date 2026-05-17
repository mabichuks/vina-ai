import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from '@vina/shared';
import type { SaveTailoredCvInput, SaveTailoredFileResult } from '@vina/orchestrator';

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function saveTailoredCvImpl(
  dataDir: string,
): (input: SaveTailoredCvInput) => Promise<SaveTailoredFileResult> {
  return async ({ application_id, docx }) => {
    if (!SAFE_ID.test(application_id)) {
      throw new ValidationError(`invalid application_id: ${application_id}`);
    }
    const dir = path.join(dataDir, 'files', 'tailored');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${application_id}.docx`);
    fs.writeFileSync(target, docx, { mode: 0o600 });
    return { path: target };
  };
}
