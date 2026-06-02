import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { Runnable } from '@langchain/core/runnables';
import {
  decideUnresolvedField,
  type ApplyFallbackInput,
  type ApplyFallbackMessages,
  type FallbackDecision,
  type StructuredApplyDecider,
} from '../../src/graphs/apply-fallback.js';

class FakeDecider implements StructuredApplyDecider {
  public lastMessages: ApplyFallbackMessages | null = null;
  public attempts = 0;
  constructor(
    private behaviour:
      | { kind: 'reply'; reply: FallbackDecision }
      | { kind: 'throw'; error: Error }
      | { kind: 'throw-then-reply'; error: Error; reply: FallbackDecision },
  ) {}

  withStructuredOutput<T>(_schema: z.ZodType<T>): Runnable<ApplyFallbackMessages, T> {
    const self = this;
    return {
      async invoke(messages: ApplyFallbackMessages): Promise<T> {
        self.lastMessages = messages;
        self.attempts++;
        switch (self.behaviour.kind) {
          case 'reply':
            return self.behaviour.reply as unknown as T;
          case 'throw':
            throw self.behaviour.error;
          case 'throw-then-reply':
            if (self.attempts === 1) throw self.behaviour.error;
            return self.behaviour.reply as unknown as T;
        }
      },
    } as unknown as Runnable<ApplyFallbackMessages, T>;
  }
}

const SAMPLE_INPUT: ApplyFallbackInput = {
  profileContext:
    'Name: Ada Lovelace\nYears of experience: 7\nLast role: Senior Engineer at AnalyticsCo',
  field: {
    label: 'How many years of experience do you have with Rust?',
    kind: 'text',
    required: true,
  },
};

describe('decideUnresolvedField', () => {
  it('returns the model decision when it is a fill', async () => {
    const decider = new FakeDecider({
      kind: 'reply',
      reply: { action: 'fill', value: '0', reason: 'no Rust mentioned in profile' },
    });
    const result = await decideUnresolvedField(SAMPLE_INPUT, decider);
    expect(result).toEqual({
      action: 'fill',
      value: '0',
      reason: 'no Rust mentioned in profile',
    });
    expect(decider.attempts).toBe(1);
  });

  it('returns a skip decision when the model declines to answer', async () => {
    const decider = new FakeDecider({
      kind: 'reply',
      reply: { action: 'skip', value: null, reason: 'profile does not specify Rust experience' },
    });
    const result = await decideUnresolvedField(SAMPLE_INPUT, decider);
    expect(result.action).toBe('skip');
  });

  it('retries once on a model failure', async () => {
    const decider = new FakeDecider({
      kind: 'throw-then-reply',
      error: new Error('zod parse failed'),
      reply: { action: 'fill', value: '7', reason: 'from profile' },
    });
    const result = await decideUnresolvedField(SAMPLE_INPUT, decider);
    expect(result.action).toBe('fill');
    expect(decider.attempts).toBe(2);
  });

  it('throws ProviderError when both attempts fail', async () => {
    const decider = new FakeDecider({
      kind: 'throw',
      error: new Error('rate limited'),
    });
    await expect(decideUnresolvedField(SAMPLE_INPUT, decider)).rejects.toThrow(
      /no valid decision after 2 attempts/,
    );
  });

  it('pre-loads the browser-apply skill into the system prompt', async () => {
    const decider = new FakeDecider({
      kind: 'reply',
      reply: { action: 'skip', value: null, reason: 'ok' },
    });
    await decideUnresolvedField(SAMPLE_INPUT, decider);
    const [system] = decider.lastMessages!;
    expect(system.role).toBe('system');
    expect(system.content).toMatch(/browser-apply skill/);
    expect(system.content).toMatch(/Stale-ref recovery/i);
    expect(system.content).toMatch(/never fabricate/i);
  });

  it('includes the field label, kind, required flag, and options in the user prompt', async () => {
    const decider = new FakeDecider({
      kind: 'reply',
      reply: { action: 'skip', value: null, reason: 'ok' },
    });
    await decideUnresolvedField(
      {
        profileContext: 'p',
        field: {
          label: 'Visa status',
          kind: 'select',
          required: true,
          options: ['Citizen', 'Visa holder', 'Need sponsorship'],
        },
      },
      decider,
    );
    const [, user] = decider.lastMessages!;
    expect(user.content).toMatch(/Visa status/);
    expect(user.content).toMatch(/kind: select/);
    expect(user.content).toMatch(/Required: yes/);
    expect(user.content).toMatch(
      /Options: Citizen \| Visa holder \| Need sponsorship/,
    );
  });
});
