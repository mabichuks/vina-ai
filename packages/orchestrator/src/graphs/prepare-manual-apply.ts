import type { StructuredScorer } from './score-job.js';
import {
  runTailorCv,
  renderTailoredDocx,
  renderTailoredPdf,
  type TailorCvHeader,
} from './tailor-cv.js';
import {
  runTailorCoverLetter,
  renderTailoredCoverLetterDocx,
  renderTailoredCoverLetterPdf,
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
  tailored_cv_pdf_path: string;
  tailored_cover_letter_pdf_path: string | null;
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
  // Node 1: tailor_cv — single LLM call, two deterministic renders. We render
  // DOCX and PDF in parallel from the same structured output so the user gets
  // both download formats without a second model round-trip.
  let cvDocx: Buffer;
  let cvPdf: Buffer;
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
    [cvDocx, cvPdf] = await Promise.all([
      renderTailoredDocx(cvOut, header),
      renderTailoredPdf(cvOut, header),
    ]);
  } catch (err) {
    throw new PrepareManualApplyError('tailor_cv', err);
  }

  // Save CV (both formats). Failure here is a save-stage error.
  let tailored_cv_path: string;
  let tailored_cv_pdf_path: string;
  try {
    const [docxResult, pdfResult] = await Promise.all([
      toolKit.saveTailoredCv({ application_id: input.application_id, docx: cvDocx }),
      toolKit.saveTailoredCvPdf({ application_id: input.application_id, docx: cvPdf }),
    ]);
    tailored_cv_path = docxResult.path;
    tailored_cv_pdf_path = pdfResult.path;
  } catch (err) {
    throw new PrepareManualApplyError('save_cv', err);
  }

  // Node 2: tailor_cover_letter (conditional on template presence).
  let tailored_cover_letter_path: string | null = null;
  let tailored_cover_letter_pdf_path: string | null = null;
  if (input.cover_letter_template) {
    let clDocx: Buffer;
    let clPdf: Buffer;
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
      [clDocx, clPdf] = await Promise.all([
        renderTailoredCoverLetterDocx(clOut, header),
        renderTailoredCoverLetterPdf(clOut, header),
      ]);
    } catch (err) {
      throw new PrepareManualApplyError('tailor_cover_letter', err);
    }
    try {
      const [docxResult, pdfResult] = await Promise.all([
        toolKit.saveTailoredCoverLetter({
          application_id: input.application_id,
          docx: clDocx,
        }),
        toolKit.saveTailoredCoverLetterPdf({
          application_id: input.application_id,
          docx: clPdf,
        }),
      ]);
      tailored_cover_letter_path = docxResult.path;
      tailored_cover_letter_pdf_path = pdfResult.path;
    } catch (err) {
      throw new PrepareManualApplyError('save_cover_letter', err);
    }
  }

  return {
    application_id: input.application_id,
    tailored_cv_path,
    tailored_cover_letter_path,
    tailored_cv_pdf_path,
    tailored_cover_letter_pdf_path,
  };
}
