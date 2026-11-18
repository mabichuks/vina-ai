import { Plugin } from '@opencode/plugin';
import { buildVinaTools } from './tools.js';
import { VINA_NAMESPACE, type VinaServices } from './contract.js';
import { trimToolsForAgent } from './agents.js';

/**
 * Pinned Playwright MCP version (stage-0 probe: `@playwright/mcp@0.0.85`).
 * Upgrading is a dedicated PR with a fixture-site smoke run.
 */
const DEFAULT_PLAYWRIGHT_MCP_VERSION = '0.0.85';

/** Default per-request token ceiling; per-agent overrides below. */
const DEFAULT_MAX_TOKENS = 16_000;

/**
 * Per-agent token ceilings (§8 "Context and cost"). Defence in depth — the
 * agent's own allowlist also trims the tool set. Cheap/fast agents get a
 * smaller budget than the strong reasoning agents.
 */
const AGENT_TOKEN_BUDGETS: Readonly<Record<string, number>> = {
  'vina-sweep': 8_000,
  'vina-apply': 8_000,
  'vina-manual': 8_000,
  'vina-chat': 8_000,
  'vina-materials': 24_000,
  'vina-review': 24_000,
};

export function budgetFor(agentId: string): number {
  return AGENT_TOKEN_BUDGETS[agentId] ?? DEFAULT_MAX_TOKENS;
}

export interface VinaPluginOptions {
  /** Server-injected service container. The plugin opens no database handle. */
  services: VinaServices;
  /** Resolves the loopback CDP endpoint the Playwright MCP attaches to (ADR-022). */
  cdpEndpoint: () => string;
  /** Pinned `@playwright/mcp` version; defaults to the stage-0-probe pin. */
  playwrightMcpVersion?: string;
}

/**
 * The Vina plugin: registers the `vina` tool namespace, the Playwright MCP
 * entry (loopback CDP), and a context budget hook. Pure registration — all
 * behaviour arrives via `options.services`.
 */
export function vinaPlugin(options: VinaPluginOptions): Plugin.Plugin {
  const mcpVersion = options.playwrightMcpVersion ?? DEFAULT_PLAYWRIGHT_MCP_VERSION;

  return Plugin.define({
    id: 'vina',
    async setup(ctx) {
      await ctx.tool.transform((editor) => {
        editor.namespace({
          name: VINA_NAMESPACE,
          description: 'Vina job-search facts and actions',
        });
        for (const tool of buildVinaTools(options.services)) editor.add(tool);
      });

      await ctx.mcp.transform((editor) => {
        editor.set('playwright', {
          type: 'local',
          command: [
            'npx',
            '-y',
            `@playwright/mcp@${mcpVersion}`,
            '--cdp-endpoint',
            options.cdpEndpoint(),
            '--browser',
            'chrome',
            '--headless',
          ],
          codemode: false,
        });
      });

      await ctx.session.hook('context', (event) => {
        // The authoritative §5 allow/deny gate: trim the tool set per agent so
        // a mis-resolved agent or a prompt injection can never reach submit or
        // the browser (see agents.ts `trimToolsForAgent`). Defence in depth on
        // top of the token budget.
        trimToolsForAgent(event.agent, event.tools);
        event.options.maxTokens = budgetFor(event.agent);
      });
    },
  });
}
