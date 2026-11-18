import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateWorkspace, workspacePaths } from '@vina/opencode-plugin';
import {
  createOpenCodeHost,
  renderHostConfig,
  renderProviderFragment,
  sanitizeModelId,
} from '../../src/opencode/host.js';

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
    });
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
});
