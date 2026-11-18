import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpenCode } from '@opencode/sdk';
import {
  generateWorkspace,
  hostCreateOptions,
  vinaPlugin,
  VINA_AGENTS,
  VINA_TOOL_NAMES,
  workspacePaths,
  type VinaServices,
} from '@vina/opencode-plugin';
import {
  createOpenCodeHost,
  renderHostConfig,
  renderProviderFragment,
  sanitizeModelId,
} from '../../src/opencode/host.js';

/** Minimal failing service container — the tools only need to *register*. */
function stubServices(): VinaServices {
  const fail = async (): Promise<never> => {
    throw new Error('stub');
  };
  return {
    profileRead: fail,
    searchJobs: fail,
    jobsList: fail,
    jobGet: fail,
    scoreJob: fail,
    materialsSave: fail,
    materialsRead: fail,
    reviewRecord: fail,
    applicationStatus: fail,
    easyApply: fail,
    externalSubmit: fail,
    askUser: fail,
  } as VinaServices;
}

describe('host driver', () => {
  it('sanitizes free-form model ids into config-safe keys', () => {
    expect(sanitizeModelId('gpt-4o')).toBe('gpt-4o');
    expect(sanitizeModelId('anthropic/claude-3.5')).toBe('anthropic-claude-3.5');
    expect(sanitizeModelId('///')).toBe('model');
  });

  it('renders the provider fragment with model + baseURL + key, keyless for null', () => {
    const withKey = renderProviderFragment({
      model: 'gpt-4o',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test-sentinel',
    });
    const p = withKey.provider as Record<string, { options: { baseURL: string; apiKey?: string } }>;
    expect(p.vina.options.baseURL).toBe('https://api.openai.com/v1');
    expect(p.vina.options.apiKey).toBe('sk-test-sentinel');
    expect(withKey.model).toBe('vina/gpt-4o');

    const keyless = renderProviderFragment({
      model: 'llama3',
      baseURL: 'http://localhost:11434/v1',
      apiKey: null,
    });
    const q = keyless.provider as Record<string, { options: Record<string, unknown> }>;
    expect(q.vina.options.apiKey).toBeUndefined();
  });

  it('never writes the decrypted key to the generated opencode.jsonc', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-host-'));
    generateWorkspace({ dataDir });
    const paths = workspacePaths(dataDir);
    const onDiskBefore = fs.readFileSync(paths.opencodeConfigFile, 'utf8');
    expect(onDiskBefore).not.toContain('sk-test-sentinel');

    const content = renderHostConfig(dataDir, {
      model: 'gpt-4o',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test-sentinel',
    });
    // The key rides only in the in-memory content…
    expect(content).toContain('sk-test-sentinel');
    // …never on disk.
    expect(fs.readFileSync(paths.opencodeConfigFile, 'utf8')).toBe(onDiskBefore);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('merges the generated workspace config and drops the plugins entry', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-host-'));
    generateWorkspace({ dataDir });
    const content = renderHostConfig(dataDir, {
      model: 'gpt-4o',
      baseURL: 'https://api.openai.com/v1',
      apiKey: null,
    });
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed.skills).toBeDefined();
    expect(parsed.plugins).toBeUndefined();
    expect(parsed.model).toBe('vina/gpt-4o');
    // The six agents are registered inline so agent.list() can discover them.
    const agents = parsed.agents as Record<string, unknown>;
    expect(agents).toBeDefined();
    expect(Object.keys(agents)).toEqual(expect.arrayContaining(VINA_AGENTS.map((a) => a.id)));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('boots a real host and registers the injected provider + model', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-host-'));
    generateWorkspace({ dataDir });
    const host = await createOpenCodeHost({
      dataDir,
      resolveProvider: async () => ({
        model: 'probe-model',
        baseURL: 'http://127.0.0.1:9/v1',
        apiKey: null,
      }),
      services: stubServices(),
      cdpEndpoint: () => 'http://127.0.0.1:9333',
      externalApplyMode: () => 'manual',
    });
    // noop
    try {
      // The location's plugins/MCP activate asynchronously; under a loaded CI
      // the first query can race activation ("did not finish activating").
      // Retry briefly instead of failing on a readiness race.
      const waitReady = async <T>(fn: () => Promise<T>): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await fn();
          } catch (err) {
            if (attempt >= 10) throw err;
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      };

      const providers = await waitReady(() => host.client.provider.list());
      const models = await waitReady(() => host.client.model.list());
      expect(providers.data.map((p) => p.id)).toContain('vina');
      expect(models.data.map((m) => m.modelID)).toContain('probe-model');
    } finally {
      await host.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('boots a real host and registers the vina_* tools via the injected plugin', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-host-'));
    generateWorkspace({ dataDir });

    // The SDK exposes no client-side tool listing, so the registered tools are
    // read back from the plugin's own `ctx.tool.list()` after the real `setup`
    // runs. This is the same wiring `createOpenCodeHost` performs — an instance
    // plugin passed to `OpenCode.create({ plugins })` — proving the earlier
    // "plugins don't load" claim is reversed.
    const plugin = vinaPlugin({
      services: stubServices(),
      cdpEndpoint: () => 'http://127.0.0.1:9333',
      externalApplyMode: () => 'manual',
    });
    // noop
    let registeredToolIds: string[] = [];
    const observed = {
      ...plugin,
      setup: async (ctx: Parameters<typeof plugin.setup>[0]) => {
        const cleanup = await plugin.setup(ctx);
        const tools = await ctx.tool.list();
        registeredToolIds = tools.map((t) => t.id);
        return cleanup;
      },
    };

    const content = renderHostConfig(dataDir, {
      model: 'probe-model',
      baseURL: 'http://127.0.0.1:9/v1',
      apiKey: null,
    });

    const host = await OpenCode.create({
      config: { directory: hostCreateOptions(dataDir).config.directory, content },
      plugins: [observed],
    });
    try {
      // Activation is lazy and asynchronous; the plugin `setup` (and thus the
      // tool registration) runs once the location activates — the first
      // provider/model query triggers it.
      for (let attempt = 0; attempt < 20 && registeredToolIds.length === 0; attempt++) {
        try {
          await host.provider.list();
          await host.model.list();
        } catch {
          // activation race — retry
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      // Every vina tool registers under its short name (the SDK's namespace
      // transform flattens it to `vina_<name>` as the effective id).
      expect(registeredToolIds).toEqual(expect.arrayContaining([...VINA_TOOL_NAMES]));
    } finally {
      await host.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('boots a real host and discovers the six vina-* agents via the config agents key', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-host-'));
    generateWorkspace({ dataDir });
    const host = await createOpenCodeHost({
      dataDir,
      resolveProvider: async () => ({
        model: 'probe-model',
        baseURL: 'http://127.0.0.1:9/v1',
        apiKey: null,
      }),
      services: stubServices(),
      cdpEndpoint: () => 'http://127.0.0.1:9333',
      externalApplyMode: () => 'manual',
    });
    // noop
    try {
      const waitReady = async <T>(fn: () => Promise<T>): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await fn();
          } catch (err) {
            if (attempt >= 10) throw err;
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      };

      // Touch the provider/model to trigger location activation; agent
      // discovery resolves once the location has activated.
      await waitReady(() => host.client.provider.list());
      await waitReady(() => host.client.model.list());

      // Agent discovery can lag location activation, so poll until the six
      // generated agents surface rather than asserting on the first empty list.
      let ids: string[] = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        const agents = await host.client.agent.list();
        ids = agents.data.map((a) => a.id);
        if (VINA_AGENTS.every((a) => ids.includes(a.id))) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      // The six generated agents must be discoverable (not just the built-ins).
      for (const agent of VINA_AGENTS) {
        expect(ids, agent.id).toContain(agent.id);
      }
    } finally {
      await host.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
