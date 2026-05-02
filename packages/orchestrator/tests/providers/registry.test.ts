import { describe, expect, it } from 'vitest';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { ChatOllama } from '@langchain/ollama';
import { buildModel } from '../../src/providers/registry.js';

describe('buildModel', () => {
  it('constructs the right LangChain class per kind', async () => {
    const anthropic = await buildModel({
      kind: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk-ant-test',
    });
    expect(anthropic).toBeInstanceOf(ChatAnthropic);

    const openai = await buildModel({
      kind: 'openai',
      model: 'gpt-5',
      apiKey: 'sk-test',
    });
    expect(openai).toBeInstanceOf(ChatOpenAI);

    const ollama = await buildModel({
      kind: 'ollama',
      model: 'llama3.1:70b',
      baseUrl: 'http://localhost:11434',
    });
    expect(ollama).toBeInstanceOf(ChatOllama);
  });
});
