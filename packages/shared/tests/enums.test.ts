import { describe, expect, it } from 'vitest';
import {
  ALERT_KINDS,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  APPLICATION_EVENT_KINDS,
  APPLICATION_STATUSES,
  APPLY_METHODS,
  CHAT_ROLES,
  EASY_APPLY_MODES,
  JOB_STATUSES,
  LLM_PROVIDER_KINDS,
  SITE_KINDS,
  TASK_KINDS,
  TASK_STATUSES,
} from '../src/enums.js';

describe('ALERT_KINDS — google jobs slice additions', () => {
  it.each([
    'serpapi_key_missing',
    'serpapi_key_invalid',
    'serpapi_quota_exhausted',
  ])('includes %s', (kind) => {
    expect(ALERT_KINDS as readonly string[]).toContain(kind);
  });
});

describe('ALERT_KINDS — linkedin slice additions', () => {
  it.each([
    'linkedin_session_expired',
    'search_failed',
    'score_failed',
    'schedule_paused',
    'provider_failed',
  ])('includes %s', (kind) => {
    expect(ALERT_KINDS as readonly string[]).toContain(kind);
  });
});

describe('enum constants', () => {
  it('match the database CHECK constraint snapshot', () => {
    expect({
      JOB_STATUSES,
      APPLICATION_STATUSES,
      APPLY_METHODS,
      SITE_KINDS,
      EASY_APPLY_MODES,
      ALERT_KINDS,
      ALERT_SEVERITIES,
      ALERT_STATUSES,
      LLM_PROVIDER_KINDS,
      TASK_KINDS,
      TASK_STATUSES,
      APPLICATION_EVENT_KINDS,
      CHAT_ROLES,
    }).toMatchInlineSnapshot(`
      {
        "ALERT_KINDS": [
          "missing_field",
          "captcha",
          "session_expired",
          "awaiting_approval",
          "apply_failed",
          "ready_for_manual_apply",
          "general",
          "linkedin_session_expired",
          "search_failed",
          "score_failed",
          "schedule_paused",
          "provider_failed",
          "serpapi_key_missing",
          "serpapi_key_invalid",
          "serpapi_quota_exhausted",
        ],
        "ALERT_SEVERITIES": [
          "info",
          "action_required",
          "error",
        ],
        "ALERT_STATUSES": [
          "open",
          "resolved",
          "dismissed",
        ],
        "APPLICATION_EVENT_KINDS": [
          "created",
          "cv_tailored",
          "cv_approved",
          "cv_rejected",
          "apply_started",
          "field_filled",
          "field_unknown",
          "captcha_detected",
          "session_expired",
          "submitted",
          "failed",
          "resumed",
          "ready_for_manual_apply",
          "applied_manually",
        ],
        "APPLICATION_STATUSES": [
          "queued",
          "applying",
          "awaiting_user",
          "awaiting_approval",
          "ready_for_manual_apply",
          "submitted",
          "applied_manually",
          "failed",
          "skipped",
        ],
        "APPLY_METHODS": [
          "auto",
          "manual",
        ],
        "CHAT_ROLES": [
          "user",
          "assistant",
          "tool",
          "system",
        ],
        "EASY_APPLY_MODES": [
          "autonomous",
          "manual",
        ],
        "JOB_STATUSES": [
          "new",
          "scored",
          "queued",
          "applying",
          "awaiting_user",
          "awaiting_approval",
          "ready_for_manual_apply",
          "submitted",
          "applied_manually",
          "failed",
          "skipped",
          "dismissed",
        ],
        "LLM_PROVIDER_KINDS": [
          "anthropic",
          "openai",
          "ollama",
        ],
        "SITE_KINDS": [
          "browser",
          "api",
        ],
        "TASK_KINDS": [
          "search",
          "score",
          "tailor",
          "apply",
          "prepare_manual_apply",
          "resume",
        ],
        "TASK_STATUSES": [
          "pending",
          "running",
          "completed",
          "failed",
          "cancelled",
        ],
      }
    `);
  });
});
