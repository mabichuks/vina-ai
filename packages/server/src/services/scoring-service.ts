import { z } from 'zod';
import { ProviderError } from '@vina/shared';
import type { StructuredScorer } from '@vina/orchestrator';

/**
 * Deterministic job scoring, relocated out of the orchestrator's
 * `graphs/score-job.ts` (deleted in #19). Scoring is a fixed-rubric
 * structured-output call — a Vina fact, not a judgment (ADR-024 §8) — so it
 * stays in Vina code and the `score` queue handler calls it directly rather
 * than through an agent session. `vina_score_job` remains the tool a sweep
 * session calls.
 *
 * The rubric system prompt below is ported **verbatim** from the deleted
 * `packages/orchestrator/prompts/score.md` (issue Notes forbid re-authoring).
 */

/**
 * Output schema enforced via `withStructuredOutput`. Score is clamped to
 * [0, 100] and rounded to the nearest integer downstream — the LLM
 * occasionally returns 105 or 99.5 even with the rubric instructions.
 */
export const ScoreSchema = z.object({
  score: z.number(),
  justification: z.string().min(1),
});
export type ScoreResult = { score: number; justification: string };

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

const SCORE_SYSTEM_PROMPT = `You are Vina, a calibrated job-fit scorer.

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

const MAX_ATTEMPTS = 2;

/**
 * Score a single job against the user's profile and preferences. One retry
 * on malformed model output (zod parse failure inside `withStructuredOutput`,
 * or any thrown error). Hard fail with `ProviderError` on the second miss.
 */
export async function runScoreJob(
  input: ScoreInput,
  model: StructuredScorer,
): Promise<ScoreResult> {
  const structured = model.withStructuredOutput(ScoreSchema);
  const messages: ReadonlyArray<{ role: 'system' | 'user'; content: string }> = [
    { role: 'system', content: SCORE_SYSTEM_PROMPT },
    { role: 'user', content: scoreUserPrompt(input) },
  ];

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await structured.invoke(messages);
      // Clamp + round so a model that returns 105 or 73.4 still produces
      // a valid `match_score` for the DB (CHECK constraint requires 0..100).
      return {
        score: Math.max(0, Math.min(100, Math.round(raw.score))),
        justification: raw.justification.trim(),
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw new ProviderError('Score graph failed after retry', {
    cause: lastError instanceof Error ? lastError.message : String(lastError),
  });
}
