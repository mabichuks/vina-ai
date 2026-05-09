import { describe, expect, it } from 'vitest';
import {
  ApplicationEventSchema,
  ApplicationSchema,
  MarkAppliedRequestSchema,
} from './application.js';

const baseApp = {
  id: '01HAPP',
  job_id: '01HJOB',
  cv_id: '01HCV',
  cover_letter_id: null,
  apply_method: 'auto' as const,
  tailored_cv_path: 'tailored/01HAPP.docx',
  tailored_cover_letter_path: null,
  status: 'queued' as const,
  started_at: '2026-04-28T09:00:00Z',
  submitted_at: null,
  applied_manually_at: null,
  applied_manually_notes: null,
  failure_reason: null,
  form_state: null,
};

describe('ApplicationSchema', () => {
  it('parses a queued auto-apply application', () => {
    expect(ApplicationSchema.parse(baseApp)).toEqual(baseApp);
  });

  it('parses a completed manual-apply application', () => {
    const row = {
      ...baseApp,
      apply_method: 'manual' as const,
      status: 'applied_manually' as const,
      applied_manually_at: '2026-04-29T10:00:00Z',
      applied_manually_notes: 'Submitted via Greenhouse.',
    };
    expect(ApplicationSchema.parse(row)).toEqual(row);
  });

  it('rejects invalid apply_method', () => {
    expect(() => ApplicationSchema.parse({ ...baseApp, apply_method: 'auto-pilot' })).toThrow();
  });

  it('rejects status not in ApplicationStatus', () => {
    // 'new' is a valid JobStatus but NOT a valid ApplicationStatus
    expect(() => ApplicationSchema.parse({ ...baseApp, status: 'new' })).toThrow();
  });

  it('accepts null for all nullable columns', () => {
    expect(ApplicationSchema.parse(baseApp)).toBeTruthy();
  });
});

describe('ApplicationEventSchema', () => {
  it('parses a ready_for_manual_apply event', () => {
    const ev = {
      id: '01HEV',
      application_id: '01HAPP',
      kind: 'ready_for_manual_apply' as const,
      payload: '{"external_apply_url":"https://x"}',
      screenshot_path: null,
      created_at: '2026-04-28T10:00:00Z',
    };
    expect(ApplicationEventSchema.parse(ev)).toEqual(ev);
  });

  it('rejects unknown event kind', () => {
    expect(() =>
      ApplicationEventSchema.parse({
        id: '01HEV',
        application_id: '01HAPP',
        kind: 'rocket_launched',
        payload: null,
        screenshot_path: null,
        created_at: '2026-04-28T10:00:00Z',
      }),
    ).toThrow();
  });
});

describe('MarkAppliedRequestSchema', () => {
  it('accepts an empty body', () => {
    expect(MarkAppliedRequestSchema.parse({})).toEqual({});
  });

  it('accepts applied_at and notes', () => {
    const body = { applied_at: '2026-04-28T11:00:00Z', notes: 'Done via Workday' };
    expect(MarkAppliedRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects malformed applied_at', () => {
    expect(() => MarkAppliedRequestSchema.parse({ applied_at: 'yesterday' })).toThrow();
  });
});
