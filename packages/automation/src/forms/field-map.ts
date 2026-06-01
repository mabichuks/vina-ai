/**
 * Canonical field keys + their label synonyms. Starter set covers the
 * fields the manual-apply pipeline already populates (CV/cover-letter
 * upload aside — those flow through dedicated adapter methods, not the
 * generic walker). Extend the list as new sites surface new field labels.
 */
export interface CanonicalKeySpec {
  key: string;
  /** Lower-cased substrings; matched against the field's accessible label. */
  synonyms: readonly string[];
}

export const CANONICAL_KEYS: readonly CanonicalKeySpec[] = [
  { key: 'first_name', synonyms: ['first name', 'given name', 'forename'] },
  { key: 'last_name', synonyms: ['last name', 'family name', 'surname'] },
  { key: 'full_name', synonyms: ['full name', 'your name'] },
  { key: 'email', synonyms: ['e-mail', 'email'] },
  { key: 'phone', synonyms: ['mobile', 'telephone', 'phone'] },
  { key: 'linkedin_url', synonyms: ['linkedin'] },
  { key: 'github_url', synonyms: ['github'] },
  { key: 'website_url', synonyms: ['portfolio', 'personal site', 'website'] },
  { key: 'location_city', synonyms: ['city'] },
  { key: 'location_country', synonyms: ['country'] },
  { key: 'current_company', synonyms: ['current company', 'company'] },
  { key: 'current_title', synonyms: ['current title', 'job title', 'title'] },
  { key: 'years_experience', synonyms: ['years of experience', 'years experience'] },
];

/**
 * Match a label to its canonical key. Returns the longest synonym match
 * (so "first name" wins over "name" for first_name; "linkedin" beats a
 * generic "url" match). Returns undefined when nothing matches.
 */
export function matchCanonicalKey(label: string): string | undefined {
  const normalized = label.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  let best: { key: string; len: number } | undefined;
  for (const spec of CANONICAL_KEYS) {
    for (const syn of spec.synonyms) {
      if (normalized.includes(syn)) {
        if (!best || syn.length > best.len) {
          best = { key: spec.key, len: syn.length };
        }
      }
    }
  }
  return best?.key;
}
