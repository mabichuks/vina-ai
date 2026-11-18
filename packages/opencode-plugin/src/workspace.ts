import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VINA_AGENTS, type VinaAgent } from './agents.js';

/**
 * The generated agent workspace (docs/opencode-orchestration.md §3, §5).
 *
 * Boot writes `<dataDir>/workspace/` — `opencode.jsonc`, `AGENTS.md`, the six
 * agent markdown definitions, and the vendored skill tree. It is a generated
 * artefact: users never edit it. The isolated config home lives under the
 * workspace so a host started with Vina's config never inherits the user's
 * global OpenCode skills or agents (a privacy leak the stage-0 probe exposed).
 */

const WORKSPACE_DIRNAME = 'workspace';
const CONFIG_HOME_DIRNAME = 'config';
const SKILLS_DIRNAME = 'skills';
const AGENTS_DIRNAME = 'agents';

/** Pinned Playwright MCP version (stage-0 probe: `@playwright/mcp@0.0.85`). */
const PLAYWRIGHT_MCP_VERSION = '0.0.85';

/** The Vina plugin package name, declared in the generated config. */
const VINA_PLUGIN = '@vina/opencode-plugin';

export interface WorkspacePaths {
  workspaceDir: string;
  configHomeDir: string;
  skillsDir: string;
  agentsDir: string;
  opencodeConfigFile: string;
  agentsFile: string;
}

/** Paths for a data directory. Pure; creates nothing. */
export function workspacePaths(dataDir: string): WorkspacePaths {
  const workspaceDir = path.join(dataDir, WORKSPACE_DIRNAME);
  return {
    workspaceDir,
    configHomeDir: path.join(workspaceDir, CONFIG_HOME_DIRNAME),
    skillsDir: path.join(workspaceDir, SKILLS_DIRNAME),
    agentsDir: path.join(workspaceDir, AGENTS_DIRNAME),
    opencodeConfigFile: path.join(workspaceDir, 'opencode.jsonc'),
    agentsFile: path.join(workspaceDir, 'AGENTS.md'),
  };
}

/**
 * The vendored skills source directory, resolved relative to this module so it
 * works from source (tests/tsx) and from `dist/` alike. Both `dist/` and
 * `skills/` sit under the plugin package root.
 */
export function defaultSkillsSourceDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
}

/**
 * The isolated config-home options for `OpenCode.create`. `@opencode/sdk@2.3.1`
 * wires `config.directory` straight into the host's `Global` config path (see
 * `@opencode/server` routes: `Global.layerWith({ config: options.config.directory })`),
 * replacing the default `$XDG_CONFIG_HOME/opencode`. Pointing it at a Vina-owned
 * directory keeps the user's personal OpenCode skills/agents out of Vina's host.
 */
export function hostCreateOptions(dataDir: string): { config: { directory: string } } {
  return { config: { directory: workspacePaths(dataDir).configHomeDir } };
}

export interface GenerateWorkspaceOptions {
  dataDir: string;
  /** Absolute path to the vendored skills source (defaults to the plugin's `skills/`). */
  skillsSourceDir?: string;
}

/**
 * Idempotently write the workspace. Re-running with the same inputs writes the
 * same bytes and leaves existing files untouched when their content is unchanged.
 */
export function generateWorkspace(options: GenerateWorkspaceOptions): WorkspacePaths {
  const paths = workspacePaths(options.dataDir);
  const skillsSourceDir = options.skillsSourceDir ?? defaultSkillsSourceDir();

  fs.mkdirSync(paths.workspaceDir, { recursive: true });
  fs.mkdirSync(paths.configHomeDir, { recursive: true });
  fs.mkdirSync(paths.agentsDir, { recursive: true });

  writeIfChanged(paths.opencodeConfigFile, renderOpencodeConfig());
  writeIfChanged(paths.agentsFile, renderAgentsDoc());
  for (const agent of VINA_AGENTS) {
    writeIfChanged(path.join(paths.agentsDir, `${agent.id}.md`), renderAgent(agent));
  }
  copySkillsTree(skillsSourceDir, paths.skillsDir);

  return paths;
}

