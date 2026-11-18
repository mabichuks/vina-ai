import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@opencode/sdk';
import {
  vinaPlugin,
  buildVinaTools,
  VINA_TOOL_NAMES,
  type VinaServices,
  type EasyApplyPermission,
} from '../src/index.js';

/** Minimal recording stand-in for the plugin host `setup` context. */
interface Captured {
  namespace: { name: string; description: string } | null;
  toolNames: string[];
  mcps: Array<{ name: string; config: Record<string, unknown> }>;
  hooks: Array<{
    name: string;
    callback: (event: {
      agent: string;
      options: Record<string, unknown>;
      tools: Record<string, unknown>;
    }) => void;
  }>;
}

function makeContext(): { ctx: unknown; captured: Captured } {
  const captured: Captured = {
    namespace: null,
    toolNames: [],
    mcps: [],
    hooks: [],
  };

  const toolEditor = {
    namespace: (ns: { name: string; description: string }) => {
      captured.namespace = ns;
    },
    add: (tool: Tool.Info) => {
      captured.toolNames.push(tool.name);
    },
    list: () => [],
    get: () => undefined,
    update: () => {},
    remove: () => {},
  };

  const mcpEditor = {
    set: (name: string, config: Record<string, unknown>) => {
      captured.mcps.push({ name, config });
    },
    list: () => [],
    get: () => undefined,
    update: () => {},
    remove: () => {},
  };

  const ctx = {
    tool: {
      transform: async (callback: (editor: typeof toolEditor) => void) => callback(toolEditor),
    },
    mcp: {
      transform: async (callback: (editor: typeof mcpEditor) => void) => callback(mcpEditor),
    },
    session: {
      hook: async (
        name: string,
        callback: (event: {
          agent: string;
          options: Record<string, unknown>;
          tools: Record<string, unknown>;
        }) => void,
      ) => {
        captured.hooks.push({ name, callback });
      },
    },
  };

  return { ctx, captured };
}

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

function stubPermission(): EasyApplyPermission {
  return {
    assert: async () => {},
  };
}

