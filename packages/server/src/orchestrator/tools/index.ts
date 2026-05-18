import type { ManualApplyToolKit } from '@vina/orchestrator';
import {
  saveTailoredCvImpl,
  saveTailoredCvPdfImpl,
} from './save-tailored-cv.js';
import {
  saveTailoredCoverLetterImpl,
  saveTailoredCoverLetterPdfImpl,
} from './save-tailored-cover-letter.js';

export interface ToolKitOptions {
  dataDir: string;
}

export function createManualApplyToolKit(opts: ToolKitOptions): ManualApplyToolKit {
  return {
    saveTailoredCv: saveTailoredCvImpl(opts.dataDir),
    saveTailoredCoverLetter: saveTailoredCoverLetterImpl(opts.dataDir),
    saveTailoredCvPdf: saveTailoredCvPdfImpl(opts.dataDir),
    saveTailoredCoverLetterPdf: saveTailoredCoverLetterPdfImpl(opts.dataDir),
  };
}
