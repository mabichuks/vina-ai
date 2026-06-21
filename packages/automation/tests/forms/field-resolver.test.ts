import { describe, expect, it } from 'vitest';
import {
  resolveFieldValue,
  type AnswerEntry,
  type ResolveContext,
  type ResolveProfile,
} from '../../src/forms/field-resolver.js';
import type { FormField } from '../../src/forms/types.js';

const PROFILE: ResolveProfile = {
  full_name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+44 20 7946 0991',
  location: 'London, United Kingdom',
  linkedin_url: 'https://linkedin.com/in/ada',
  website_url: 'https://ada.dev',
};

function field(partial: Partial<FormField> & { label: string }): FormField {
  return {
    ref: 'r1',
    kind: 'text',
    required: false,
    ...partial,
  };
}

function ctx(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    profile: PROFILE,
    answers: [],
    ...overrides,
  };
}

describe('resolveFieldValue — profile source', () => {
  it('resolves first_name by splitting full_name', () => {
    const result = resolveFieldValue(
      field({ label: 'First name', canonicalKey: 'first_name' }),
      ctx(),
    );
    expect(result).toEqual({ kind: 'resolved', value: 'Ada', source: 'profile' });
  });

  it('resolves last_name as everything after the first token', () => {
    const result = resolveFieldValue(
      field({ label: 'Last name', canonicalKey: 'last_name' }),
      ctx({ profile: { ...PROFILE, full_name: 'Ada Augusta King-Noel' } }),
    );
    expect(result).toEqual({
      kind: 'resolved',
      value: 'Augusta King-Noel',
      source: 'profile',
    });
  });

  it('resolves full_name verbatim', () => {
    const result = resolveFieldValue(
      field({ label: 'Full name', canonicalKey: 'full_name' }),
      ctx(),
    );
    expect(result).toEqual({
      kind: 'resolved',
      value: 'Ada Lovelace',
      source: 'profile',
    });
  });

  it('resolves email/phone/linkedin/website from profile', () => {
    const cases: Array<[string, string]> = [
      ['email', 'ada@example.com'],
      ['phone', '+44 20 7946 0991'],
      ['linkedin_url', 'https://linkedin.com/in/ada'],
      ['website_url', 'https://ada.dev'],
    ];
    for (const [key, expected] of cases) {
      const result = resolveFieldValue(
        field({ label: key, canonicalKey: key }),
        ctx(),
      );
      expect(result).toEqual({ kind: 'resolved', value: expected, source: 'profile' });
    }
  });

  it('splits profile.location for location_city / location_country', () => {
    const city = resolveFieldValue(
      field({ label: 'City', canonicalKey: 'location_city' }),
      ctx(),
    );
    expect(city).toEqual({ kind: 'resolved', value: 'London', source: 'profile' });
    const country = resolveFieldValue(
      field({ label: 'Country', canonicalKey: 'location_country' }),
      ctx(),
    );
    expect(country).toEqual({
      kind: 'resolved',
      value: 'United Kingdom',
      source: 'profile',
    });
  });

  it('returns unknown for location_country when location has no comma', () => {
    const result = resolveFieldValue(
      field({ label: 'Country', canonicalKey: 'location_country' }),
      ctx({ profile: { ...PROFILE, location: 'London' } }),
    );
    expect(result.kind).toBe('unknown');
  });

  it('returns unknown when the profile slot is null', () => {
    const result = resolveFieldValue(
      field({ label: 'Phone', canonicalKey: 'phone' }),
      ctx({ profile: { ...PROFILE, phone: null } }),
    );
    expect(result.kind).toBe('unknown');
  });
});

describe('resolveFieldValue — answers source', () => {
  it('matches by canonical key when profile cannot resolve', () => {
    const answers: AnswerEntry[] = [
      { key: 'years_experience', label: 'Years of experience', value: '7' },
    ];
    const result = resolveFieldValue(
      field({
        label: 'Years of experience',
        canonicalKey: 'years_experience',
        kind: 'number',
      }),
      ctx({ answers }),
    );
    expect(result).toEqual({ kind: 'resolved', value: '7', source: 'answers' });
  });

  it('matches by exact label when there is no canonical key', () => {
    const answers: AnswerEntry[] = [
      { key: 'sponsorship', label: 'Do you require sponsorship?', value: 'No' },
    ];
    const result = resolveFieldValue(
      field({ label: 'Do you require sponsorship?', kind: 'select' }),
      ctx({ answers }),
    );
    expect(result).toEqual({ kind: 'resolved', value: 'No', source: 'answers' });
  });

  it('label match is whitespace/case-insensitive', () => {
    const answers: AnswerEntry[] = [
      { key: 'auth', label: 'Authorized to work in the UK', value: 'Yes' },
    ];
    const result = resolveFieldValue(
      field({ label: '  AUTHORIZED  to work  in the UK  ', kind: 'select' }),
      ctx({ answers }),
    );
    expect(result.kind).toBe('resolved');
    expect((result as { value: string }).value).toBe('Yes');
  });

  it('profile beats answers when both have data', () => {
    const answers: AnswerEntry[] = [
      { key: 'email', label: 'Email', value: 'stale@example.com' },
    ];
    const result = resolveFieldValue(
      field({ label: 'Email', canonicalKey: 'email' }),
      ctx({ answers }),
    );
    expect(result).toEqual({
      kind: 'resolved',
      value: 'ada@example.com',
      source: 'profile',
    });
  });
});

