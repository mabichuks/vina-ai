import { z } from 'zod';
import { APPLICATION_STATUSES, APPLY_METHODS, JOB_STATUSES } from '@vina/shared';

/**
 * The `vina` tool contract (docs/opencode-orchestration.md §4).
 *
 * This module is a pure declaration: zod input/output slices and the
 * `VinaServices` interface the server implements by adapting its repositories
 * and services. It opens no database handle and imports neither
 * `@vina/server` nor `@vina/orchestrator` — the plugin stays a registration
 * shell, and the server supplies the behaviour by injection.
 *
 * Every tool returns a compact slice; no tool returns a whole table dump.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const ProfileReadInputSchema = z.object({});
export type ProfileReadInput = z.infer<typeof ProfileReadInputSchema>;

export const SearchJobsInputSchema = z.object({
  /** Source site ids to search (e.g. ['google'], ['linkedin', 'indeed']). */
  sources: z.array(z.enum(['linkedin', 'indeed', 'google'])).min(1),
  query: z.string().min(1),
  location: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type SearchJobsInput = z.infer<typeof SearchJobsInputSchema>;

export const JobsListInputSchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type JobsListInput = z.infer<typeof JobsListInputSchema>;

export const JobGetInputSchema = z.object({
  jobId: z.string().min(1),
});
export type JobGetInput = z.infer<typeof JobGetInputSchema>;

export const ScoreJobInputSchema = z.object({
  jobId: z.string().min(1),
});
export type ScoreJobInput = z.infer<typeof ScoreJobInputSchema>;

export const MaterialsSaveInputSchema = z.object({
  applicationId: z.string().min(1),
  /** Agent-authored tailored CV markdown. Rendered deterministically to DOCX + PDF. */
  cvMarkdown: z.string().min(1),
  /** Optional agent-authored tailored cover letter markdown. */
  coverLetterMarkdown: z.string().optional(),
  /** Optional saved form answers keyed by field label. */
  formAnswers: z.record(z.string(), z.string()).optional(),
});
export type MaterialsSaveInput = z.infer<typeof MaterialsSaveInputSchema>;

export const MaterialsReadInputSchema = z.object({
  applicationId: z.string().min(1),
});
export type MaterialsReadInput = z.infer<typeof MaterialsReadInputSchema>;

export const ReviewRecordInputSchema = z.object({
  applicationId: z.string().min(1),
  round: z.number().int().min(1),
  verdict: z.enum(['approve', 'reject']),
  findings: z.array(z.string()).optional(),
});
export type ReviewRecordInput = z.infer<typeof ReviewRecordInputSchema>;

export const ApplicationStatusInputSchema = z.object({
  applicationId: z.string().min(1),
  status: z.enum(APPLICATION_STATUSES),
  reason: z.string().optional(),
});
export type ApplicationStatusInput = z.infer<typeof ApplicationStatusInputSchema>;

export const EasyApplyInputSchema = z.object({
  applicationId: z.string().min(1),
});
export type EasyApplyInput = z.infer<typeof EasyApplyInputSchema>;

export const ExternalSubmitInputSchema = z.object({
  applicationId: z.string().min(1),
});
export type ExternalSubmitInput = z.infer<typeof ExternalSubmitInputSchema>;

export const AskUserInputSchema = z.object({
  questions: z
    .array(
      z.object({
        label: z.string().min(1),
        /** Optional hint shown alongside the label. */
        detail: z.string().optional(),
      }),
    )
    .min(1),
});
export type AskUserInput = z.infer<typeof AskUserInputSchema>;

// ---------------------------------------------------------------------------
// Outputs (slices, never whole tables)
// ---------------------------------------------------------------------------

export const ProfileReadOutputSchema = z.object({
  profile: z
    .object({
      full_name: z.string(),
      email: z.string(),
      phone: z.string().nullable(),
      location: z.string().nullable(),
      linkedin_url: z.string().nullable(),
      website_url: z.string().nullable(),
      bio: z.string().nullable(),
    })
    .nullable(),
  cvs: z.array(z.object({ id: z.string(), label: z.string(), is_default: z.boolean() })),
  answers: z.array(z.object({ key: z.string(), label: z.string(), value: z.string() })),
});
export type ProfileReadOutput = z.infer<typeof ProfileReadOutputSchema>;

export const SearchJobsOutputSchema = z.object({
  added: z.number().int().nonnegative(),
  jobs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      company: z.string(),
      location: z.string().nullable(),
      apply_method: z.enum(APPLY_METHODS),
    }),
  ),
});
export type SearchJobsOutput = z.infer<typeof SearchJobsOutputSchema>;

export const JobsListOutputSchema = z.object({
  total: z.number().int().nonnegative(),
  jobs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      company: z.string(),
      location: z.string().nullable(),
      status: z.enum(JOB_STATUSES),
      match_score: z.number().int().nullable(),
      apply_method: z.enum(APPLY_METHODS),
      posted_at: z.string().nullable(),
    }),
  ),
});
export type JobsListOutput = z.infer<typeof JobsListOutputSchema>;

