import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { LlmProviderKind } from '@vina/shared';

export interface ProviderConfig {
  kind: LlmProviderKind;
  model: string;
  /** Plaintext API key — required for `anthropic` and `openai`. */
  apiKey?: string | null;
  /** Endpoint override — only meaningful for `ollama`. */
  baseUrl?: string | null;
}

/**
 * Build a LangChain chat model for the given provider configuration. The
 * caller is responsible for decrypting the API key (via the vault) before
 * calling — this module never touches secrets.
 *
 * Imports are lazy so each provider's transitive deps only load when
 * actually used. ChatOpenAI in particular pulls in tiktoken, which is heavy.
 */
export async function buildModel(cfg: ProviderConfig): Promise<BaseChatModel> {
  switch (cfg.kind) {
    case 'anthropic': {
      const { ChatAnthropic } = await import('@langchain/anthropic');
      return new ChatAnthropic({
        model: cfg.model,
        ...(cfg.apiKey && { apiKey: cfg.apiKey }),
      });
    }
    case 'openai': {
      const { ChatOpenAI } = await import('@langchain/openai');
      return new ChatOpenAI({
        model: cfg.model,
        ...(cfg.apiKey && { apiKey: cfg.apiKey }),
      });
    }
    case 'ollama': {
      const { ChatOllama } = await import('@langchain/ollama');
      return new ChatOllama({
        model: cfg.model,
        ...(cfg.baseUrl && { baseUrl: cfg.baseUrl }),
      });
    }
  }
}
