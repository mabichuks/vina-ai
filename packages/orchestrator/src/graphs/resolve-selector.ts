import { z } from 'zod';
import { ProviderError } from '@vina/shared';
import type { StructuredScorer, ScoreMessages } from './score-job.js';

/**
 * LLM-driven CSS selector resolver. Used as a *fallback* by site adapters
 * when their static selector list misses — the LLM looks at the page's
 * accessibility tree (or DOM dump) and proposes a selector that matches
 * the elements the user wants.
 *
 * The returned selector is meant to be cached to disk so subsequent runs
 * skip the LLM call.
 */

/**
 * `reasoning` is required (not optional) because OpenAI's structured-output
 * mode rejects schemas where any property is missing from `required[]` with
 * `400 Invalid schema for response_format`. The system prompt always asks
 * for reasoning, so requiring it in output is no real burden on the model;
 * Anthropic / Ollama are more lenient about optional fields but accepting a
 * required field is no problem there either.
 */
export const SelectorResultSchema = z.object({
  selector: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export type SelectorResult = z.infer<typeof SelectorResultSchema>;

export interface ResolveSelectorInput {
  /** What the caller is looking for, e.g. "search-result job cards on /jobs/". */
  intent: string;
  pageUrl: string;
  pageTitle: string;
  /** Truncated accessibility tree or DOM dump. Keep under ~10 KB for cost. */
  domSummary: string;
}

export const RESOLVE_SELECTOR_SYSTEM = `You are a CSS selector expert helping a job-search bot identify elements on a web page.

You will receive:
- The bot's INTENT (what kind of element it is looking for)
- The page URL and title
- A truncated accessibility-tree dump (or DOM excerpt)

Return a JSON object:
- selector: a CSS selector that matches all relevant elements
- confidence: 0.0–1.0
- reasoning: one short sentence

Prefer:
- Multiple variants joined by commas for resilience
- Structural selectors (li:has(...), [role="..."]) over class names that look auto-generated
- Stable attributes (intentional data-* names, aria-label patterns, href patterns)

Avoid:
- Auto-generated React/Ember ids (e.g. ":r2:", "ember42")
- Hash-like class names ("d7aa8400", "_7d2088df")
- Selectors that match only one element when the user wants a list

Output JSON only.`;

export function buildResolveSelectorPrompt(input: ResolveSelectorInput): string {
  return [
    '## Intent',
    input.intent,
    '',
    '## Page',
    `URL: ${input.pageUrl}`,
    `Title: ${input.pageTitle}`,
    '',
    '## DOM (truncated)',
    input.domSummary,
  ].join('\n');
}

const MAX_ATTEMPTS = 2;

/**
 * Ask the LLM to propose a selector for `input.intent` given a snapshot of
 * the page. One retry on malformed output, then `ProviderError`.
 */
export async function runResolveSelector(
  input: ResolveSelectorInput,
  model: StructuredScorer,
): Promise<SelectorResult> {
  const structured = model.withStructuredOutput(SelectorResultSchema);
  const messages: ScoreMessages = [
    { role: 'system', content: RESOLVE_SELECTOR_SYSTEM },
    { role: 'user', content: buildResolveSelectorPrompt(input) },
  ];

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await structured.invoke(messages);
      return {
        selector: raw.selector.trim(),
        confidence: Math.max(0, Math.min(1, raw.confidence)),
        reasoning: raw.reasoning.trim(),
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw new ProviderError('Selector resolver failed after retry', {
    cause: lastError instanceof Error ? lastError.message : String(lastError),
  });
}