// ---------------------------------------------------------------------------
// opencode.jsonc
// ---------------------------------------------------------------------------

/**
 * The eight vendored skill ids, in registration order.
 */
export const VENDORED_SKILL_IDS = [
  'job-sweep',
  'job-materials',
  'job-review',
  'job-apply',
  'job-inbox',
  'job-interview',
  'job-pipeline',
  'job-setup',
] as const;

/**
 * The generated config. `skills[]` lists each vendored skill directory
 * explicitly (relative to the workspace location); the stage-0 probe showed
 * implicit `.opencode/skills` discovery does not register in the embedded
 * host. The Playwright MCP entry is present but disabled until the MCP issue
 * lands; the live entry is registered by the plugin at activation.
 */
export function renderOpencodeConfig(): string {
  const skillIds = VENDORED_SKILL_IDS;

  const config = {
    $schema: 'https://opencode.ai/config.json',
    // Generated at boot; do not edit. Skills are vendored (see skills/harness-version.json).
    skills: skillIds.map((id) => `${SKILLS_DIRNAME}/${id}`),
    plugins: [VINA_PLUGIN],
    mcp: {
      servers: {
        playwright: {
          type: 'local',
          command: [
            'npx',
            '-y',
            `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
            '--browser',
            'chrome',
            '--headless',
          ],
          // Present but disabled until the Playwright MCP issue lands.
          disabled: true,
        },
      },
    },
  };

  return `${JSON.stringify(config, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// AGENTS.md
// ---------------------------------------------------------------------------

export function renderAgentsDoc(): string {
  return `# AGENTS.md

Generated at boot; never edit by hand. Vina regenerates this workspace from
the vendored skill tree and the typed agent table in \`@vina/opencode-plugin\`.

## Workspace

- \`opencode.jsonc\` — the host config (explicit \`skills[]\`, the Vina plugin,
  and the Playwright MCP entry, present but disabled).
- \`agents/\` — the six agent definitions (allowlists from
  docs/opencode-orchestration.md §5).
- \`skills/\` — the vendored harness skills (see \`skills/harness-version.json\`).
- \`runs/<taskId>/\` — per-task scratch.

## Conventions

- Skills are workspace-agnostic: personal facts resolve at runtime from Vina's
  SQLite via the \`vina_*\` tools, never from prose. Stop rather than guess a
  missing fact.
- OpenCode decides, Vina acts. Every read and every effect goes through a typed
  \`vina_*\` tool; the agent never reads the database or drives a browser outside
  the granted tools.
- SQLite owns state. Markdown-note and pipeline-ledger mechanics described by
  the vendored skills are reference-only; the \`vina_*\` tools are the write path.
- The allowlist is the security boundary: a role denied \`vina_easy_apply\` must
  not see it, and \`vina-review\` runs in a fresh session that never saw the
  writer's transcript.
- Never commit personal data. Examples use fictional people and companies.
`;
}

// ---------------------------------------------------------------------------
// Agent markdown
// ---------------------------------------------------------------------------

export function renderAgent(agent: VinaAgent): string {
  const allowed = agent.allowed.map((t) => `- \`${t}\``).join('\n');
  const denied = agent.denied.map((t) => `- \`${t}\``).join('\n');
  const notes = agent.notes ? `\n${agent.notes.map((n) => `- ${n}`).join('\n')}` : '';
  return `---
description: ${agent.description}
mode: subagent
---
You are ${agent.title} (${agent.id}). ${agent.description}

## Allowed tools

${allowed}

## Denied tools

${denied}
${notes}
`;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function writeIfChanged(file: string, content: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === content) return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.writeFileSync(file, content, 'utf8');
}

/**
 * Copy the vendored skill tree (`SKILL.md` + `references/`) into the
 * workspace. Skips nothing: the source tree already excludes `scripts/` and
 * `assets/` at vendoring time. `harness-version.json` travels with it so the
 * runtime workspace records the harness version it carries.
 */
function copySkillsTree(sourceDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copySkillsTree(src, dst);
    } else {
      const content = fs.readFileSync(src);
      try {
        if (fs.readFileSync(dst).equals(content)) continue;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      fs.writeFileSync(dst, content);
    }
  }
}
