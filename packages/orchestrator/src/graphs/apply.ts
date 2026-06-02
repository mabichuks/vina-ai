import { createLogger } from '@vina/shared';
import type { PromptLoader } from '../prompts/loader.js';
import type { SkillRegistry } from '../skills/registry.js';
import {
  decideUnresolvedField,
  type StructuredApplyDecider,
} from './apply-fallback.js';
import type {
  AutoApplyToolKit,
  FormField,
  JobSlice,
  SubmitOutcome,
} from '../tools/auto-apply-toolkit.js';

const log = createLogger('graphs.apply');

/**
 * Caller-supplied identifiers. The graph reads everything else through
 * the toolkit; nothing in the orchestrator package touches the database
 * or the browser directly.
 */
export interface ApplyInput {
  applicationId: string;
  jobId: string;
  cvId: string;
}

export type ApplyOutcome =
  | 'submitted'
  | 'awaiting_user'
  | 'awaiting_approval'
  | 'failed';

/** Lightweight event stream the server's `apply` task handler persists. */
export interface ApplyEvent {
  step: string;
  detail?: Record<string, unknown>;
}

export interface ApplyResult {
  outcome: ApplyOutcome;
  applicationId: string;
  reason?:
    | 'missing_field'
    | 'captcha'
    | 'session_expired'
    | 'apply_method_mismatch'
    | 'review_required'
    | 'form_too_long'
    | 'other';
  failureDetail?: string;
  events: ApplyEvent[];
}

export interface RunApplyOptions {
  promptLoader?: PromptLoader;
  skillRegistry?: SkillRegistry;
  /** Step cap from the browser-apply skill. Default 5. */
  maxSteps?: number;
}

/**
 * Run the apply graph for one application against the auto-apply pipeline
 * (ADR-016, build-order M15). The orchestration is plain async (matches
 * `prepare-manual-apply.ts`); LangGraph is reserved for graphs that need
 * its branching / checkpointing surface and this one doesn't yet.
 *
 * State transitions roughly mirror `docs/langgraph-orchestrator.md` §5.4:
 *
 *   load_inputs → ensure_tailored → review_gate → open_form →
 *   for each step (≤ maxSteps):
 *     inspect_fields → fill_loop → submit-or-advance
 */
