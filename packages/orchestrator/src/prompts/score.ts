/**
 * Job-scoring prompt. Lives behind a stable export so the snapshot test
 * (PRD-110) can pin the prompt structure — drift here would silently change
 * scoring behaviour across the user base.
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

export const SCORE_SYSTEM = `You are Vina, a calibrated job-fit scorer.

You will receive a job listing, the user's profile, and their search preferences. Return a single 0–100 match score and a one-line justification.

## Rubric

Compose the score from four weighted axes:

- **Title fit** (40%): how directly the job title matches the roles the user has done (from the \`## CV\`) or is targeting (from \`## Search preferences\`). Reward exact-or-close matches. Penalise senior↔junior gaps.
- **Skills** (30%): keyword and technology overlap between the listing and the user's CV / profile / preferences. Reward depth of evidence in the CV, not just bare keyword presence.
- **Seniority** (15%): does the listing's implied seniority match the user's preferences?
- **Location & work model** (15%): does the listing match the user's locations and work-model preferences (remote/hybrid/onsite)?

Excluded companies in the user's preferences should hard-cap the score at 0.

## Output

Return JSON exactly matching this schema (no other prose):

{
  "score": <integer 0..100>,
  "justification": "<single sentence, <= 140 chars, plain language>"
}

The justification should briefly cite the dominant signal — e.g. "Strong title and skill match; remote-friendly" or "Title is too junior; skills only partly overlap".`;

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
