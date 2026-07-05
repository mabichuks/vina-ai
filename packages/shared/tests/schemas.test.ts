import { describe, expect, it } from 'vitest';
import { AlertSchema } from '../src/schemas/alert.js';
import {
  ApplicationEventSchema,
  ApplicationSchema,
  MarkAppliedRequestSchema,
} from '../src/schemas/application.js';
import { ChatMessageSchema } from '../src/schemas/chat.js';
import { JobSchema } from '../src/schemas/job.js';
import { LlmProviderInputSchema, LlmProviderSchema } from '../src/schemas/llm.js';
import {
  SearchPreferencesInputSchema,
  SearchPreferencesSchema,
} from '../src/schemas/preferences.js';
import {
  CoverLetterSchema,
  CvSchema,
  ProfileInputSchema,
  ProfileSchema,
} from '../src/schemas/profile.js';
import { SettingsSchema, SettingsUpdateSchema } from '../src/schemas/settings.js';
import { SiteSchema } from '../src/schemas/site.js';
import { TaskSchema } from '../src/schemas/task.js';

describe('profile / cv / cover-letter schemas', () => {
  it('parses a representative profile and rejects bad email + bad id', () => {
    const fixture = {
      id: 'me' as const,
      full_name: 'Ada',
      email: 'ada@example.com',
      phone: null,
      location: null,
      linkedin_url: null,
      website_url: null,
      bio: null,
      created_at: '2026-04-01T12:00:00Z',
      updated_at: '2026-04-28T12:00:00Z',
    };
    expect(ProfileSchema.parse(fixture)).toEqual(fixture);
    expect(() => ProfileSchema.parse({ ...fixture, id: 'other' })).toThrow();
    expect(() => ProfileInputSchema.parse({ full_name: 'x', email: 'not-an-email' })).toThrow();
  });

  it('parses a CV row and rejects an unknown mime_type', () => {
    const cv = {
      id: '01CV',
      label: 'A',
      original_filename: 'cv.pdf',
      mime_type: 'application/pdf' as const,
      file_path: 'cvs/a.pdf',
      extracted_text: null,
      is_default: true,
      created_at: '2026-04-01T12:00:00Z',
    };
    expect(CvSchema.parse(cv)).toEqual(cv);
    expect(() => CvSchema.parse({ ...cv, mime_type: 'text/plain' })).toThrow();
    // CoverLetter is structurally identical — one happy-path parse covers it.
    expect(CoverLetterSchema.parse(cv)).toEqual(cv);
  });
});

describe('preferences / settings schemas', () => {
  it('parses preferences and rejects bad work_model', () => {
    const fixture = {
      id: 'default' as const,
      description: 'x',
      keywords: ['ts'],
      locations: [],
      work_models: ['remote'] as const,
      seniority: ['senior'] as const,
      min_salary: null,
      max_salary: null,
      salary_currency: 'GBP',
      excluded_companies: [],
      score_threshold: 75,
      updated_at: '2026-04-28T12:00:00Z',
    };
    expect(SearchPreferencesSchema.parse(fixture)).toEqual(fixture);
    expect(() => SearchPreferencesSchema.parse({ ...fixture, work_models: ['wfh'] })).toThrow();
    // Input is fully partial — empty object is valid.
    expect(SearchPreferencesInputSchema.parse({ score_threshold: 85 })).toEqual({
      score_threshold: 85,
    });
    expect(SearchPreferencesInputSchema.parse({})).toEqual({});
  });

  it('settings response never carries serpapi_key; update accepts plaintext or null', () => {
    const settings = {
      id: 'app' as const,
      easy_apply_mode: 'autonomous' as const,
      autonomous_apply_dry_run: false,
      apply_daily_cap: 10,
      apply_min_interval_seconds: 300,
      apply_listing_max_age_days: 14,
      apply_consecutive_failure_limit: 5,
      browser_headful: false,
      browser_stealth: false,
      paused: false,
      active_llm_provider_id: null,
      has_serpapi_key: true,
      updated_at: '2026-04-28T12:00:00Z',
    };
    const parsed = SettingsSchema.parse({ ...settings, serpapi_key: 'leak' });
    expect(parsed).not.toHaveProperty('serpapi_key');
    expect(SettingsUpdateSchema.parse({ serpapi_key: 'sk_x' })).toEqual({ serpapi_key: 'sk_x' });
    expect(SettingsUpdateSchema.parse({ serpapi_key: null })).toEqual({ serpapi_key: null });
    expect(() => SettingsUpdateSchema.parse({ easy_apply_mode: 'maybe' })).toThrow();
  });

  it('settings carry browser_stealth (opt-in anti-detection, ADR-021); update accepts it optionally', () => {
    const settings = {
      id: 'app' as const,
      easy_apply_mode: 'autonomous' as const,
      autonomous_apply_dry_run: false,
      apply_daily_cap: 10,
      apply_min_interval_seconds: 300,
      apply_listing_max_age_days: 14,
      apply_consecutive_failure_limit: 5,
      browser_headful: false,
      browser_stealth: false,
      paused: false,
      active_llm_provider_id: null,
      has_serpapi_key: true,
      updated_at: '2026-04-28T12:00:00Z',
    };
    // Round-trip: response carries browser_stealth and preserves the boolean.
    expect(SettingsSchema.parse(settings)).toEqual(settings);
    expect(SettingsSchema.parse({ ...settings, browser_stealth: true })).toEqual({
      ...settings,
      browser_stealth: true,
    });
    // Required in the response — a missing browser_stealth is rejected.
    const { browser_stealth: _omit, ...withoutStealth } = settings;
    expect(() => SettingsSchema.parse(withoutStealth)).toThrow();
    // Update schema accepts browser_stealth optionally; rejects non-boolean.
    expect(SettingsUpdateSchema.parse({ browser_stealth: true })).toEqual({ browser_stealth: true });
    expect(() => SettingsUpdateSchema.parse({ browser_stealth: 'yes' })).toThrow();
  });
});

