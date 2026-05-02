import type { FastifyInstance } from 'fastify';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import {
  ConflictError,
  LlmProviderInputSchema,
  NotFoundError,
  ValidationError,
  type LlmProvider,
} from '@vina/shared';
import {
  findLlmProviderById,
  listLlmProviders,
  type LlmProviderRow,
} from '../../db/repositories/llm-providers.js';
import { getOrInitSettings } from '../../db/repositories/settings.js';
import { createProvider, validateProvider } from '../../services/llm-service.js';
import { deleteLlmProvider as deleteRow } from '../../db/repositories/llm-providers.js';
import { decrypt } from '../../secrets/vault.js';
import { parse } from '../parse.js';

const IdParamsSchema = z.object({ id: z.string().min(1) });

/** Strip ciphertext, return the public `LlmProvider` shape. */
function toResponse(row: LlmProviderRow): LlmProvider {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    model: row.model,
    base_url: row.base_url,
    has_api_key: row.encrypted_api_key !== null,
    created_at: row.created_at,
  };
}

export async function llmProviderRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseType },
): Promise<void> {
  const { db } = deps;

  app.get('/api/llm-providers', async () => listLlmProviders(db).map((row) => toResponse(row)));

  app.post('/api/llm-providers', async (req) => {
    const input = parse(LlmProviderInputSchema, req.body);
    const result = await validateProvider({
      kind: input.kind,
      model: input.model,
      api_key: input.api_key ?? null,
      base_url: input.base_url ?? null,
    });
    if (!result.ok) {
      // Surface the provider's own message when present (e.g. "Incorrect API
      // key provided" from OpenAI) rather than just the typed reason.
      const message = result.detail
        ? `Provider validation failed: ${result.detail}`
        : `Provider validation failed (${result.reason})`;
      throw new ValidationError(
        message,
        { reason: result.reason, detail: result.detail },
        'provider_invalid',
      );
    }
    return toResponse(
      createProvider(db, {
        kind: input.kind,
        label: input.label,
        model: input.model,
        base_url: input.base_url ?? null,
        api_key: input.api_key ?? null,
      }),
    );
  });

  app.delete('/api/llm-providers/:id', async (req, reply) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const settings = getOrInitSettings(db);
    if (settings.active_llm_provider_id === id) {
      throw new ConflictError('Cannot delete the active LLM provider');
    }
    deleteRow(db, id);
    return reply.status(204).send();
  });

  app.post('/api/llm-providers/:id/test', async (req) => {
    const { id } = parse(IdParamsSchema, req.params, 'route params');
    const row = findLlmProviderById(db, id);
    if (!row) throw new NotFoundError(`LLM provider ${id} not found`);
    // Provider tests use the *stored* key — decrypt it to test, never leak it.
    const apiKey = row.encrypted_api_key ? decrypt(row.encrypted_api_key) : null;
    return validateProvider({
      kind: row.kind,
      model: row.model,
      api_key: apiKey,
      base_url: row.base_url,
    });
  });
}
