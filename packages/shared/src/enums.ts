export const JOB_STATUSES = [
  'new',
  'scored',
  'queued',
  'applying',
  'awaiting_user',
  'awaiting_approval',
  'ready_for_manual_apply',
  'submitted',
  'applied_manually',
  'failed',
  'skipped',
  'dismissed',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const APPLICATION_STATUSES = [
  'queued',
  'applying',
  'awaiting_user',
  'awaiting_approval',
  'ready_for_manual_apply',
  'submitted',
  'applied_manually',
  'failed',
  'skipped',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLY_METHODS = ['auto', 'manual'] as const;
export type ApplyMethod = (typeof APPLY_METHODS)[number];

export const SITE_KINDS = ['browser', 'api'] as const;
export type SiteKind = (typeof SITE_KINDS)[number];

export const OPERATING_MODES = ['autonomous', 'supervised'] as const;
export type OperatingMode = (typeof OPERATING_MODES)[number];

export const APPROVAL_SETTINGS = ['auto-apply', 'review-first'] as const;
export type ApprovalSetting = (typeof APPROVAL_SETTINGS)[number];

export const ALERT_KINDS = [
  'missing_field',
  'captcha',
  'session_expired',
  'awaiting_approval',
  'apply_failed',
  'ready_for_manual_apply',
  'general',
  'linkedin_session_expired',
  'search_failed',
  'score_failed',
  'schedule_paused',
  'provider_failed',
  'serpapi_key_missing',
  'serpapi_key_invalid',
  'serpapi_quota_exhausted',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_SEVERITIES = ['info', 'action_required', 'error'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const LLM_PROVIDER_KINDS = ['anthropic', 'openai', 'ollama'] as const;
export type LlmProviderKind = (typeof LLM_PROVIDER_KINDS)[number];

export const TASK_KINDS = [
  'search',
  'score',
  'tailor',
  'apply',
  'prepare_manual_apply',
  'resume',
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const APPLICATION_EVENT_KINDS = [
  'created',
  'cv_tailored',
  'cv_approved',
  'cv_rejected',
  'apply_started',
  'field_filled',
  'field_unknown',
  'captcha_detected',
  'session_expired',
  'submitted',
  'failed',
  'resumed',
  'ready_for_manual_apply',
  'applied_manually',
] as const;
export type ApplicationEventKind = (typeof APPLICATION_EVENT_KINDS)[number];

export const CHAT_ROLES = ['user', 'assistant', 'tool', 'system'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];