describe('job / application schemas', () => {
  const baseJob = {
    id: '01J',
    site_id: 'linkedin',
    external_id: 'abc',
    url: 'https://x',
    external_apply_url: null,
    apply_method: 'auto' as const,
    original_source: null,
    title: 't',
    company: 'c',
    location: null,
    description: 'd',
    salary_text: null,
    posted_at: null,
    discovered_at: '2026-04-28T08:00:00Z',
    match_score: null,
    match_justification: null,
    status: 'new' as const,
  };

  it('parses both auto and manual jobs and rejects invalid apply_method', () => {
    expect(JobSchema.parse(baseJob)).toEqual(baseJob);
    const manual = {
      ...baseJob,
      site_id: 'google',
      apply_method: 'manual' as const,
      external_apply_url: 'https://x.greenhouse.io/jobs/1',
      original_source: 'Greenhouse',
    };
    expect(JobSchema.parse(manual)).toEqual(manual);
    expect(() => JobSchema.parse({ ...baseJob, apply_method: 'maybe' })).toThrow();
  });

  it('Application rejects job-only statuses; ApplicationEvent rejects unknown kinds', () => {
    const app = {
      id: '01A',
      job_id: '01J',
      cv_id: '01CV',
      cover_letter_id: null,
      apply_method: 'manual' as const,
      tailored_cv_path: null,
      tailored_cover_letter_path: null,
      tailored_cv_pdf_path: null,
      tailored_cover_letter_pdf_path: null,
      tailored_at: null,
      status: 'ready_for_manual_apply' as const,
      started_at: '2026-04-28T09:00:00Z',
      submitted_at: null,
      applied_manually_at: null,
      applied_manually_notes: null,
      failure_reason: null,
      form_state: null,
    };
    expect(ApplicationSchema.parse(app)).toEqual(app);
    // 'new' is a valid JobStatus but not an ApplicationStatus.
    expect(() => ApplicationSchema.parse({ ...app, status: 'new' })).toThrow();
    expect(() =>
      ApplicationEventSchema.parse({
        id: '01E',
        application_id: '01A',
        kind: 'rocket_launched',
        payload: null,
        screenshot_path: null,
        created_at: '2026-04-28T10:00:00Z',
      }),
    ).toThrow();
  });

  it('MarkAppliedRequest accepts empty/optional fields, rejects malformed dates', () => {
    expect(MarkAppliedRequestSchema.parse({})).toEqual({});
    expect(
      MarkAppliedRequestSchema.parse({ applied_at: '2026-04-28T11:00:00Z', notes: 'done' }),
    ).toEqual({ applied_at: '2026-04-28T11:00:00Z', notes: 'done' });
    expect(() => MarkAppliedRequestSchema.parse({ applied_at: 'yesterday' })).toThrow();
  });
});

