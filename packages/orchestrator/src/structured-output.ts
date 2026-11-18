import type { z } from 'zod';
import type { Runnable } from '@langchain/core/runnables';

/**
 * Shared structured-output surface used by the retained graphs (selector
 * resolver) and re-exported for the server's relocated scoring/tailoring
 * services. Moved out of `graphs/score-job.ts` (deleted in #19) so the
 * orchestrator no longer exports the score/tailor/prepare graphs but the
 * narrow "model that can emit structured output" contract remains stable.
 */

/**
 * Minimum surface a model must expose for a structured-output call. LangChain's
 * `BaseChatModel.withStructuredOutput(schema)` returns a runnable matching
 * this shape — and test fakes can implement it without subclassing the
 * (large) base class.
 */
export interface StructuredScorer {
  withStructuredOutput<T>(schema: z.ZodType<T>): Runnable<ScoreMessages, T>;
}

export type ScoreMessages = ReadonlyArray<{ role: 'system' | 'user'; content: string }>;
