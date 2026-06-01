import type { FormField } from './types.js';

/**
 * Shape the resolver reads from a profile. `@vina/shared`'s `Profile` is
 * structurally assignable to this — the resolver intentionally narrows so
 * tests and callers can pass plain objects.
 */
export interface ResolveProfile {
  full_name: string;
  email: string;
  phone: string | null;
  location: string | null;
  linkedin_url: string | null;
  website_url: string | null;
}

/** A saved screening-question answer (`profile_answers` row). */
export interface AnswerEntry {
  /** Canonical key if the question maps to one (e.g. 'years_experience'). */
  key: string;
  /** Original question label as the site presented it. */
  label: string;
  value: string;
}

export interface ResolveContext {
  profile: ResolveProfile;
  answers: readonly AnswerEntry[];
  /** Raw CV text — searched only for narrow, unambiguous canonical-key cases. */
  cvText?: string;
}

export type ResolveSource = 'profile' | 'answers' | 'cv';

export type ResolveResult =
  | { kind: 'resolved'; value: string; source: ResolveSource }
  | { kind: 'unknown' };

function splitFullName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0]!, last: '' };
  return { first: parts[0]!, last: parts.slice(1).join(' ') };
}

function fromProfile(canonical: string, profile: ResolveProfile): string | null {
  switch (canonical) {
    case 'full_name':
      return profile.full_name.trim() || null;
    case 'first_name': {
      const { first } = splitFullName(profile.full_name);
      return first || null;
    }
    case 'last_name': {
      const { last } = splitFullName(profile.full_name);
      return last || null;
    }
    case 'email':
      return profile.email.trim() || null;
    case 'phone':
      return profile.phone?.trim() || null;
    case 'linkedin_url':
      return profile.linkedin_url?.trim() || null;
    case 'website_url':
      return profile.website_url?.trim() || null;
    case 'location_city': {
      const loc = profile.location?.trim();
      if (!loc) return null;
      const [city] = loc.split(',').map((s) => s.trim());
      return city || null;
    }
    case 'location_country': {
      const loc = profile.location?.trim();
      if (!loc) return null;
      const parts = loc.split(',').map((s) => s.trim()).filter(Boolean);
      // Only resolve country when the location string explicitly carries one.
      // A bare "London" stays unknown so the LLM fallback can decide.
      return parts.length > 1 ? parts[parts.length - 1]! : null;
    }
    default:
      return null;
  }
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

function fromAnswers(
  field: FormField,
  answers: readonly AnswerEntry[],
): string | null {
  if (field.canonicalKey) {
    const byKey = answers.find((a) => a.key === field.canonicalKey);
    if (byKey) return byKey.value;
  }
  const normLabel = normalizeLabel(field.label);
  if (!normLabel) return null;
  const byLabel = answers.find((a) => normalizeLabel(a.label) === normLabel);
  return byLabel?.value ?? null;
}

function fromCv(field: FormField, cvText: string | undefined): string | null {
  if (!cvText) return null;
  // Narrow set of unambiguous canonical-key heuristics. Everything else
  // stays in the LLM-fallback path — fuzzy CV matches are too easy to get
  // wrong and the no-fabrication rule (browser-apply skill) is load-bearing.
  if (field.canonicalKey === 'years_experience') {
    const match = /(\d+)\s*\+?\s*years?(?:\s+of)?\s+(?:professional\s+)?experience/i.exec(
      cvText,
    );
    if (match && match[1]) return match[1];
  }
  return null;
}

/**
 * Deterministically resolve a value for one field (ADR-022, M25 bullet 4).
 * Priority: profile → answers → CV. The first hit wins; everything else
 * is `unknown`, which the caller routes to the LLM fallback. Never guesses.
 */
export function resolveFieldValue(
  field: FormField,
  ctx: ResolveContext,
): ResolveResult {
  if (field.canonicalKey) {
    const fromProf = fromProfile(field.canonicalKey, ctx.profile);
    if (fromProf) return { kind: 'resolved', value: fromProf, source: 'profile' };
  }
  const fromAns = fromAnswers(field, ctx.answers);
  if (fromAns) return { kind: 'resolved', value: fromAns, source: 'answers' };
  const fromCvText = fromCv(field, ctx.cvText);
  if (fromCvText) return { kind: 'resolved', value: fromCvText, source: 'cv' };
  return { kind: 'unknown' };
}