describe('alert / task / chat schemas', () => {
  it('parses a ready_for_manual_apply alert and rejects unknown severity', () => {
    const alert = {
      id: '01AL',
      kind: 'ready_for_manual_apply' as const,
      severity: 'action_required' as const,
      title: 'Ready',
      description: '',
      application_id: '01A',
      site_id: 'google',
      payload: null,
      status: 'open' as const,
      resolution_value: null,
      created_at: '2026-04-28T10:00:00Z',
      resolved_at: null,
    };
    expect(AlertSchema.parse(alert)).toEqual(alert);
    expect(() => AlertSchema.parse({ ...alert, severity: 'critical' })).toThrow();
  });

  it('parses a prepare_manual_apply task; rejects negative attempts', () => {
    const task = {
      id: '01T',
      kind: 'prepare_manual_apply' as const,
      payload: '{}',
      priority: 0,
      attempts: 0,
      max_attempts: 3,
      next_attempt_at: '2026-04-28T10:00:00Z',
      started_at: null,
      failed_reason: null,
      status: 'pending' as const,
      created_at: '2026-04-28T10:00:00Z',
    };
    expect(TaskSchema.parse(task)).toEqual(task);
    expect(() => TaskSchema.parse({ ...task, attempts: -1 })).toThrow();
  });

  it('chat messages accept all four roles and reject unknown ones', () => {
    for (const role of ['user', 'assistant', 'tool', 'system'] as const) {
      const msg = {
        id: `01M-${role}`,
        role,
        content: 'x',
        tool_call_id: null,
        metadata: null,
        created_at: '2026-04-28T10:00:00Z',
      };
      expect(ChatMessageSchema.parse(msg)).toEqual(msg);
    }
    expect(() =>
      ChatMessageSchema.parse({
        id: '01M',
        role: 'agent',
        content: 'x',
        tool_call_id: null,
        metadata: null,
        created_at: '2026-04-28T10:00:00Z',
      }),
    ).toThrow();
  });
});

describe('site / llm-provider schemas', () => {
  it('api-kind sites must have null session columns; browser-kind may have one', () => {
    expect(
      SiteSchema.parse({
        id: 'google',
        display_name: 'Google',
        kind: 'api',
        enabled: true,
        session_path: null,
        session_valid_at: null,
        last_search_at: null,
      }),
    ).toBeTruthy();
    expect(
      SiteSchema.parse({
        id: 'linkedin',
        display_name: 'LinkedIn',
        kind: 'browser',
        enabled: true,
        session_path: 'sessions/linkedin.json',
        session_valid_at: '2026-04-28T07:00:00Z',
        last_search_at: null,
      }),
    ).toBeTruthy();
    expect(() =>
      SiteSchema.parse({
        id: 'google',
        display_name: 'Google',
        kind: 'api',
        enabled: true,
        session_path: 'leak.json',
        session_valid_at: null,
        last_search_at: null,
      }),
    ).toThrow();
  });

  it('LLM provider response omits api_key; input requires it for non-Ollama', () => {
    expect(
      LlmProviderSchema.parse({
        id: '01P',
        kind: 'anthropic',
        label: 'Claude',
        model: 'claude-opus-4-7',
        base_url: null,
        has_api_key: true,
        created_at: '2026-04-28T10:00:00Z',
      }),
    ).toBeTruthy();
    expect(() =>
      LlmProviderInputSchema.parse({ kind: 'openai', label: 'GPT', model: 'gpt-5' }),
    ).toThrow();
    expect(
      LlmProviderInputSchema.parse({
        kind: 'ollama',
        label: 'Local',
        model: 'llama3.1:70b',
      }),
    ).toBeTruthy();
  });
});

