import { describe, expect, it } from 'vitest';
import { JobSchema } from './job.js';

const baseJob = {
  id: '01HJOB',
  site_id: 'linkedin',
  external_id: 'abc123',
  url: 'https://www.linkedin.com/jobs/view/abc123',
  external_apply_url: null,
  apply_method: 'auto' as const,
  original_source: null,
  title: 'Senior Backend Engineer',
  company: 'Acme',
  location: 'Remote',
  description: 'We need a backend engineer.',
  salary_text: '£90k-£120k',
  posted_at: '2026-04-25T08:00:00Z',
  discovered_at: '2026-04-28T08:00:00Z',
  match_score: null,
  match_justification: null,
  status: 'new' as const,
};

describe('JobSchema', () => {
  it('parses an auto-apply LinkedIn job', () => {
    expect(JobSchema.parse(baseJob)).toEqual(baseJob);
  });

  it('parses a manual-apply Google Jobs row with original_source', () => {
    const row = {
      ...baseJob,
      site_id: 'google',
      apply_method: 'manual' as const,
      external_apply_url: 'https://acme.greenhouse.io/jobs/123',
      original_source: 'Greenhouse',
    };
    expect(JobSchema.parse(row)).toEqual(row);
  });

  it('rejects invalid apply_method', () => {
    expect(() => JobSchema.parse({ ...baseJob, apply_method: 'maybe' })).toThrow();
  });

  it('accepts null for nullable columns', () => {
    expect(
      JobSchema.parse({
        ...baseJob,
        location: null,
        salary_text: null,
        posted_at: null,
        match_score: null,
        match_justification: null,
        external_apply_url: null,
        original_source: null,
      }),
    ).toBeTruthy();
  });

  it('rejects out-of-range match_score', () => {
    expect(() => JobSchema.parse({ ...baseJob, match_score: 150 })).toThrow();
  });
});
