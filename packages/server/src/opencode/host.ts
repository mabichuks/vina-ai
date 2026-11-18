import fs from 'node:fs';
import { OpenCode } from '@opencode/sdk';
import type { ExternalApplyMode } from '@vina/shared';
import {
  hostCreateOptions,
  renderAgentsConfig,
  vinaPlugin,
  workspacePaths,
  type VinaServices,
} from '@vina/opencode-plugin';
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
  /** Server-injected service container backing the `vina_*` tools (issue #16). */
  services: VinaServices;
  /** Resolves the loopback CDP endpoint the Playwright MCP attaches to (ADR-022). */
  cdpEndpoint: () => string | null;
  /** Resolves the current `external_apply_mode` for the plugin's mode-aware trim. */
  externalApplyMode: () => ExternalApplyMode;
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
 * `plugins` entry is a package-name string (`@vina/opencode-plugin`) — the
 * embedded SDK does not resolve plugin packages by name, so it is dropped here
 * and the plugin is injected as an instance via `OpenCode.create({ plugins })`
 * instead (see `createOpenCodeHost`). The six `vina-*` agents are registered
 * inline under the `agents` key so `agent.list()` surfaces them and
 * `session.create({ agent })` loads their definition (the SDK does not
 * discover agents from the workspace markdown).
 */
export function renderHostConfig(dataDir: string, provider: ResolvedProvider): string {
  const paths = workspacePaths(dataDir);
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(fs.readFileSync(paths.opencodeConfigFile, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    log.warn(
      { file: paths.opencodeConfigFile },
      'generated opencode.jsonc missing; booting with provider only',
    );
  }
  const { plugins: _plugins, ...rest } = base;
  return JSON.stringify(
    { ...rest, ...renderAgentsConfig(), ...renderProviderFragment(provider) },
    null,
    2,
  );
}

/**
 * Boot the host. Throws on failure so `main.ts` can degrade to "chat
 * unavailable" rather than crash the daemon (ADR-024 §10).
 */
export async function createOpenCodeHost(deps: OpenCodeHostDeps): Promise<OpenCodeHost> {
  const provider = await deps.resolveProvider();
  const content = renderHostConfig(deps.dataDir, provider);

  // Register the vina plugin as an instance (the SDK accepts `Plugin.Plugin`
  // instances, not package-name strings). Its `setup` runs per-location and
  // registers the `vina_*` tool namespace, the Playwright MCP, and the token
  // budget hook — with the live `VinaServices` injected at boot.
  const plugin = vinaPlugin({
    services: deps.services,
    cdpEndpoint: deps.cdpEndpoint,
    externalApplyMode: deps.externalApplyMode,
  });

  const client = await OpenCode.create({
    config: { directory: hostCreateOptions(deps.dataDir).config.directory, content },
    plugins: [plugin],
  });

  return {
    client,
    close: () => client.close(),
  };
}
