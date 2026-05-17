import type { ManualApplyToolKit } from '@vina/orchestrator';
import { saveTailoredCvImpl } from './save-tailored-cv.js';
import { saveTailoredCoverLetterImpl } from './save-tailored-cover-letter.js';

export interface ToolKitOptions {
  dataDir: string;
}

export function createManualApplyToolKit(opts: ToolKitOptions): ManualApplyToolKit {
  return {
    saveTailoredCv: saveTailoredCvImpl(opts.dataDir),
    saveTailoredCoverLetter: saveTailoredCoverLetterImpl(opts.dataDir),
  };
}