export async function runApply(
  input: ApplyInput,
  model: StructuredApplyDecider,
  toolKit: AutoApplyToolKit,
  opts: RunApplyOptions = {},
): Promise<ApplyResult> {
  const maxSteps = opts.maxSteps ?? 5;
  const events: ApplyEvent[] = [];
  const record = (step: string, detail?: Record<string, unknown>): void => {
    events.push(detail ? { step, detail } : { step });
  };

  record('started', { applicationId: input.applicationId, jobId: input.jobId });

  // -- load_inputs -----------------------------------------------------------
  const job = await toolKit.getJob(input.jobId);
  if (job.apply_method !== 'auto') {
    // Defensive: the server's task dispatcher routes manual-apply jobs to
    // `prepare-manual-apply`. If one slips through, raise loudly — getting
    // here is a routing bug, not a user-visible failure.
    throw new Error(
      `runApply invoked for job ${input.jobId} with apply_method='${job.apply_method}'`,
    );
  }
  const profileContext = await toolKit.getProfileContext();
  record('inputs_loaded');

  // -- ensure_tailored -------------------------------------------------------
  // The toolkit returns { tailoredCvPath: null } for sites that don't
  // require an upload (LinkedIn Easy Apply pre-attaches the profile CV).
  // When null, the graph skips both the tailor work and the upload step.
  let tailoredCvPath: string | null;
  try {
    const tailored = await toolKit.ensureTailoredCv({
      applicationId: input.applicationId,
      jobId: input.jobId,
      cvId: input.cvId,
    });
    tailoredCvPath = tailored.tailoredCvPath;
    if (tailoredCvPath === null) {
      record('tailoring_skipped', { reason: 'site_uses_profile_cv' });
    } else {
      record('tailored', { tailoredCvPath });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn({ err, applicationId: input.applicationId }, 'tailoring failed');
    return {
      outcome: 'failed',
      applicationId: input.applicationId,
      reason: 'other',
      failureDetail: detail,
      events,
    };
  }

  // -- review_gate -----------------------------------------------------------
  const approval = await toolKit.getApprovalSetting();
  if (approval === 'review-first') {
    const approved = await toolKit.isApplicationApproved(input.applicationId);
    if (!approved) {
      record('awaiting_approval');
      const alertTitle = tailoredCvPath
        ? `Tailored CV ready — approve to submit ${job.title} @ ${job.company}`
        : `Approve to submit ${job.title} @ ${job.company}`;
      const alertDescription = tailoredCvPath
        ? 'Review the tailored CV; the application will submit once you approve.'
        : 'This site uses your profile CV — the application will submit once you approve.';
      await toolKit.createAlert({
        kind: 'awaiting_approval',
        severity: 'action_required',
        title: alertTitle,
        description: alertDescription,
        applicationId: input.applicationId,
        payload: tailoredCvPath ? { tailoredCvPath } : { usesProfileCv: true },
      });
      return {
        outcome: 'awaiting_approval',
        applicationId: input.applicationId,
        reason: 'review_required',
        events,
      };
    }
  }

  // -- open_form -------------------------------------------------------------
  let formId: string;
  try {
    const opened = await toolKit.openJobApplication({ jobId: input.jobId });
    formId = opened.formId;
    record('form_opened', { formId });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      outcome: 'failed',
      applicationId: input.applicationId,
      reason: 'other',
      failureDetail: detail,
      events,
    };
  }

  try {
    // -- step loop ---------------------------------------------------------
    for (let step = 1; step <= maxSteps; step++) {
      record('step_started', { step });

      const fields = await toolKit.inspectFields({ formId });
      record('fields_inspected', { count: fields.length });

      const fillResult = await fillStep({
        fields,
        formId,
        profileContext,
        toolKit,
        model,
        record,
        applicationId: input.applicationId,
      });
      if (fillResult.outcome === 'awaiting_user') {
        return { ...fillResult.result, events };
      }

      // Upload the tailored CV when a file field is present AND we have
      // one. Sites that pre-attach the profile resume (LinkedIn) set
      // tailoredCvPath=null; the upload step is skipped entirely.
      const cvFileField = fields.find((f) => f.kind === 'file');
      if (cvFileField && tailoredCvPath !== null) {
        await toolKit.uploadCv({ formId, path: tailoredCvPath });
        record('cv_uploaded');
      } else if (cvFileField && tailoredCvPath === null) {
        record('cv_upload_skipped', { reason: 'no_tailored_cv' });
      }

      // Submit-or-advance: if there's another step, advance; else submit.
      const advance = await toolKit.advanceStep({ formId });
      if (!advance.advanced) {
        // Final step → submit.
        const submitted = await toolKit.submit({ formId });
        if (submitted.ok) {
          record('submitted');
          return { outcome: 'submitted', applicationId: input.applicationId, events };
        }
        record('submit_failed', { reason: submitted.reason });
        await raiseSubmitFailureAlert({
          toolKit,
          formId,
          applicationId: input.applicationId,
          job,
          outcome: submitted,
        });
        return {
          outcome: 'awaiting_user',
          applicationId: input.applicationId,
          reason: submitted.reason,
          failureDetail: submitted.detail,
          events,
        };
      }
      record('step_advanced', { step });
    }

    // Step cap exceeded — escalate (browser-apply skill: `form_too_long`).
    record('step_cap_exceeded', { maxSteps });
    const screenshot = await toolKit.takeScreenshot({ formId }).catch(() => null);
    await toolKit.createAlert({
      kind: 'apply_failed',
      severity: 'error',
      title: `Form too long for ${job.title} @ ${job.company}`,
      description: `Walked ${maxSteps} steps without reaching submit — application paused for review.`,
      applicationId: input.applicationId,
      payload: { reason: 'form_too_long', maxSteps },
      ...(screenshot ? { screenshotPngBase64: screenshot.pngBase64 } : {}),
    });
    return {
      outcome: 'failed',
      applicationId: input.applicationId,
      reason: 'form_too_long',
      events,
    };
  } finally {
    await toolKit.closeApplication({ formId }).catch((err) => {
      log.warn({ err, formId }, 'closeApplication failed');
    });
  }
}

interface FillStepInput {
  fields: readonly FormField[];
  formId: string;
  profileContext: string;
  toolKit: AutoApplyToolKit;
  model: StructuredApplyDecider;
  record: (step: string, detail?: Record<string, unknown>) => void;
  applicationId: string;
}

type FillStepOutcome =
  | { outcome: 'continue' }
  | {
      outcome: 'awaiting_user';
      result: Omit<ApplyResult, 'events'>;
    };

