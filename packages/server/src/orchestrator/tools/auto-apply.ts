import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  resolveFieldValue,
  type ApplicationSession,
  type BrowserManagerHandle,
  type FormField as AutomationFormField,
  type Page,
  type RawListing,
  type SiteAdapter,
  type SubmitResult,
} from '@vina/automation';
import type {
  AutoApplyToolKit,
  FieldResolution,
  JobSlice,
  NewAlertInput,
  SubmitOutcome,
} from '@vina/orchestrator';

// Orchestrator's FormField is structurally identical to automation's; pin a
// local alias so the rest of this file reads naturally.
type FormField = AutomationFormField;
import {
  renderTailoredDocx,
  renderTailoredPdf,
  runTailorCv,
  type StructuredScorer,
} from '@vina/orchestrator';
import { ConflictError, NotFoundError, createLogger } from '@vina/shared';
import { findApplicationById, setApplicationTailored } from '../../db/repositories/applications.js';
import { findJobById } from '../../db/repositories/jobs.js';
import { findCvById } from '../../db/repositories/cvs.js';
import { findProfile } from '../../db/repositories/profile.js';
import { listAnswers } from '../../db/repositories/profile-answers.js';
import { getOrInitSettings } from '../../db/repositories/settings.js';
import { insertAlert } from '../../db/repositories/alerts.js';
import type { ManualApplyToolKit } from '@vina/orchestrator';

const log = createLogger('auto-apply-toolkit');

export interface CreateAutoApplyToolKitOptions {
  db: DatabaseType;
  browserManager: BrowserManagerHandle;
  /** Per-site adapters, keyed by `site_id` (e.g. `{ linkedin: linkedInAdapter }`). */
  adapters: Record<string, SiteAdapter>;
  /** Reused for `ensureTailoredCv` save paths. */
  manualApplyToolKit: ManualApplyToolKit;
  /** Per-task LLM model factory — same shape as the prepare-manual-apply handler. */
  buildModel: () => Promise<BaseChatModel>;
}

interface ActiveState {
  page: Page;
  session: ApplicationSession;
  adapter: SiteAdapter;
  siteId: string;
}

/**
 * Server-side `AutoApplyToolKit`. One instance per apply task — holds
 * the in-flight Page in a private closure so successive method calls
 * see the same session. `closeApplication` clears the state and the
 * `Page`, but leaves the BrowserContext alive (shared with discovery).
 */
