import { z } from 'zod';
import type { Runnable } from '@langchain/core/runnables';
import { ProviderError } from '@vina/shared';
import { loadSkill, resolveSkillPath, type Skill } from '../skills/loader.js';

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

let cachedSkill: Skill | null = null;

async function loadBrowserApplySkill(): Promise<Skill> {
  if (cachedSkill) return cachedSkill;
  const skillPath = resolveSkillPath('browser-apply', import.meta.url);
  cachedSkill = await loadSkill(skillPath);
  return cachedSkill;
}

/**
 * Reset the cached skill body. Tests that mock the loader use this to
 * pick up a different SKILL.md file between cases.
 */
export function _resetBrowserApplySkillCache(): void {
  cachedSkill = null;
}

const MAX_ATTEMPTS = 2;

/**
 * Decide an action for a single unresolved field. Pre-loads the
 * `browser-apply` skill into the system prompt (ADR-022), then asks the
 * model for a structured `FallbackDecision`. One retry on malformed
 * output, then `ProviderError`.
 */
export async function decideUnresolvedField(
  input: ApplyFallbackInput,
  model: StructuredApplyDecider,
): Promise<FallbackDecision> {
  const skill = await loadBrowserApplySkill();
  const system = `${APPLY_FALLBACK_PREAMBLE}\n\n--- browser-apply skill (v${skill.meta.version ?? 1}) ---\n${skill.body}`;
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