describe('vinaPlugin boot-and-registers', () => {
  it('defines a plugin with id "vina" and a setup function', () => {
    const plugin = vinaPlugin({
      services: stubServices(),
      cdpEndpoint: () => 'http://127.0.0.1:9333',
      externalApplyMode: () => 'manual',
    });
    expect(plugin.id).toBe('vina');
    expect(typeof plugin.setup).toBe('function');
  });

  it('registers the vina namespace with all twelve tools (flattened vina_<name>)', async () => {
    const { ctx, captured } = makeContext();
    const plugin = vinaPlugin({
      services: stubServices(),
      cdpEndpoint: () => 'http://127.0.0.1:9333',
      externalApplyMode: () => 'manual',
    });
    await (plugin.setup as (c: typeof ctx) => Promise<void>)(ctx);

    expect(captured.namespace).toEqual({
      name: 'vina',
      description: 'Vina job-search facts and actions',
    });
    const flattened = captured.toolNames.map((n) => `vina_${n}`);
    expect(flattened).toEqual(VINA_TOOL_NAMES.map((n) => `vina_${n}`));
  });

  it('registers the Playwright MCP entry over the loopback CDP endpoint', async () => {
    const { ctx, captured } = makeContext();
    const plugin = vinaPlugin({
      services: stubServices(),
      cdpEndpoint: () => 'http://127.0.0.1:9333',
      externalApplyMode: () => 'manual',
    });
    await (plugin.setup as (c: typeof ctx) => Promise<void>)(ctx);

    expect(captured.mcps).toHaveLength(1);
    const mcp = captured.mcps[0]!;
    expect(mcp.name).toBe('playwright');
    expect(mcp.config.type).toBe('local');
    expect(mcp.config.command).toEqual([
      'npx',
      '-y',
      '@playwright/mcp@0.0.85',
      '--cdp-endpoint',
      'http://127.0.0.1:9333',
      '--browser',
      'chrome',
      '--headless',
    ]);
    expect(mcp.config.codemode).toBe(false);
  });

  it('registers the Playwright MCP entry disabled when there is no CDP endpoint (manual mode)', async () => {
    const { ctx, captured } = makeContext();
    const plugin = vinaPlugin({
      services: stubServices(),
      cdpEndpoint: () => null,
      externalApplyMode: () => 'manual',
    });
    await (plugin.setup as (c: typeof ctx) => Promise<void>)(ctx);

    expect(captured.mcps).toHaveLength(1);
    const mcp = captured.mcps[0]!;
    expect(mcp.name).toBe('playwright');
    expect(mcp.config.disabled).toBe(true);
    expect(mcp.config.command).not.toContain('--cdp-endpoint');
  });

  it('the context hook applies the mode-aware external-apply trim', async () => {
    const { ctx, captured } = makeContext();
    const plugin = vinaPlugin({
      services: stubServices(),
      cdpEndpoint: () => 'http://127.0.0.1:9333',
      externalApplyMode: () => 'assisted',
    });
    await (plugin.setup as (c: typeof ctx) => Promise<void>)(ctx);

    const contextHook = captured.hooks.find((h) => h.name === 'context');
    expect(contextHook).toBeDefined();

    // assisted: vina-manual keeps playwright* but loses vina_external_submit.
    const event: {
      agent: string;
      options: Record<string, unknown>;
      tools: Record<string, unknown>;
    } = {
      agent: 'vina-manual',
      options: {},
      tools: {
        playwright_navigate: {},
        vina_external_submit: {},
        vina_job_get: {},
      },
    };
    contextHook!.callback(event);

    expect(event.tools).toHaveProperty('playwright_navigate');
    expect(event.tools).not.toHaveProperty('vina_external_submit');
    expect(event.tools).toHaveProperty('vina_job_get');
  });

  it('registers the session context budget hook that sets a token ceiling', async () => {
    const { ctx, captured } = makeContext();
    const plugin = vinaPlugin({
      services: stubServices(),
      cdpEndpoint: () => 'http://127.0.0.1:9333',
      externalApplyMode: () => 'manual',
    });
    await (plugin.setup as (c: typeof ctx) => Promise<void>)(ctx);

    const contextHook = captured.hooks.find((h) => h.name === 'context');
    expect(contextHook).toBeDefined();

    const event: {
      agent: string;
      options: Record<string, unknown>;
      tools: Record<string, unknown>;
    } = {
      agent: 'vina-review',
      options: {},
      tools: {},
    };
    contextHook!.callback(event);
    expect(event.options.maxTokens).toBeGreaterThan(0);
  });

  it('the context hook trims submit + browser tools for a vina-chat session', async () => {
    const { ctx, captured } = makeContext();
    const plugin = vinaPlugin({
      services: stubServices(),
      cdpEndpoint: () => 'http://127.0.0.1:9333',
      externalApplyMode: () => 'manual',
    });
    await (plugin.setup as (c: typeof ctx) => Promise<void>)(ctx);

    const contextHook = captured.hooks.find((h) => h.name === 'context');
    expect(contextHook).toBeDefined();

    const event: {
      agent: string;
      options: Record<string, unknown>;
      tools: Record<string, unknown>;
    } = {
      agent: 'vina-chat',
      options: {},
      tools: {
        vina_profile_read: {},
        vina_jobs_list: {},
        vina_easy_apply: {},
        vina_external_submit: {},
        playwright_navigate: {},
        playwright_click: {},
      },
    };
    contextHook!.callback(event);

    // The chat surface must not be able to reach submit or the browser.
    expect(event.tools).not.toHaveProperty('vina_easy_apply');
    expect(event.tools).not.toHaveProperty('vina_external_submit');
    expect(Object.keys(event.tools)).not.toContain('playwright_navigate');
    expect(Object.keys(event.tools)).not.toContain('playwright_click');
    // Its granted read tools survive.
    expect(event.tools).toHaveProperty('vina_profile_read');
    expect(event.tools).toHaveProperty('vina_jobs_list');
  });
});

