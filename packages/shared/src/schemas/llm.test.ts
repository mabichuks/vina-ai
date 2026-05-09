import { describe, expect, it } from 'vitest';
import { LlmProviderInputSchema, LlmProviderSchema } from './llm.js';

describe('LlmProviderSchema (response)', () => {
  it('parses a provider row with has_api_key true', () => {
    const row = {
      id: '01HPROV',
      kind: 'anthropic' as const,
      label: 'Claude Opus',
      model: 'claude-opus-4-7',
      base_url: null,
      has_api_key: true,
      created_at: '2026-04-28T10:00:00Z',
    };
    expect(LlmProviderSchema.parse(row)).toEqual(row);
  });
});

describe('LlmProviderInputSchema (request)', () => {
  it('requires api_key for anthropic', () => {
    expect(() =>
      LlmProviderInputSchema.parse({
        kind: 'anthropic',
        label: 'Claude',
        model: 'claude-opus-4-7',
      }),
    ).toThrow();
  });

  it('requires api_key for openai', () => {
    expect(() =>
      LlmProviderInputSchema.parse({
        kind: 'openai',
        label: 'GPT',
        model: 'gpt-5',
      }),
    ).toThrow();
  });

  it('does NOT require api_key for ollama', () => {
    expect(
      LlmProviderInputSchema.parse({
        kind: 'ollama',
        label: 'Local Llama',
        model: 'llama3.1:70b',
        base_url: 'http://localhost:11434',
      }),
    ).toBeTruthy();
  });

  it('accepts anthropic with api_key', () => {
    expect(
      LlmProviderInputSchema.parse({
        kind: 'anthropic',
        label: 'Claude',
        model: 'claude-opus-4-7',
        api_key: 'sk-ant-xxx',
      }),
    ).toBeTruthy();
  });
});