describe('SettingsSchema (autonomous easy apply)', () => {
  it('accepts easy_apply_mode and limit fields', () => {
    const result = SettingsSchema.parse({
      id: 'app',
      easy_apply_mode: 'manual',
      autonomous_apply_dry_run: false,
      apply_daily_cap: 10,
      apply_min_interval_seconds: 300,
      apply_listing_max_age_days: 14,
      apply_consecutive_failure_limit: 5,
      browser_headful: false,
      browser_stealth: false,
      paused: false,
      active_llm_provider_id: null,
      has_serpapi_key: false,
      updated_at: '2026-06-21T00:00:00.000Z',
    });
    expect(result.easy_apply_mode).toBe('manual');
  });

  it('rejects easy_apply_mode outside enum', () => {
    expect(() =>
      SettingsSchema.parse({
        id: 'app',
        easy_apply_mode: 'autopilot',
        autonomous_apply_dry_run: false,
        apply_daily_cap: 10,
        apply_min_interval_seconds: 300,
        apply_listing_max_age_days: 14,
        apply_consecutive_failure_limit: 5,
        browser_headful: false,
        browser_stealth: false,
        paused: false,
        active_llm_provider_id: null,
        has_serpapi_key: false,
        updated_at: '2026-06-21T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects apply_daily_cap below 1', () => {
    const base = {
      id: 'app' as const,
      easy_apply_mode: 'manual' as const,
      autonomous_apply_dry_run: false,
      apply_daily_cap: 0,
      apply_min_interval_seconds: 300,
      apply_listing_max_age_days: 14,
      apply_consecutive_failure_limit: 5,
      browser_headful: false,
      browser_stealth: false,
      paused: false,
      active_llm_provider_id: null,
      has_serpapi_key: false,
      updated_at: '2026-06-21T00:00:00.000Z',
    };
    expect(() => SettingsSchema.parse(base)).toThrow();
  });

  it('rejects apply_daily_cap above 100', () => {
    expect(() => SettingsSchema.parse({
      id: 'app', easy_apply_mode: 'manual', autonomous_apply_dry_run: false,
      apply_daily_cap: 101, apply_min_interval_seconds: 300, apply_listing_max_age_days: 14,
      apply_consecutive_failure_limit: 5, browser_headful: false, browser_stealth: false,
      paused: false, active_llm_provider_id: null, has_serpapi_key: false,
      updated_at: '2026-06-21T00:00:00.000Z',
    })).toThrow();
  });

  it('rejects apply_min_interval_seconds below 0', () => {
    expect(() => SettingsSchema.parse({
      id: 'app', easy_apply_mode: 'manual', autonomous_apply_dry_run: false,
      apply_daily_cap: 10, apply_min_interval_seconds: -1, apply_listing_max_age_days: 14,
      apply_consecutive_failure_limit: 5, browser_headful: false, browser_stealth: false,
      paused: false, active_llm_provider_id: null, has_serpapi_key: false,
      updated_at: '2026-06-21T00:00:00.000Z',
    })).toThrow();
  });

  it('rejects apply_listing_max_age_days at 0', () => {
    expect(() => SettingsSchema.parse({
      id: 'app', easy_apply_mode: 'manual', autonomous_apply_dry_run: false,
      apply_daily_cap: 10, apply_min_interval_seconds: 300, apply_listing_max_age_days: 0,
      apply_consecutive_failure_limit: 5, browser_headful: false, browser_stealth: false,
      paused: false, active_llm_provider_id: null, has_serpapi_key: false,
      updated_at: '2026-06-21T00:00:00.000Z',
    })).toThrow();
  });

  it('rejects apply_consecutive_failure_limit above 50', () => {
    expect(() => SettingsSchema.parse({
      id: 'app', easy_apply_mode: 'manual', autonomous_apply_dry_run: false,
      apply_daily_cap: 10, apply_min_interval_seconds: 300, apply_listing_max_age_days: 14,
      apply_consecutive_failure_limit: 51, browser_headful: false, browser_stealth: false,
      paused: false, active_llm_provider_id: null, has_serpapi_key: false,
      updated_at: '2026-06-21T00:00:00.000Z',
    })).toThrow();
  });

  it('rejects autonomous_apply_dry_run as a non-boolean', () => {
    expect(() => SettingsSchema.parse({
      id: 'app', easy_apply_mode: 'manual', autonomous_apply_dry_run: 'yes',
      apply_daily_cap: 10, apply_min_interval_seconds: 300, apply_listing_max_age_days: 14,
      apply_consecutive_failure_limit: 5, browser_headful: false, browser_stealth: false,
      paused: false, active_llm_provider_id: null, has_serpapi_key: false,
      updated_at: '2026-06-21T00:00:00.000Z',
    })).toThrow();
  });
});
