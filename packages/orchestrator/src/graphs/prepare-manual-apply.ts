import type { StructuredScorer } from './score-job.js';
import { runTailorCv, renderTailoredDocx, type TailorCvHeader } from './tailor-cv.js';
import {
  runTailorCoverLetter,
  renderTailoredCoverLetterDocx,
  type CoverLetterHeader,
} from './tailor-cover-letter.js';
import type { ManualApplyToolKit } from '../tools/types.js';

export interface PrepareManualApplyInput {
  application_id: string;
  job: { title: string; company: string; description: string };
  cv: { text: string };
  cover_letter_template: { text: string } | null;
  user_profile: { full_name: string; email: string; bio: string | null };
}

export interface PrepareManualApplyResult {
  application_id: string;
  tailored_cv_path: string;
  tailored_cover_letter_path: string | null;
}

export class PrepareManualApplyError extends Error {
  constructor(
    public readonly stage:
      | 'tailor_cv'
      | 'tailor_cover_letter'
      | 'save_cv'
      | 'save_cover_letter',
    cause: unknown,
  ) {
    super(
      `prepare-manual-apply failed at stage=${stage}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'PrepareManualApplyError';
  }
}

export async function runPrepareManualApply(
  input: PrepareManualApplyInput,
  model: StructuredScorer,
  toolKit: ManualApplyToolKit,
): Promise<PrepareManualApplyResult> {
  // Node 1: tailor_cv
  let cvDocx: Buffer;
  try {
    const cvOut = await runTailorCv(
      {
        job: input.job,
        source_cv_text: input.cv.text,
        user_profile: {
          full_name: input.user_profile.full_name,
          bio: input.user_profile.bio,
        },
      },
      model,
    );
    const header: TailorCvHeader = {
      full_name: input.user_profile.full_name,
      email: input.user_profile.email,
    };
    cvDocx = await renderTailoredDocx(cvOut, header);
  } catch (err) {
    throw new PrepareManualApplyError('tailor_cv', err);
  }

  // Save CV. Failure here is a save-stage error, not a tailor-stage one.
  let tailored_cv_path: string;
  try {
    const saved = await toolKit.saveTailoredCv({
      application_id: input.application_id,
      docx: cvDocx,
    });
    tailored_cv_path = saved.path;
  } catch (err) {
    throw new PrepareManualApplyError('save_cv', err);
  }

  // Node 2: tailor_cover_letter (conditional on template presence).
  let tailored_cover_letter_path: string | null = null;
  if (input.cover_letter_template) {
    let clDocx: Buffer;
    try {
      const clOut = await runTailorCoverLetter(
        {
          job: input.job,
          source_template: input.cover_letter_template.text,
          user_profile: {
            full_name: input.user_profile.full_name,
            bio: input.user_profile.bio,
          },
        },
        model,
      );
      const header: CoverLetterHeader = {
        full_name: input.user_profile.full_name,
        email: input.user_profile.email,
      };
      clDocx = await renderTailoredCoverLetterDocx(clOut, header);
    } catch (err) {
      throw new PrepareManualApplyError('tailor_cover_letter', err);
    }
    try {
      const saved = await toolKit.saveTailoredCoverLetter({
        application_id: input.application_id,
        docx: clDocx,
      });
      tailored_cover_letter_path = saved.path;
    } catch (err) {
      throw new PrepareManualApplyError('save_cover_letter', err);
    }
  }

  return {
    application_id: input.application_id,
    tailored_cv_path,
    tailored_cover_letter_path,
  };
}
