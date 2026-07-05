import { z } from 'zod';
import type { Skill, SkillRegistry, SkillSummary } from '../skills/registry.js';

/**
 * Input/output schemas for skill tools the chatbot exposes through its ReAct
 * loop. The shapes are tight so the model can be reliably nudged toward
 * structured calls.
 */
export const LoadSkillInputSchema = z.object({
  id: z.string().min(1),
});
export type LoadSkillInput = z.infer<typeof LoadSkillInputSchema>;

export const ListSkillsInputSchema = z.object({
  /** Optional graph filter — restricts the list to skills that apply to a graph. */
  graph: z.string().min(1).optional(),
});
export type ListSkillsInput = z.infer<typeof ListSkillsInputSchema>;

/**
 * Bundle of typed handlers around a `SkillRegistry`. Surfaces:
 *  - `index(graph?)` — descriptions only (cheap)
 *  - `load(id)` — full body (lazy)
 *
 * The chatbot graph (M20) wires these into LangChain `DynamicStructuredTool`s.
 * For deterministic graphs, callers use the methods directly — see
 * `graphs/apply-fallback.ts`.
 */
export interface SkillTools {
  index(input?: ListSkillsInput): Promise<SkillSummary[]>;
  load(input: LoadSkillInput): Promise<Skill>;
}

export function createSkillTools(registry: SkillRegistry): SkillTools {
  return {
    async index(input) {
      return registry.index(input?.graph);
    },
    async load(input) {
      return registry.load(input.id);
    },
  };
}