export function createAutoApplyToolKit(
  opts: CreateAutoApplyToolKitOptions,
): AutoApplyToolKit {
  let state: ActiveState | null = null;

  function requireActive(): ActiveState {
    if (!state) throw new Error('autoApplyToolKit: openJobApplication() must be called first');
    return state;
  }

  return {
    async getJob(jobId: string): Promise<JobSlice> {
      const job = findJobById(opts.db, jobId);
      if (!job) throw new NotFoundError(`Job ${jobId} not found`);
      return {
        id: job.id,
        title: job.title,
        company: job.company,
        description: job.description,
        apply_method: job.apply_method,
      };
    },

    async getProfileContext(): Promise<string> {
      const profile = findProfile(opts.db);
      const answers = listAnswers(opts.db);
      const lines: string[] = [];
      if (profile) {
        lines.push(`Name: ${profile.full_name}`);
        lines.push(`Email: ${profile.email}`);
        if (profile.phone) lines.push(`Phone: ${profile.phone}`);
        if (profile.location) lines.push(`Location: ${profile.location}`);
        if (profile.linkedin_url) lines.push(`LinkedIn: ${profile.linkedin_url}`);
        if (profile.website_url) lines.push(`Website: ${profile.website_url}`);
      }
      if (answers.length > 0) {
        lines.push('', 'Saved answers:');
        for (const a of answers) lines.push(`- ${a.label}: ${a.value}`);
      }
      return lines.join('\n');
    },

    async isApplicationApproved(applicationId: string): Promise<boolean> {
      const app = findApplicationById(opts.db, applicationId);
      if (!app) throw new NotFoundError(`Application ${applicationId} not found`);
      // The review-first flow parks the application at `awaiting_approval`
      // until the user clicks Approve, which moves it to `queued`. Treat any
      // non-awaiting-approval status as approved.
      return app.status !== 'awaiting_approval';
    },

    async getApprovalSetting(): Promise<'auto-apply' | 'review-first'> {
      return getOrInitSettings(opts.db).approval;
    },

    async resolveField({
      field,
      applicationId,
    }: {
      field: FormField;
      applicationId: string;
    }): Promise<FieldResolution> {
      const app = findApplicationById(opts.db, applicationId);
      if (!app) throw new NotFoundError(`Application ${applicationId} not found`);
      const profile = findProfile(opts.db);
      if (!profile) throw new ConflictError('Profile not configured — cannot resolve fields');
      const cv = findCvById(opts.db, app.cv_id);
      const answers = listAnswers(opts.db);
      const automationField = field as AutomationFormField;
      const result = resolveFieldValue(automationField, {
        profile: {
          full_name: profile.full_name,
          email: profile.email,
          phone: profile.phone,
          location: profile.location,
          linkedin_url: profile.linkedin_url,
          website_url: profile.website_url,
        },
        answers: answers.map((a) => ({ key: a.key, label: a.label, value: a.value })),
        ...(cv?.extracted_text ? { cvText: cv.extracted_text } : {}),
      });
      return result;
    },

    async ensureTailoredCv(input): Promise<{ tailoredCvPath: string }> {
      const existing = findApplicationById(opts.db, input.applicationId);
      if (existing?.tailored_cv_path) {
        return { tailoredCvPath: existing.tailored_cv_path };
      }
      const job = findJobById(opts.db, input.jobId);
      if (!job) throw new NotFoundError(`Job ${input.jobId} not found`);
      const cv = findCvById(opts.db, input.cvId);
      if (!cv) throw new ConflictError('Application CV missing — upload one in Profile');
      const profile = findProfile(opts.db);
      if (!profile) throw new ConflictError('Profile not configured');

      const model = await opts.buildModel();
      const tailorOut = await runTailorCv(
        {
          job: { title: job.title, company: job.company, description: job.description },
          source_cv_text: cv.extracted_text ?? '',
          user_profile: { full_name: profile.full_name, bio: profile.bio },
        },
        model as unknown as StructuredScorer,
      );
      const header = { full_name: profile.full_name, email: profile.email };
      const [docx, pdf] = await Promise.all([
        renderTailoredDocx(tailorOut, header),
        renderTailoredPdf(tailorOut, header),
      ]);
      const [docxResult, pdfResult] = await Promise.all([
        opts.manualApplyToolKit.saveTailoredCv({
          application_id: input.applicationId,
          docx,
        }),
        opts.manualApplyToolKit.saveTailoredCvPdf({
          application_id: input.applicationId,
          docx: pdf,
        }),
      ]);
      setApplicationTailored(opts.db, input.applicationId, {
        tailored_cv_path: docxResult.path,
        tailored_cover_letter_path: null,
        tailored_cv_pdf_path: pdfResult.path,
        tailored_cover_letter_pdf_path: null,
        tailored_at: new Date().toISOString(),
        new_status: existing?.status === 'awaiting_approval' ? 'awaiting_approval' : 'applying',
      });
      return { tailoredCvPath: docxResult.path };
    },

    async openJobApplication({ jobId }: { jobId: string }): Promise<{ formId: string }> {
      const job = findJobById(opts.db, jobId);
      if (!job) throw new NotFoundError(`Job ${jobId} not found`);
      const adapter = opts.adapters[job.site_id];
      if (!adapter) {
        throw new Error(`No adapter registered for site '${job.site_id}'`);
      }
      const ctx = await opts.browserManager.getContext(job.site_id);
      const page = await ctx.newPage();
      const listing: RawListing = {
        externalId: job.external_id,
        title: job.title,
        company: job.company,
        location: job.location,
        url: job.url,
        snippet: null,
        postedAt: null,
        cardApplyMethod: 'auto',
      };
      const session = await adapter.startApplication(page, listing);
      state = { page, session, adapter, siteId: job.site_id };
      return { formId: session.formId };
    },

    async inspectFields(): Promise<readonly FormField[]> {
      const s = requireActive();
      const fields = await s.adapter.inspectFields(s.session);
      return fields;
    },

    async fillField({ ref, value }): Promise<void> {
      const s = requireActive();
      await s.adapter.fillField(s.session, ref, value);
    },

    async uploadCv({ path }): Promise<void> {
      const s = requireActive();
      await s.adapter.uploadCv(s.session, path);
    },

    async uploadCoverLetter({ path }): Promise<void> {
      const s = requireActive();
      await s.adapter.uploadCoverLetter(s.session, path);
    },

    async advanceStep(): Promise<{ advanced: boolean }> {
      const s = requireActive();
      return s.adapter.advanceStep(s.session);
    },

    async submit(): Promise<SubmitOutcome> {
      const s = requireActive();
      const result: SubmitResult = await s.adapter.submit(s.session);
      return result;
    },

    async takeScreenshot(): Promise<{ pngBase64: string }> {
      const s = requireActive();
      return s.adapter.takeScreenshot(s.session);
    },

    async closeApplication(): Promise<void> {
      if (!state) return;
      try {
        await state.adapter.closeApplication(state.session);
      } catch (err) {
        log.warn({ err }, 'closeApplication: adapter close failed');
      }
      try {
        await state.page.close();
      } catch (err) {
        log.warn({ err }, 'closeApplication: page close failed');
      }
      state = null;
    },

    async createAlert(input: NewAlertInput): Promise<{ id: string }> {
      const alert = insertAlert(opts.db, {
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        description: input.description,
        ...(input.applicationId ? { application_id: input.applicationId } : {}),
        ...(input.payload ? { payload: input.payload } : {}),
      });
      return { id: alert.id };
    },
  };
}
