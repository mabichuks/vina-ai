import { z } from 'zod';
import type { Tool } from '@opencode/sdk';
import {
  ApplicationStatusInputSchema,
  ApplicationStatusOutputSchema,
  AskUserInputSchema,
  AskUserOutputSchema,
  EasyApplyInputSchema,
  EasyApplyOutputSchema,
  JobGetInputSchema,
  JobGetOutputSchema,
  JobsListInputSchema,
  JobsListOutputSchema,
  MaterialsSaveInputSchema,
  MaterialsSaveOutputSchema,
  MaterialsReadInputSchema,
  MaterialsReadOutputSchema,
  ProfileReadInputSchema,
  ProfileReadOutputSchema,
  ReviewRecordInputSchema,
  ReviewRecordOutputSchema,
  ScoreJobInputSchema,
  ScoreJobOutputSchema,
  SearchJobsInputSchema,
  SearchJobsOutputSchema,
  type VinaServices,
} from './contract.js';

/**
 * The permission gate the `easy_apply` tool consults before delegating.
 * Mirrors the stage-0 probe (§14 Check 2): `assert` resolves on allow and
 * rejects with a `Tool.Error` on a deny/rejection. The session id comes from
 * the SDK tool context at execute time.
 */
export interface EasyApplyPermission {
  assert(input: {
    sessionID: Tool.Context['sessionID'];
    action: string;
    resources: string[];
  }): Promise<void>;
}

/**
 * Assembles the eleven `vina` tool descriptors. Each `execute` zod-validates its
 * input (defence in depth — the SDK also decodes against `input`) and then
 * delegates to the injected `VinaServices`. Descriptors carry a short name;
 * the plugin's namespace transform flattens them to `vina_<name>`.
 *
 * `easy_apply` is the only tool that asserts permission before delegating; all
 * other tools ignore the SDK context.
 */
interface ToolSpec<I extends z.ZodType, O extends z.ZodType> {
  name: string;
  description: string;
  input: I;
  output: O;
  run: (input: z.infer<I>) => Promise<z.infer<O>>;
  /** Runs before `run` (easy_apply only). */
  assert?: (input: z.infer<I>, ctx: Tool.Context) => Promise<void>;
}

function defineTool<I extends z.ZodType, O extends z.ZodType>(
  spec: ToolSpec<I, O>,
): Tool.Info<I, O> {
  return {
    name: spec.name,
    description: spec.description,
    input: spec.input,
    output: spec.output,
    execute: async (input: z.infer<I>, ctx: Tool.Context) => {
      const parsed = spec.input.parse(input);
      if (spec.assert) await spec.assert(parsed, ctx);
      return { output: await spec.run(parsed) };
    },
  } as Tool.Info<I, O>;
}

export function buildVinaTools(
  services: VinaServices,
  permission: EasyApplyPermission,
): Tool.Info[] {
  return [
    defineTool({
      name: 'profile_read',
      description:
        'Read the user profile, the saved CV list, and saved form answers. Returns a slice, never the whole database.',
      input: ProfileReadInputSchema,
      output: ProfileReadOutputSchema,
      run: async (input) => services.profileRead(input),
    }),
    defineTool({
      name: 'search_jobs',
      description:
        'Search for jobs across the configured sources (Google Jobs via SerpAPI, and/or LinkedIn/Indeed). Inserts and dedupes listings.',
      input: SearchJobsInputSchema,
      output: SearchJobsOutputSchema,
      run: async (input) => services.searchJobs(input),
    }),
    defineTool({
      name: 'jobs_list',
      description:
        'List jobs in the pipeline, optionally filtered by status, for dedupe and triage.',
      input: JobsListInputSchema,
      output: JobsListOutputSchema,
      run: async (input) => services.jobsList(input),
    }),
    defineTool({
      name: 'job_get',
      description: 'Read one job: description, score, eligibility, and application state.',
      input: JobGetInputSchema,
      output: JobGetOutputSchema,
      run: async (input) => services.jobGet(input),
    }),
    defineTool({
      name: 'score_job',
      description: 'Run the existing scoring prompt for a job and persist the score.',
      input: ScoreJobInputSchema,
      output: ScoreJobOutputSchema,
      run: async (input) => services.scoreJob(input),
    }),
    defineTool({
      name: 'materials_save',
      description:
        'Save agent-authored tailored CV/cover-letter prose: render deterministic PDF/DOCX and mark the application ready for manual apply.',
      input: MaterialsSaveInputSchema,
      output: MaterialsSaveOutputSchema,
      run: async (input) => services.materialsSave(input),
    }),
    defineTool({
      name: 'materials_read',
      description:
        'Read the tailored CV/cover-letter markdown, rendered file paths, and saved form answers for an application.',
      input: MaterialsReadInputSchema,
      output: MaterialsReadOutputSchema,
      run: async (input) => services.materialsRead(input),
    }),
    defineTool({
      name: 'review_record',
      description: "Record the review agent's verdict (approve/reject) for an application round.",
      input: ReviewRecordInputSchema,
      output: ReviewRecordOutputSchema,
      run: async (input) => services.reviewRecord(input),
    }),
    defineTool({
      name: 'application_status',
      description:
        'Transition an application to a validated status; illegal transitions are rejected.',
      input: ApplicationStatusInputSchema,
      output: ApplicationStatusOutputSchema,
      run: async (input) => services.applicationStatus(input),
    }),
    defineTool({
      name: 'easy_apply',
      description:
        'Run Easy Apply for an application: the single submit path, gated by checkEasyApplyGate.',
      input: EasyApplyInputSchema,
      output: EasyApplyOutputSchema,
      run: async (input) => services.easyApply(input),
      assert: async (input, ctx) => {
        await permission.assert({
          sessionID: ctx.sessionID,
          action: 'vina.easy_apply',
          resources: [input.applicationId],
        });
      },
    }),
    defineTool({
      name: 'ask_user',
      description:
        "Raise an alert asking the user one or more questions and park the session; returns 'pending'.",
      input: AskUserInputSchema,
      output: AskUserOutputSchema,
      run: async (input) => services.askUser(input),
    }),
  ];
}