describe('resolveFieldValue — CV source', () => {
  it('extracts years_experience from CV text', () => {
    const cvText = 'Senior Engineer with 12 years experience in distributed systems.';
    const result = resolveFieldValue(
      field({
        label: 'Years of experience',
        canonicalKey: 'years_experience',
        kind: 'number',
      }),
      ctx({ cvText }),
    );
    expect(result).toEqual({ kind: 'resolved', value: '12', source: 'cv' });
  });

  it('handles "N+ years of experience" phrasing', () => {
    const cvText = 'Software engineer, 5+ years of experience across full-stack.';
    const result = resolveFieldValue(
      field({ label: 'Years', canonicalKey: 'years_experience', kind: 'number' }),
      ctx({ cvText }),
    );
    expect(result).toEqual({ kind: 'resolved', value: '5', source: 'cv' });
  });

  it('does not invent values for non-whitelisted canonical keys', () => {
    const cvText = 'Worked at Acme Corp as Senior Engineer.';
    const result = resolveFieldValue(
      field({
        label: 'Current company',
        canonicalKey: 'current_company',
        kind: 'text',
      }),
      ctx({ cvText }),
    );
    // Bullet 4: never fabricate. Skip CV fuzz-matching for everything except
    // the narrow whitelist.
    expect(result.kind).toBe('unknown');
  });
});

describe('resolveFieldValue — unknown', () => {
  it('returns unknown when no canonical key and no label-match in answers', () => {
    const result = resolveFieldValue(
      field({ label: 'Why should we hire you?', kind: 'textarea' }),
      ctx(),
    );
    expect(result.kind).toBe('unknown');
  });

  it('returns unknown when canonical key is not in profile or answers', () => {
    const result = resolveFieldValue(
      field({ label: 'GitHub', canonicalKey: 'github_url', kind: 'url' }),
      ctx(),
    );
    expect(result.kind).toBe('unknown');
  });
});

describe('resolveFieldValue — EEO short-circuit', () => {
  it('marks gender questions as unknown even with a saved answer', () => {
    const answers: AnswerEntry[] = [
      { key: 'gender', label: 'Gender', value: 'Female' },
    ];
    const result = resolveFieldValue(
      field({
        label: 'Gender',
        kind: 'select',
        options: ['Male', 'Female', 'Prefer not to answer'],
      }),
      ctx({ answers }),
    );
    expect(result.kind).toBe('unknown');
  });

  it('marks veteran-status questions as unknown', () => {
    const result = resolveFieldValue(
      field({
        label: 'Veteran status',
        kind: 'select',
        options: ['Yes', 'No', 'Prefer not to answer'],
      }),
      ctx(),
    );
    expect(result.kind).toBe('unknown');
  });

  it('marks race/ethnicity questions as unknown', () => {
    const result = resolveFieldValue(
      field({
        label: 'Race / Ethnicity',
        kind: 'select',
        options: ['White', 'Asian', 'Prefer not to say'],
      }),
      ctx(),
    );
    expect(result.kind).toBe('unknown');
  });

  it('marks disability questions as unknown', () => {
    const result = resolveFieldValue(
      field({
        label: 'Do you have a disability?',
        kind: 'select',
        options: ['Yes', 'No', 'Prefer not to disclose'],
      }),
      ctx(),
    );
    expect(result.kind).toBe('unknown');
  });

  it('still resolves normal questions from profile', () => {
    const result = resolveFieldValue(
      field({ label: 'Email address', canonicalKey: 'email' }),
      ctx(),
    );
    expect(result).toEqual({
      kind: 'resolved',
      value: 'ada@example.com',
      source: 'profile',
    });
  });
});