export const JobGetOutputSchema = z.object({
  job: z.object({
    id: z.string(),
    title: z.string(),
    company: z.string(),
    location: z.string().nullable(),
    description: z.string(),
    salary_text: z.string().nullable(),
    posted_at: z.string().nullable(),
    url: z.string(),
    external_apply_url: z.string().nullable(),
    apply_method: z.enum(APPLY_METHODS),
    match_score: z.number().int().nullable(),
    match_justification: z.string().nullable(),
    status: z.enum(JOB_STATUSES),
  }),
  application: z
    .object({
      id: z.string(),
      status: z.enum(APPLICATION_STATUSES),
      apply_method: z.enum(APPLY_METHODS),
    })
    .nullable(),
});
export type JobGetOutput = z.infer<typeof JobGetOutputSchema>;

export const ScoreJobOutputSchema = z.object({
  job_id: z.string(),
  score: z.number().int().min(0).max(100),
  justification: z.string(),
  status: z.enum(JOB_STATUSES),
});
export type ScoreJobOutput = z.infer<typeof ScoreJobOutputSchema>;

export const MaterialsSaveOutputSchema = z.object({
  application_id: z.string(),
  status: z.enum(APPLICATION_STATUSES),
  tailored_cv_path: z.string(),
  tailored_cover_letter_path: z.string().nullable(),
});
export type MaterialsSaveOutput = z.infer<typeof MaterialsSaveOutputSchema>;

export const MaterialsReadOutputSchema = z.object({
  application_id: z.string(),
  cvMarkdown: z.string().nullable(),
  coverLetterMarkdown: z.string().nullable(),
  tailored_cv_path: z.string().nullable(),
  tailored_cover_letter_path: z.string().nullable(),
  formAnswers: z.record(z.string(), z.string()).nullable(),
});
export type MaterialsReadOutput = z.infer<typeof MaterialsReadOutputSchema>;

export const ReviewRecordOutputSchema = z.object({
  application_id: z.string(),
  event_id: z.string(),
  verdict: z.enum(['cv_approved', 'cv_rejected']),
});
export type ReviewRecordOutput = z.infer<typeof ReviewRecordOutputSchema>;

export const ApplicationStatusOutputSchema = z.object({
  application_id: z.string(),
  status: z.enum(APPLICATION_STATUSES),
});
export type ApplicationStatusOutput = z.infer<typeof ApplicationStatusOutputSchema>;

export const EasyApplyOutputSchema = z.object({
  application_id: z.string(),
  outcome: z.enum(['submitted', 'awaiting_user', 'failed']),
  reason: z.string().optional(),
});
export type EasyApplyOutput = z.infer<typeof EasyApplyOutputSchema>;

export const ExternalSubmitOutputSchema = z.object({
  application_id: z.string(),
  outcome: z.enum(['submitted', 'awaiting_user', 'failed']),
  reason: z.string().optional(),
});
export type ExternalSubmitOutput = z.infer<typeof ExternalSubmitOutputSchema>;

export const AskUserOutputSchema = z.object({
  status: z.literal('pending'),
  alert_id: z.string(),
  question_count: z.number().int().nonnegative(),
});
export type AskUserOutput = z.infer<typeof AskUserOutputSchema>;

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

/**
 * Behaviour the server injects into the plugin. Mirrors the existing
 * `AutoApplyToolKit` / `ManualApplyToolKit` DI convention: the plugin declares
 * the shape, `packages/server` implements it against its repositories and
 * services. The plugin never touches the database itself.
 */
export interface VinaServices {
  profileRead(input: ProfileReadInput): Promise<ProfileReadOutput>;
  searchJobs(input: SearchJobsInput): Promise<SearchJobsOutput>;
  jobsList(input: JobsListInput): Promise<JobsListOutput>;
  jobGet(input: JobGetInput): Promise<JobGetOutput>;
  scoreJob(input: ScoreJobInput): Promise<ScoreJobOutput>;
  materialsSave(input: MaterialsSaveInput): Promise<MaterialsSaveOutput>;
  materialsRead(input: MaterialsReadInput): Promise<MaterialsReadOutput>;
  reviewRecord(input: ReviewRecordInput): Promise<ReviewRecordOutput>;
  applicationStatus(input: ApplicationStatusInput): Promise<ApplicationStatusOutput>;
  easyApply(input: EasyApplyInput): Promise<EasyApplyOutput>;
  externalSubmit(input: ExternalSubmitInput): Promise<ExternalSubmitOutput>;
  askUser(input: AskUserInput): Promise<AskUserOutput>;
}

/** The namespace the twelve tools register under (flattened to `vina_<name>`). */
export const VINA_NAMESPACE = 'vina' as const;

/** Short tool names, in registration order. The UI lists them as `vina_<name>`. */
export const VINA_TOOL_NAMES = [
  'profile_read',
  'search_jobs',
  'jobs_list',
  'job_get',
  'score_job',
  'materials_save',
  'materials_read',
  'review_record',
  'application_status',
  'easy_apply',
  'external_submit',
  'ask_user',
] as const;
export type VinaToolName = (typeof VINA_TOOL_NAMES)[number];
