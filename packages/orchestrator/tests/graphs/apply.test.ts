import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { Runnable } from '@langchain/core/runnables';
import {
  runApply,
  type ApplyInput,
} from '../../src/graphs/apply.js';
import type {
  ApplyFallbackMessages,
  FallbackDecision,
  StructuredApplyDecider,
} from '../../src/graphs/apply-fallback.js';
import type {
  AutoApplyToolKit,
  FieldResolution,
  FormField,
  JobSlice,
  NewAlertInput,
  SubmitOutcome,
} from '../../src/tools/auto-apply-toolkit.js';

const APPLY_INPUT: ApplyInput = {
  applicationId: 'app-1',
  jobId: 'job-1',
  cvId: 'cv-1',
};

const AUTO_JOB: JobSlice = {
  id: 'job-1',
  title: 'Senior Engineer',
  company: 'Acme',
  description: 'A role',
  apply_method: 'auto',
};

interface MockToolKitOptions {
  job?: JobSlice;
  approvalSetting?: 'auto-apply' | 'review-first';
  approved?: boolean;
  tailorThrows?: boolean;
  openThrows?: boolean;
  steps?: Array<{
    fields: FormField[];
    /** Optional override for advanceStep after this step's fill loop. Default false. */
    advance?: boolean;
  }>;
  submitOutcome?: SubmitOutcome;
  resolve?: (field: FormField) => FieldResolution;
}

interface MockToolKit extends AutoApplyToolKit {
  calls: {
    fillField: Array<{ ref: string; value: string }>;
    uploadCv: number;
    submit: number;
    advanceStep: number;
    closeApplication: number;
    alerts: NewAlertInput[];
  };
}

function makeToolKit(opts: MockToolKitOptions = {}): MockToolKit {
  const calls: MockToolKit['calls'] = {
    fillField: [],
    uploadCv: 0,
    submit: 0,
    advanceStep: 0,
    closeApplication: 0,
    alerts: [],
  };
  let stepIndex = 0;
  const steps = opts.steps ?? [{ fields: [] }];

  return {
    calls,
    async getJob() {
      return opts.job ?? AUTO_JOB;
    },
    async getProfileContext() {
      return 'Name: Ada Lovelace\nEmail: ada@example.com';
    },
    async isApplicationApproved() {
      return opts.approved ?? false;
    },
    async getApprovalSetting() {
      return opts.approvalSetting ?? 'auto-apply';
    },
    async resolveField({ field }) {
      if (opts.resolve) return opts.resolve(field);
      return { kind: 'unknown' };
    },
    async ensureTailoredCv() {
      if (opts.tailorThrows) throw new Error('tailoring blew up');
      return { tailoredCvPath: '/tmp/cv.docx' };
    },
    async openJobApplication() {
      if (opts.openThrows) throw new Error('open blew up');
      return { formId: 'form-1' };
    },
    async inspectFields() {
      const step = steps[Math.min(stepIndex, steps.length - 1)];
      return step?.fields ?? [];
    },
    async fillField(input) {
      calls.fillField.push({ ref: input.ref, value: input.value });
    },
    async uploadCv() {
      calls.uploadCv++;
    },
    async uploadCoverLetter() {
      // unused in current tests
    },
    async advanceStep() {
      calls.advanceStep++;
      const step = steps[Math.min(stepIndex, steps.length - 1)];
      const willAdvance = step?.advance === true && stepIndex < steps.length - 1;
      if (willAdvance) stepIndex++;
      return { advanced: willAdvance };
    },
    async submit() {
      calls.submit++;
      return opts.submitOutcome ?? { ok: true };
    },
    async takeScreenshot() {
      return { pngBase64: 'ZmFrZQ==' };
    },
    async closeApplication() {
      calls.closeApplication++;
    },
    async createAlert(input) {
      calls.alerts.push(input);
      return { id: `alert-${calls.alerts.length}` };
    },
  };
}

class FakeDecider implements StructuredApplyDecider {
  constructor(private decision: FallbackDecision) {}

