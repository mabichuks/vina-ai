import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OpenCode } from '@opencode/sdk';
import {
  generateWorkspace,
  hostCreateOptions,
  workspacePaths,
  VENDORED_SKILL_IDS,
} from '../src/index.js';

/**
 * Stage-1 boot smoke test (docs/opencode-orchestration.md §12 "Plugin
 * registration"). Boots a real `@opencode/sdk` host against the generated
 * workspace with an isolated config home and proves the stage-0 probe's two
 * findings are addressed:
 *
 * - the config is explicit (skills[] lists every vendored skill, agents are the
 *   six from §5, and the Playwright MCP entry is present but disabled); and
 * - the host reads only Vina's isolated config home — none of the user's global
 *   OpenCode skills/agents (`~/.config/opencode`) leak in.
 *
 * The isolated-config-home mechanism is `OpenCode.create({ config: { directory } })`,
 * which `@opencode/sdk@2.3.1` wires to the host's `Global` config path.
 */

interface ConfigEntry {
  type: 'document' | 'directory';
  path?: string;
  info?: {
    skills?: string[];
    agents?: Record<string, unknown>;
    mcp?: { servers?: Record<string, { disabled?: boolean }> };
  };
}

describe('boot isolation', () => {
  it('lists only Vina skills/agents — no user global config leaks', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-boot-'));
    const paths = generateWorkspace({ dataDir });

    // Seed a fake user-global OpenCode config home with a well-formed marker
    // skill, then point XDG_CONFIG_HOME at it. This makes the leak check
    // non-vacuous on a machine with no ~/.config/opencode: without isolation
    // the host would discover this marker from the global home, so its absence
    // proves the host reads only Vina's isolated config.
    const fakeGlobal = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-global-'));
    const globalOpenCode = path.join(fakeGlobal, 'opencode');
    const markerSkillId = 'vina-marker-should-not-leak';
    const markerDir = path.join(globalOpenCode, 'skill', markerSkillId);
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(
      path.join(markerDir, 'SKILL.md'),
      `---\nname: ${markerSkillId}\ndescription: isolation marker that must never leak\n---\n\n# Marker\n`,
    );
    const prevXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = fakeGlobal;

    // Boot with the generated config content + the isolated config home, the
    // same shape hostCreateOptions produces.
    const configContent = fs.readFileSync(paths.opencodeConfigFile, 'utf8');
    const oc = await OpenCode.create({
      config: { directory: hostCreateOptions(dataDir).config.directory, content: configContent },
    });
    try {
      const entries = (await oc.config.get()) as ConfigEntry[];

      // Isolation: nothing the host reads may come from the seeded global home,
      // and the marker skill must not be registered anywhere.
      for (const entry of entries) {
        if (entry.path) {
          const resolved = path.resolve(entry.path);
          expect(
            resolved.startsWith(globalOpenCode + path.sep) || resolved === globalOpenCode,
            `leaked user global config: ${resolved}`,
          ).toBe(false);
        }
        expect(
          (entry.info?.skills ?? []).some((s) => s.includes(markerSkillId)),
          `marker skill leaked via ${entry.path ?? '<unnamed entry>'}`,
        ).toBe(false);
      }

      // The generated config is what the host sees: explicit skills[], and the
      // disabled Playwright MCP entry. (The six agents are markdown definitions,
      // pinned by the snapshot + allowlist tests.)
      const doc = entries.find((e) => e.type === 'document');
      expect(doc, 'generated config document').toBeDefined();
      expect(doc!.info?.skills).toEqual(
        VENDORED_SKILL_IDS.map((id) => `skills/${id}`),
      );

      const playwright = doc!.info?.mcp?.servers?.playwright;
      expect(playwright).toBeDefined();
      expect(playwright!.disabled).toBe(true);

      // The isolated config home is the directory the host was pointed at.
      const dirEntry = entries.find((e) => e.type === 'directory');
      expect(dirEntry).toBeDefined();
      expect(path.resolve(dirEntry!.path ?? '')).toBe(paths.configHomeDir);
    } finally {
      if (prevXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
      else process.env['XDG_CONFIG_HOME'] = prevXdg;
      await oc.close();
    }
  }, 30_000);

  it('hostCreateOptions points at the Vina-owned config home under the workspace', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-boot-'));
    const paths = workspacePaths(dataDir);
    expect(hostCreateOptions(dataDir)).toEqual({ config: { directory: paths.configHomeDir } });
    expect(paths.configHomeDir.startsWith(paths.workspaceDir)).toBe(true);
  });
});
