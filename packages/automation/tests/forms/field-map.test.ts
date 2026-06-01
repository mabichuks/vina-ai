import { describe, expect, it } from 'vitest';
import { matchCanonicalKey } from '../../src/forms/field-map.js';

describe('matchCanonicalKey', () => {
  it('matches canonical keys case-insensitively', () => {
    expect(matchCanonicalKey('Email')).toBe('email');
    expect(matchCanonicalKey('EMAIL')).toBe('email');
    expect(matchCanonicalKey('email address')).toBe('email');
  });

  it('handles the e-mail variant', () => {
    expect(matchCanonicalKey('E-mail')).toBe('email');
  });

  it('distinguishes first name from a generic name', () => {
    expect(matchCanonicalKey('First name')).toBe('first_name');
    expect(matchCanonicalKey('Last name')).toBe('last_name');
    expect(matchCanonicalKey('Full name')).toBe('full_name');
  });

  it('matches LinkedIn / GitHub / portfolio URLs', () => {
    expect(matchCanonicalKey('LinkedIn URL')).toBe('linkedin_url');
    expect(matchCanonicalKey('GitHub profile')).toBe('github_url');
    expect(matchCanonicalKey('Portfolio')).toBe('website_url');
    expect(matchCanonicalKey('Personal site')).toBe('website_url');
  });

  it('returns undefined when nothing matches', () => {
    expect(matchCanonicalKey('Salary expectation')).toBeUndefined();
    expect(matchCanonicalKey('')).toBeUndefined();
  });

  it('prefers the longest synonym match', () => {
    // "current title" must beat "title" so a "Current title" label maps to
    // current_title rather than current_title being shadowed by a generic
    // "title" rule.
    expect(matchCanonicalKey('Current title')).toBe('current_title');
    expect(matchCanonicalKey('Years of experience')).toBe('years_experience');
  });
});