async function fillStep(input: FillStepInput): Promise<FillStepOutcome> {
  const {
    fields,
    formId,
    profileContext,
    toolKit,
    model,
    record,
    applicationId,
  } = input;

  for (const field of fields) {
    // File fields are uploaded after the fill loop completes.
    if (field.kind === 'file') continue;

    const resolved = await toolKit.resolveField({ field, applicationId });
    if (resolved.kind === 'resolved') {
      await toolKit.fillField({ formId, ref: field.ref, value: resolved.value });
      record('field_filled', {
        ref: field.ref,
        label: field.label,
        source: resolved.source,
      });
      continue;
    }

    // Unknown — fall back to the LLM (one decision per field). If the
    // model call itself fails (provider rejects schema, rate limit, etc.)
    // treat it as a "skip with detail" so the graph still completes
    // gracefully with an alert rather than throwing up the stack.
    let decision: Awaited<ReturnType<typeof decideUnresolvedField>>;
    try {
      decision = await decideUnresolvedField(
        {
          profileContext,
          field: {
            label: field.label,
            kind: field.kind,
            required: field.required,
            ...(field.options ? { options: field.options } : {}),
          },
        },
        model,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, field: field.label, applicationId },
        'apply-fallback model call failed; treating as skip',
      );
      decision = { action: 'skip', reason: `LLM fallback failed: ${detail}` };
    }
    if (decision.action === 'fill' && decision.value) {
      await toolKit.fillField({ formId, ref: field.ref, value: decision.value });
      record('field_filled', {
        ref: field.ref,
        label: field.label,
        source: 'llm',
        reason: decision.reason,
      });
      continue;
    }

    // LLM declined — raise missing_field and stop.
    record('field_unresolved', {
      ref: field.ref,
      label: field.label,
      reason: decision.reason,
    });
    const screenshot = await toolKit.takeScreenshot({ formId }).catch(() => null);
    await toolKit.createAlert({
      kind: 'missing_field',
      severity: 'action_required',
      title: `Need your input: ${field.label}`,
      description:
        decision.reason ||
        'Vina needs your answer to this field before it can submit.',
      applicationId,
      payload: {
        field_ref: field.ref,
        field_label: field.label,
        field_kind: field.kind,
        ...(field.options ? { field_options: field.options } : {}),
      },
      ...(screenshot ? { screenshotPngBase64: screenshot.pngBase64 } : {}),
    });
    return {
      outcome: 'awaiting_user',
      result: {
        outcome: 'awaiting_user',
        applicationId,
        reason: 'missing_field',
      },
    };
  }
  return { outcome: 'continue' };
}

async function raiseSubmitFailureAlert(input: {
  toolKit: AutoApplyToolKit;
  formId: string;
  applicationId: string;
  job: JobSlice;
  outcome: Extract<SubmitOutcome, { ok: false }>;
}): Promise<void> {
  const { toolKit, formId, applicationId, job, outcome } = input;
  const screenshot = await toolKit.takeScreenshot({ formId }).catch(() => null);
  const baseTitle = `${job.title} @ ${job.company}`;
  if (outcome.reason === 'captcha') {
    await toolKit.createAlert({
      kind: 'captcha',
      severity: 'action_required',
      title: `CAPTCHA blocked ${baseTitle}`,
      description:
        outcome.detail ?? 'Solve the CAPTCHA in the open browser window, then resume.',
      applicationId,
      ...(screenshot ? { screenshotPngBase64: screenshot.pngBase64 } : {}),
    });
    return;
  }
  if (outcome.reason === 'session_expired') {
    await toolKit.createAlert({
      kind: 'session_expired',
      severity: 'action_required',
      title: `Session expired during ${baseTitle}`,
      description: outcome.detail ?? 'Reconnect the site and Vina will retry.',
      applicationId,
      ...(screenshot ? { screenshotPngBase64: screenshot.pngBase64 } : {}),
    });
    return;
  }
  await toolKit.createAlert({
    kind: 'apply_failed',
    severity: 'error',
    title: `Submit failed for ${baseTitle}`,
    description: outcome.detail ?? 'Submit returned an unrecognised failure.',
    applicationId,
    payload: { reason: outcome.reason ?? 'other' },
    ...(screenshot ? { screenshotPngBase64: screenshot.pngBase64 } : {}),
  });
}

