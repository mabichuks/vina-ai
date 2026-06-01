import type { AlertKind, AlertSeverity } from '@vina/shared';

/**
 * Structural mirrors of types in `@vina/automation`. The orchestrator
 * does not import the automation package (per
 * `docs/langgraph-orchestrator.md` §2). The server-side toolkit (Chunk
 * 18) bridges automation's concrete types to these shapes via structural
 * typing.
 */
export type UiRef = string;

export type FormFieldKind =
  | 'text'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'date'
  | 'phone'
  | 'url'
  | 'email'
  | 'number'
  | 'multiselect';

export interface FormField {
  ref: UiRef;
  selector?: string;
  label: string;
  kind: FormFieldKind;
  required: boolean;
  options?: string[];
  value?: string;
  disabled?: boolean;
  canonicalKey?: string;
}

export type ResolveSource = 'profile' | 'answers' | 'cv';

export type FieldResolution =
  | { kind: 'resolved'; value: string; source: ResolveSource }
  | { kind: 'unknown' };

/**
 * Minimum job fields the apply graph reads. Wider Job rows include
 * scoring metadata, salary, etc. that the graph doesn't touch.
 */
export interface JobSlice {
  id: string;
  title: string;
  company: string;
  description: string;
  apply_method: 'auto' | 'manual';
}

export type SubmitOutcome =
  | { ok: true }
  | { ok: false; reason: 'captcha' | 'session_expired' | 'other'; detail?: string };

export interface NewAlertInput {
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  description: string;
  applicationId?: string;
  payload?: Record<string, unknown>;
  /** Optional screenshot bytes attached to the alert. */
  screenshotPngBase64?: string;
}

/**
 * Capabilities the apply graph (`graphs/apply.ts`) drives. The server
 * constructs a concrete instance (Chunk 18) — the orchestrator never
 * imports `@vina/automation` or `@vina/server` itself. Mirrors the
 * `ManualApplyToolKit` pattern from `tools/types.ts`.
 */
export interface AutoApplyToolKit {
  // -- Reads --
  getJob(jobId: string): Promise<JobSlice>;
  /** Free-form context blob handed to the LLM fallback (profile + answers). */
  getProfileContext(): Promise<string>;
  /** True when the user has explicitly approved this application's submission. */
  isApplicationApproved(applicationId: string): Promise<boolean>;
  /** Current approval setting. */
  getApprovalSetting(): Promise<'auto-apply' | 'review-first'>;

  // -- Resolution --
  /**
   * Returns `{resolved, value, source}` or `{unknown}` for a single
   * field. Server-side: wraps `resolveFieldValue` from automation with
   * the application's profile + answers + CV text.
   */
  resolveField(input: {
    field: FormField;
    applicationId: string;
  }): Promise<FieldResolution>;

  // -- Tailoring --
  /**
   * Ensures the tailored CV exists; returns its path. Server-side this
   * runs the `tailor-cv` graph on first call and caches the result so
   * re-runs after alert resolution don't tailor twice.
   */
  ensureTailoredCv(input: {
    applicationId: string;
    jobId: string;
    cvId: string;
  }): Promise<{ tailoredCvPath: string }>;

  // -- Browser --
  openJobApplication(input: { jobId: string }): Promise<{ formId: string }>;
  inspectFields(input: { formId: string }): Promise<readonly FormField[]>;
  fillField(input: { formId: string; ref: UiRef; value: string }): Promise<void>;
  uploadCv(input: { formId: string; path: string }): Promise<void>;
  uploadCoverLetter(input: { formId: string; path: string }): Promise<void>;
  /** Click any "Continue"/"Next" button. Returns `advanced: true` if a step was advanced to. */
  advanceStep(input: { formId: string }): Promise<{ advanced: boolean }>;
  submit(input: { formId: string }): Promise<SubmitOutcome>;
  takeScreenshot(input: { formId: string }): Promise<{ pngBase64: string }>;
  closeApplication(input: { formId: string }): Promise<void>;

  // -- Alerts --
  createAlert(input: NewAlertInput): Promise<{ id: string }>;
}
