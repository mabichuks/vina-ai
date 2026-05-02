import { z } from 'zod';
import { ProviderError } from '@vina/shared';
import type { Runnable } from '@langchain/core/runnables';
import { SCORE_SYSTEM, scoreUserPrompt, type ScoreInput } from '../prompts/score.js';

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

/**
 * Minimum surface a model must expose for `runScoreJob`. LangChain's
 * `BaseChatModel.withStructuredOutput(schema)` returns a runnable matching
 * this shape — and our test fakes can implement it without subclassing the
 * (large) base class.
 */
export interface StructuredScorer {
  withStructuredOutput<T>(schema: z.ZodType<T>): Runnable<ScoreMessages, T>;
}

export type ScoreMessages = ReadonlyArray<{ role: 'system' | 'user'; content: string }>;

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
  const messages: ScoreMessages = [
    { role: 'system', content: SCORE_SYSTEM },
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