describe('buildVinaTools', () => {
  it('returns exactly the twelve fixed tools in order', () => {
    const tools = buildVinaTools(stubServices(), stubPermission());
    expect(tools.map((t) => t.name)).toEqual(VINA_TOOL_NAMES);
  });

  it('executes a tool by zod-validating input then delegating to the service', async () => {
    const services = stubServices();
    const profileRead = vi.fn(async () => ({ profile: null, cvs: [], answers: [] }));
    const tools = buildVinaTools({ ...services, profileRead } as VinaServices, stubPermission());
    const tool = tools.find((t) => t.name === 'profile_read')!;

    const result = await (
      tool as unknown as {
        execute: (i: unknown, ctx: unknown) => Promise<{ output: unknown }>;
      }
    ).execute({}, {});
    expect(result.output).toEqual({ profile: null, cvs: [], answers: [] });
    expect(profileRead).toHaveBeenCalledOnce();
  });

  it('rejects malformed input with a zod error', async () => {
    const services = stubServices();
    const tools = buildVinaTools(services, stubPermission());
    const tool = tools.find((t) => t.name === 'job_get')!;

    await expect(
      (tool as unknown as { execute: (i: unknown, ctx: unknown) => Promise<unknown> }).execute(
        {},
        {},
      ),
    ).rejects.toThrow();
  });

  it('easy_apply asserts permission before delegating to the service', async () => {
    const services = stubServices();
    const easyApply = vi.fn(async () => ({ application_id: 'a', outcome: 'submitted' as const }));
    const assert = vi.fn(async () => {});
    const tools = buildVinaTools({ ...services, easyApply } as VinaServices, { assert });
    const tool = tools.find((t) => t.name === 'easy_apply')!;

    const ctx = { sessionID: 'ses_1' };
    const result = await (
      tool as unknown as {
        execute: (i: unknown, ctx: unknown) => Promise<{ output: unknown }>;
      }
    ).execute({ applicationId: 'app_1' }, ctx);

    expect(result.output).toEqual({ application_id: 'a', outcome: 'submitted' });
    // Permission is asserted with the session id and the application resource.
    expect(assert).toHaveBeenCalledOnce();
    expect(assert).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      action: 'vina.easy_apply',
      resources: ['app_1'],
    });
    // The service is only reached after the assertion resolves.
    expect(easyApply).toHaveBeenCalledOnce();
    expect(easyApply).toHaveBeenCalledWith({ applicationId: 'app_1' });
  });

  it('a rejected easy_apply permission prevents the service from running (no submit)', async () => {
    const services = stubServices();
    const easyApply = vi.fn(async () => ({ application_id: 'a', outcome: 'submitted' as const }));
    const assert = vi.fn(async () => {
      throw new Error('permission denied');
    });
    const tools = buildVinaTools({ ...services, easyApply } as VinaServices, { assert });
    const tool = tools.find((t) => t.name === 'easy_apply')!;

    await expect(
      (tool as unknown as { execute: (i: unknown, ctx: unknown) => Promise<unknown> }).execute(
        { applicationId: 'app_1' },
        { sessionID: 'ses_1' },
      ),
    ).rejects.toThrow(/permission denied/);

    expect(assert).toHaveBeenCalledOnce();
    expect(easyApply).not.toHaveBeenCalled();
  });

  it('external_submit asserts permission (vina.external_submit) before delegating', async () => {
    const services = stubServices();
    const externalSubmit = vi.fn(async () => ({
      application_id: 'a',
      outcome: 'submitted' as const,
    }));
    const assert = vi.fn(async () => {});
    const tools = buildVinaTools({ ...services, externalSubmit } as VinaServices, { assert });
    const tool = tools.find((t) => t.name === 'external_submit')!;

    const result = await (
      tool as unknown as {
        execute: (i: unknown, ctx: unknown) => Promise<{ output: unknown }>;
      }
    ).execute({ applicationId: 'app_1' }, { sessionID: 'ses_1' });

    expect(result.output).toEqual({ application_id: 'a', outcome: 'submitted' });
    expect(assert).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      action: 'vina.external_submit',
      resources: ['app_1'],
    });
    expect(externalSubmit).toHaveBeenCalledWith({ applicationId: 'app_1' });
  });

  it('a rejected external_submit permission prevents the service from running (no submit)', async () => {
    const services = stubServices();
    const externalSubmit = vi.fn(async () => ({
      application_id: 'a',
      outcome: 'submitted' as const,
    }));
    const assert = vi.fn(async () => {
      throw new Error('permission denied');
    });
    const tools = buildVinaTools({ ...services, externalSubmit } as VinaServices, { assert });
    const tool = tools.find((t) => t.name === 'external_submit')!;

    await expect(
      (tool as unknown as { execute: (i: unknown, ctx: unknown) => Promise<unknown> }).execute(
        { applicationId: 'app_1' },
        { sessionID: 'ses_1' },
      ),
    ).rejects.toThrow(/permission denied/);

    expect(externalSubmit).not.toHaveBeenCalled();
  });
});
