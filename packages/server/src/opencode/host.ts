import fs from 'node:fs';
import { OpenCode } from '@opencode/sdk';
import { hostCreateOptions, workspacePaths } from '@vina/opencode-plugin';
import { createLogger } from '@vina/shared';

const log = createLogger('opencode-host');

/**
 * The host driver (issue #18, ADR-024 §2/§14). Boots **one embedded `OpenCode`
 * per process** against the #17-generated `<dataDir>/workspace` with the
 * isolated config home from `hostCreateOptions`.
 *
 * The active LLM reaches the host **at `OpenCode.create` time via an in-memory
 * config `content`** — model id + `baseURL` from settings, the API key
 * decrypted from the vault. It is never written to the on-disk `opencode.jsonc`
 * and never in the repo (ADR-024 §9: the vault is the single source of truth).
 */

/** A resolved provider ready to inject into the host config. */
export interface ResolvedProvider {
  /** Model id as configured on the provider (e.g. `gpt-4o`). */
  model: string;
  /** OpenAI-compatible base URL for the provider. */
  baseURL: string;
  /** Decrypted API key, or null for keyless providers (Ollama). */
  apiKey: string | null;
}

/** Resolves the active provider + decrypted key. Injected by `main.ts`. */
export type ProviderResolver = () => Promise<ResolvedProvider>;

export interface OpenCodeHostDeps {
  dataDir: string;
  resolveProvider: ProviderResolver;
}

export interface OpenCodeHost {
  client: OpenCode.Interface;
  close: () => Promise<void>;
}

/** The provider id Vina registers under in the generated config. */
const VINA_PROVIDER_ID = 'vina';
/** The OpenAI-compatible provider package every Vina provider is routed through. */
const PROVIDER_PACKAGE = '@ai-sdk/openai-compatible';

/** Collapse a free-form model string into a config-safe model id. */
export function sanitizeModelId(model: string): string {
  const safe = model.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe.length > 0 ? safe : 'model';
}

/**
 * Render the in-memory config fragment that registers the active provider and
 * selects its model. The key rides only in this returned string — callers must
 * never persist or log it.
 */
export function renderProviderFragment(provider: ResolvedProvider): Record<string, unknown> {
  const modelId = sanitizeModelId(provider.model);
  return {
    provider: {
      [VINA_PROVIDER_ID]: {
        npm: PROVIDER_PACKAGE,
        name: 'Vina LLM',
        options: {
          baseURL: provider.baseURL,
          ...(provider.apiKey !== null ? { apiKey: provider.apiKey } : {}),
        },
        models: {
          [modelId]: { name: provider.model },
        },
      },
    },
    model: `${VINA_PROVIDER_ID}/${modelId}`,
  };
}

/**
 * Build the full host config `content`: the generated workspace config (skills,
 * agents, MCP) plus the injected provider + model. The generated config's
 * `plugins` entry is dropped — the vina plugin's tool registration lands with
 * the #16 plugin wiring, not via package-name loading (the embedded SDK does
 * not resolve `@vina/opencode-plugin` by name in stage 1).
 */
export function renderHostConfig(dataDir: string, provider: ResolvedProvider): string {
  const paths = workspacePaths(dataDir);
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(fs.readFileSync(paths.opencodeConfigFile, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    log.warn({ file: paths.opencodeConfigFile }, 'generated opencode.jsonc missing; booting with provider only');
  }
  const { plugins: _plugins, ...rest } = base;
  return JSON.stringify({ ...rest, ...renderProviderFragment(provider) }, null, 2);
}

/**
 * Boot the host. Throws on failure so `main.ts` can degrade to "chat
 * unavailable" rather than crash the daemon (ADR-024 §10).
 */
export async function createOpenCodeHost(deps: OpenCodeHostDeps): Promise<OpenCodeHost> {
  const provider = await deps.resolveProvider();
  const content = renderHostConfig(deps.dataDir, provider);

  const client = await OpenCode.create({
    config: { directory: hostCreateOptions(deps.dataDir).config.directory, content },
  });

  return {
    client,
    close: () => client.close(),
  };
}
