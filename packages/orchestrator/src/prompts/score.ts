/**
 * Score-graph user-prompt builder. The system prompt now lives in
 * `prompts/score.md` and is loaded by the graph at runtime; only the
 * userTemplate interpolation and its input shape stay in code (per the
 * prompt-system spec — schemas/templates are not user-editable).
 */

export interface ScoreInput {
  job: {
    title: string;
    company: string;
    location: string | null;
    description: string;
  };
  profile: {
    full_name: string;
    bio: string | null;
  };
  cv_text?: string | null;
  prefs: {
    description: string;
    keywords: string[];
    locations: string[];
    work_models: string[];
    seniority: string[];
    excluded_companies: string[];
  };
}

export function scoreUserPrompt(input: ScoreInput): string {
  const { job, profile, prefs } = input;
  const lines: string[] = [];

  lines.push('## User profile');
  lines.push(`Name: ${profile.full_name}`);
  if (profile.bio) lines.push(`Bio: ${profile.bio}`);
  lines.push('');

  if (input.cv_text && input.cv_text.trim().length > 0) {
    lines.push('## CV');
    lines.push(input.cv_text.trim());
    lines.push('');
  }

  lines.push('## Search preferences');
  if (prefs.description) lines.push(`Description: ${prefs.description}`);
  if (prefs.keywords.length) lines.push(`Keywords: ${prefs.keywords.join(', ')}`);
  if (prefs.locations.length) lines.push(`Locations: ${prefs.locations.join(', ')}`);
  if (prefs.work_models.length) lines.push(`Work models: ${prefs.work_models.join(', ')}`);
  if (prefs.seniority.length) lines.push(`Seniority: ${prefs.seniority.join(', ')}`);
  if (prefs.excluded_companies.length)
    lines.push(`Excluded companies: ${prefs.excluded_companies.join(', ')}`);
  lines.push('');

  lines.push('## Job listing');
  lines.push(`Title: ${job.title}`);
  lines.push(`Company: ${job.company}`);
  if (job.location) lines.push(`Location: ${job.location}`);
  lines.push('');
  lines.push('Description:');
  lines.push(job.description);

  return lines.join('\n');
}