  withStructuredOutput<T>(_schema: z.ZodType<T>): Runnable<ApplyFallbackMessages, T> {
    const decision = this.decision;
    return {
      async invoke(): Promise<T> {
        return decision as unknown as T;
      },
    } as unknown as Runnable<ApplyFallbackMessages, T>;
  }
}

const NEVER_DECIDE = new FakeDecider({ action: 'skip', value: null, reason: 'never asked' });

describe('runApply — happy path', () => {
  it('submits when every field resolves from profile', async () => {
    const fields: FormField[] = [
      {
        ref: 'r1',
        label: 'First name',
        kind: 'text',
        required: true,
        canonicalKey: 'first_name',
      },
      { ref: 'r2', label: 'Email', kind: 'email', required: true },
    ];
    const toolKit = makeToolKit({
      steps: [{ fields }],
      resolve: (f) =>
        f.canonicalKey === 'first_name'
          ? { kind: 'resolved', value: 'Ada', source: 'profile' }
          : { kind: 'resolved', value: 'ada@example.com', source: 'profile' },
    });
    const result = await runApply(APPLY_INPUT, NEVER_DECIDE, toolKit);
    expect(result.outcome).toBe('submitted');
    expect(toolKit.calls.fillField).toEqual([
      { ref: 'r1', value: 'Ada' },
      { ref: 'r2', value: 'ada@example.com' },
    ]);
    expect(toolKit.calls.submit).toBe(1);
    expect(toolKit.calls.closeApplication).toBe(1);
    expect(result.events.some((e) => e.step === 'submitted')).toBe(true);
  });

  it('uploads the tailored CV when a file field is present', async () => {
    const fields: FormField[] = [
      { ref: 'r1', label: 'CV', kind: 'file', required: true },
    ];
    const toolKit = makeToolKit({ steps: [{ fields }] });
    const result = await runApply(APPLY_INPUT, NEVER_DECIDE, toolKit);
    expect(result.outcome).toBe('submitted');
    expect(toolKit.calls.uploadCv).toBe(1);
  });
});

describe('runApply — defensive checks', () => {
  it('throws when the job is apply_method=manual (routing bug)', async () => {
    const toolKit = makeToolKit({
      job: { ...AUTO_JOB, apply_method: 'manual' },
    });
    await expect(runApply(APPLY_INPUT, NEVER_DECIDE, toolKit)).rejects.toThrow(
      /apply_method='manual'/,
    );
  });

  it('returns outcome=failed when tailoring throws', async () => {
    const toolKit = makeToolKit({ tailorThrows: true });
    const result = await runApply(APPLY_INPUT, NEVER_DECIDE, toolKit);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('other');
    expect(result.failureDetail).toMatch(/tailoring blew up/);
  });
});

describe('runApply — review_gate', () => {
  it('raises awaiting_approval and stops when review-first and not approved', async () => {
    const toolKit = makeToolKit({
      approvalSetting: 'review-first',
      approved: false,
    });
    const result = await runApply(APPLY_INPUT, NEVER_DECIDE, toolKit);
    expect(result.outcome).toBe('awaiting_approval');
    expect(result.reason).toBe('review_required');
    expect(toolKit.calls.alerts[0]?.kind).toBe('awaiting_approval');
    // No browser methods called.
    expect(toolKit.calls.submit).toBe(0);
    expect(toolKit.calls.closeApplication).toBe(0);
  });

  it('proceeds when review-first and approved', async () => {
    const toolKit = makeToolKit({
      approvalSetting: 'review-first',
      approved: true,
    });
    const result = await runApply(APPLY_INPUT, NEVER_DECIDE, toolKit);
    expect(result.outcome).toBe('submitted');
  });
});

