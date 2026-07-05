import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  runPrepareManualApply,
  type ManualApplyToolKit,
  type PromptLoader,
  type StructuredScorer,
} from '@vina/orchestrator';
import { ConflictError, createLogger, NotFoundError } from '@vina/shared';
import {
  findApplicationById,
  setApplicationTailored,
} from '../../db/repositories/applications.js';
import { findJobById } from '../../db/repositories/jobs.js';
import { findCvById } from '../../db/repositories/cvs.js';
import { findCoverLetterById } from '../../db/repositories/cover-letters.js';
import { findProfile } from '../../db/repositories/profile.js';
import { insertAlert } from '../../db/repositories/alerts.js';
import type { EventBus } from '../../events/bus.js';

const log = createLogger('handler.prepare_manual_apply');

export interface PrepareManualApplyHandlerDeps {
  db: DatabaseType;
  bus: EventBus;
  buildModel: () => Promise<BaseChatModel>;
  toolKit: ManualApplyToolKit;
  /** Optional — user-override-aware loader. Falls back to packaged defaults. */
  promptLoader?: PromptLoader;
}

export interface PrepareManualApplyPayload {
  application_id: string;
}

export function createPrepareManualApplyHandler(
  deps: PrepareManualApplyHandlerDeps,
): (payload: PrepareManualApplyPayload) => Promise<void> {
  return async (payload) => {
    const app = findApplicationById(deps.db, payload.application_id);
    if (!app) throw new NotFoundError(`Application ${payload.application_id} not found`);

    const job = findJobById(deps.db, app.job_id);
    if (!job) throw new NotFoundError(`Job ${app.job_id} not found`);

    const cv = findCvById(deps.db, app.cv_id);
    if (!cv) throw new ConflictError('Application has no CV — upload one in Profile first');

    const coverLetter = app.cover_letter_id
      ? findCoverLetterById(deps.db, app.cover_letter_id)
      : null;

    const profile = findProfile(deps.db);
    if (!profile) throw new ConflictError('Profile not configured — cannot tailor');

    const model = await deps.buildModel();

    const result = await runPrepareManualApply(
      {
        application_id: app.id,
        job: {
          title: job.title,
          company: job.company,
          description: job.description,
        },
        cv: { text: cv.extracted_text ?? '' },
        cover_letter_template:
          coverLetter && coverLetter.extracted_text
            ? { text: coverLetter.extracted_text }
            : null,
        user_profile: {
          full_name: profile.full_name,
          email: profile.email,
          bio: profile.bio,
        },
      },
      model as unknown as StructuredScorer,
      deps.toolKit,
      deps.promptLoader ? { promptLoader: deps.promptLoader } : {},
    );

    const external_apply_url = job.external_apply_url ?? job.url;

    deps.db.transaction(() => {
      setApplicationTailored(deps.db, app.id, {
        tailored_cv_path: result.tailored_cv_path,
        tailored_cover_letter_path: result.tailored_cover_letter_path,
        tailored_cv_pdf_path: result.tailored_cv_pdf_path,
        tailored_cover_letter_pdf_path: result.tailored_cover_letter_pdf_path,
        tailored_at: new Date().toISOString(),
        new_status: 'ready_for_manual_apply',
      });

      insertAlert(deps.db, {
        kind: 'ready_for_manual_apply',
        severity: 'action_required',
        title: `Tailored materials ready for ${job.title} @ ${job.company}`,
        description: 'Download the tailored CV and apply externally, then mark applied.',
        application_id: app.id,
        payload: {
          application_id: app.id,
          job_id: job.id,
          external_apply_url,
          tailored_cv_path: result.tailored_cv_path,
          tailored_cover_letter_path: result.tailored_cover_letter_path,
        },
      });
    })();

    deps.bus.emit('application:ready_for_manual_apply', {
      application_id: app.id,
      job_id: job.id,
      external_apply_url,
      tailored_cv_path: result.tailored_cv_path,
      tailored_cover_letter_path: result.tailored_cover_letter_path,
    });
    deps.bus.emit('jobs:updated', { ids: [job.id] });

    log.info(
      {
        application_id: app.id,
        cv_path: result.tailored_cv_path,
        cover_letter: !!result.tailored_cover_letter_path,
      },
      'manual-apply preparation complete',
    );
  };
}
