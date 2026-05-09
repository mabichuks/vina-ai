import { describe, expect, it } from 'vitest';
import { SearchPreferencesInputSchema, SearchPreferencesSchema } from './preferences.js';

describe('SearchPreferencesSchema', () => {
  it('parses a full row', () => {
    const fixture = {
      id: 'default' as const,
      description: 'Senior backend, remote, EU',
      keywords: ['typescript', 'go'],
      locations: ['Remote', 'Berlin'],
      work_models: ['remote', 'hybrid'] as const,
      seniority: ['senior', 'staff'] as const,
      min_salary: 80000,
      max_salary: 140000,
      salary_currency: 'GBP',
      excluded_companies: ['EvilCorp'],
      score_threshold: 75,
      updated_at: '2026-04-28T12:00:00Z',
    };
    expect(SearchPreferencesSchema.parse(fixture)).toEqual(fixture);
  });

  it('rejects work_model not in enum', () => {
    expect(() =>
      SearchPreferencesSchema.parse({
        id: 'default',
        description: 'x',
        keywords: [],
        locations: [],
        work_models: ['wfh'],
        seniority: [],
        min_salary: null,
        max_salary: null,
        salary_currency: null,
        excluded_companies: [],
        score_threshold: 70,
        updated_at: '2026-04-28T12:00:00Z',
      }),
    ).toThrow();
  });

  it('rejects salary_currency that is not 3-letter ISO', () => {
    expect(() =>
      SearchPreferencesSchema.parse({
        id: 'default',
        description: 'x',
        keywords: [],
        locations: [],
        work_models: [],
        seniority: [],
        min_salary: null,
        max_salary: null,
        salary_currency: 'pounds',
        excluded_companies: [],
        score_threshold: 70,
        updated_at: '2026-04-28T12:00:00Z',
      }),
    ).toThrow();
  });
});

describe('SearchPreferencesInputSchema', () => {
  it('accepts partial input (single field)', () => {
    expect(SearchPreferencesInputSchema.parse({ score_threshold: 85 })).toEqual({
      score_threshold: 85,
    });
  });

  it('accepts an empty object (no-op update)', () => {
    expect(SearchPreferencesInputSchema.parse({})).toEqual({});
  });
});