describe('runApply — LLM fallback', () => {
  it('fills a previously-unknown field when the LLM provides a value', async () => {
    const fields: FormField[] = [
      { ref: 'r1', label: 'Years of Rust experience', kind: 'number', required: true },
    ];
    const toolKit = makeToolKit({ steps: [{ fields }] });
    const decider = new FakeDecider({
      action: 'fill',
      value: '0',
      reason: 'profile mentions no Rust',
    });
    const result = await runApply(APPLY_INPUT, decider, toolKit);
    expect(result.outcome).toBe('submitted');
    expect(toolKit.calls.fillField).toEqual([{ ref: 'r1', value: '0' }]);
  });

  it('raises missing_field alert when the LLM declines', async () => {
    const fields: FormField[] = [
      { ref: 'r1', label: 'Highest qualification', kind: 'text', required: true },
    ];
    const toolKit = makeToolKit({ steps: [{ fields }] });
    const decider = new FakeDecider({
      action: 'skip',
      value: null,
      reason: 'profile lacks education data',
    });
    const result = await runApply(APPLY_INPUT, decider, toolKit);
    expect(result.outcome).toBe('awaiting_user');
    expect(result.reason).toBe('missing_field');
    expect(toolKit.calls.alerts[0]?.kind).toBe('missing_field');
    expect(toolKit.calls.alerts[0]?.payload?.['field_label']).toBe(
      'Highest qualification',
    );
    expect(toolKit.calls.submit).toBe(0);
    expect(toolKit.calls.closeApplication).toBe(1);
  });
});

describe('runApply — submit outcomes', () => {
  it('raises captcha alert and stops when submit returns reason=captcha', async () => {
    const toolKit = makeToolKit({
      submitOutcome: { ok: false, reason: 'captcha', detail: 'recaptcha v3' },
    });
    const result = await runApply(APPLY_INPUT, NEVER_DECIDE, toolKit);
    expect(result.outcome).toBe('awaiting_user');
    expect(result.reason).toBe('captcha');
    expect(toolKit.calls.alerts[0]?.kind).toBe('captcha');
  });

  it('raises session_expired alert when submit reports it', async () => {
    const toolKit = makeToolKit({
      submitOutcome: { ok: false, reason: 'session_expired' },
    });
    const result = await runApply(APPLY_INPUT, NEVER_DECIDE, toolKit);
    expect(result.outcome).toBe('awaiting_user');
    expect(result.reason).toBe('session_expired');
    expect(toolKit.calls.alerts[0]?.kind).toBe('session_expired');
  });

  it('raises apply_failed for unrecognised submit failures', async () => {
    const toolKit = makeToolKit({
      submitOutcome: { ok: false, reason: 'other', detail: 'no submit button' },
    });
    const result = await runApply(APPLY_INPUT, NEVER_DECIDE, toolKit);
    expect(result.outcome).toBe('awaiting_user');
    expect(result.reason).toBe('other');
    expect(toolKit.calls.alerts[0]?.kind).toBe('apply_failed');
  });
});

describe('runApply — multi-step + step cap', () => {
  it('walks multi-step forms via advanceStep', async () => {
    const step1: FormField[] = [
      {
        ref: 'r1',
        label: 'First name',
        kind: 'text',
        required: true,
        canonicalKey: 'first_name',
      },
    ];
    const step2: FormField[] = [
      { ref: 'r2', label: 'Email', kind: 'email', required: true },
    ];
    const toolKit = makeToolKit({
      steps: [
        { fields: step1, advance: true },
        { fields: step2 },
      ],
      resolve: (f) =>
        f.canonicalKey === 'first_name'
          ? { kind: 'resolved', value: 'Ada', source: 'profile' }
          : { kind: 'resolved', value: 'ada@example.com', source: 'profile' },
    });
    const result = await runApply(APPLY_INPUT, NEVER_DECIDE, toolKit);
    expect(result.outcome).toBe('submitted');
    expect(toolKit.calls.fillField).toHaveLength(2);
    expect(toolKit.calls.advanceStep).toBe(2);
    expect(toolKit.calls.submit).toBe(1);
  });

  it('escalates form_too_long when maxSteps is exhausted without reaching submit', async () => {
    const step: { fields: FormField[]; advance: boolean } = {
      fields: [],
      advance: true,
    };
    const toolKit = makeToolKit({ steps: [step, step, step, step, step, step] });
    const result = await runApply(APPLY_INPUT, NEVER_DECIDE, toolKit, { maxSteps: 3 });
    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('form_too_long');
    expect(toolKit.calls.alerts[0]?.kind).toBe('apply_failed');
  });
});
