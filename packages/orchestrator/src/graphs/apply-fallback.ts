import { z } from 'zod';
import type { Runnable } from '@langchain/core/runnables';
import { ProviderError } from '@vina/shared';
import { getDefaultSkillRegistry } from '../skills/default-registry.js';
import type { SkillRegistry } from '../skills/registry.js';

/**
 * Input to a single fallback decision. The deterministic walker hands us
 * one unresolved field at a time — the LLM emits one action per call
 * (ADR-022 § operating loop).
 */
export interface ApplyFallbackInput {
  /** Free-form context distilled from the user's profile + answers. */
  profileContext: string;
  /** Field the walker could not resolve from profile/answers. */
  field: {
    label: string;
    kind: string;
    required: boolean;
    options?: string[];
  };
  /** Optional: full UI snapshot summary (compact text). */
  snapshotSummary?: string;
}

/**
 * Decision returned by the model. `fill` carries the value to type or
 * select; `skip` means the LLM cannot answer — the caller raises a
 * `missing_field` alert (per the browser-apply skill).
 */
export const FallbackDecisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('fill'),
    value: z.string(),
    reason: z.string(),
  }),
  z.object({
    action: z.literal('skip'),
    reason: z.string(),
  }),
]);
export type FallbackDecision = z.infer<typeof FallbackDecisionSchema>;

export type ApplyFallbackMessages = ReadonlyArray<{
  role: 'system' | 'user';
  content: string;
}>;

/**
 * Minimum surface a model must expose for the fallback. LangChain's
 * `BaseChatModel.withStructuredOutput` returns a runnable matching this;
 * test fakes implement it without subclassing the base class.
 */
export interface StructuredApplyDecider {
  withStructuredOutput<T>(
    schema: z.ZodType<T>,
  ): Runnable<ApplyFallbackMessages, T>;
}

const APPLY_FALLBACK_PREAMBLE = `You are the LLM fallback for Vina's deterministic form walker (ADR-022).
The walker already filled every field it could classify from the user's profile
and answers. Exactly one field was unresolved and is given to you below. Decide
ONE action: either fill the field with a value you can defend from the profile
context, or skip it. Follow the loaded browser-apply skill — especially the
"never fabricate" rule.`;

function buildUserPrompt(input: ApplyFallbackInput): string {
  const parts = [
    `Field label: ${input.field.label}`,
    `Field kind: ${input.field.kind}`,
    `Required: ${input.field.required ? 'yes' : 'no'}`,
  ];
  if (input.field.options && input.field.options.length > 0) {
    parts.push(`Options: ${input.field.options.join(' | ')}`);
  }
  parts.push('', 'User profile context:', input.profileContext.trim() || '(empty)');
  if (input.snapshotSummary) {
    parts.push('', 'Snapshot summary:', input.snapshotSummary.trim());
  }
  return parts.join('\n');
}

/**
 * Deprecated test seam from Chunk 5 — kept as a no-op so existing tests
 * still call it without effect. The skill body now flows through the
 * `SkillRegistry`'s own cache (invalidated via `registry.invalidate`).
 */
export function _resetBrowserApplySkillCache(): void {
  // Intentionally empty — registry handles caching.
}

const MAX_ATTEMPTS = 2;

export interface DecideUnresolvedFieldOptions {
  /** Override the default skill registry — server-side overrides flow here. */
  skillRegistry?: SkillRegistry;
}

/**
 * Decide an action for a single unresolved field. Pre-loads the
 * `browser-apply` skill into the system prompt (ADR-022), then asks the
 * model for a structured `FallbackDecision`. One retry on malformed
 * output, then `ProviderError`.
 */
export async function decideUnresolvedField(
  input: ApplyFallbackInput,
  model: StructuredApplyDecider,
  opts: DecideUnresolvedFieldOptions = {},
): Promise<FallbackDecision> {
  const registry = opts.skillRegistry ?? getDefaultSkillRegistry();
  const skill = await registry.load('browser-apply');
  // Pull the descriptions of every other skill that applies to the `apply`
  // graph so the model has the option to call them out — body stays untouched
  // to respect the apply token budget.
  const applicableIndex = await registry.index('apply');
  const sibling = applicableIndex.filter((s) => s.id !== 'browser-apply');
  const siblingBlock =
    sibling.length > 0
      ? `\n\n--- other applicable skills (descriptions only) ---\n${sibling
          .map((s) => `- ${s.id} (v${s.version}): ${s.description}`)
          .join('\n')}`
      : '';
  const system =
    `${APPLY_FALLBACK_PREAMBLE}\n\n--- browser-apply skill (v${skill.version}) ---\n${skill.body}` +
    siblingBlock;
  const messages: ApplyFallbackMessages = [
    { role: 'system', content: system },
    { role: 'user', content: buildUserPrompt(input) },
  ];
  const structured = model.withStructuredOutput(FallbackDecisionSchema);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await structured.invoke(messages);
    } catch (err) {
      lastError = err;
    }
  }
  throw new ProviderError(
    `apply-fallback: model produced no valid decision after ${MAX_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
