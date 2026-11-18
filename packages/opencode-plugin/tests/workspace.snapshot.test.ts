import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateWorkspace, VINA_AGENTS } from '../src/index.js';

/**
 * Snapshot-pins the generated workspace so drift in the boot output is a
 * visible, failing change: `opencode.jsonc` (explicit skills[], the plugin, and
 * the disabled Playwright MCP entry), `AGENTS.md`, the six agent markdown
 * definitions, and the vendored skill tree (file list + content hashes — the
 * prose itself is ~9.6k lines and is pinned by the vendor-integrity test).
 */
describe('workspace snapshot', () => {
  it('generates a stable workspace', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-ws-'));
    const paths = generateWorkspace({ dataDir });

    // opencode.jsonc: explicit skills[], plugin, disabled playwright MCP.
    expect(read(paths.opencodeConfigFile)).toMatchSnapshot('opencode.jsonc');
    expect(read(paths.agentsFile)).toMatchSnapshot('AGENTS.md');

    // Six agent markdown definitions.
    const agents: Record<string, string> = {};
    for (const agent of VINA_AGENTS) {
      agents[agent.id] = read(path.join(paths.agentsDir, `${agent.id}.md`));
    }
    expect(agents).toMatchSnapshot('agents');

    // Vendored skill tree: structure + per-file content hash (drift detection).
    const tree = snapshotTree(paths.skillsDir);
    expect(tree).toMatchSnapshot('skills');
  });

  it('is idempotent: re-running writes identical content and no extra files', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-ws-'));
    const first = generateWorkspace({ dataDir });
    const before = snapshotTree(path.join(first.workspaceDir));
    const second = generateWorkspace({ dataDir });
    const after = snapshotTree(path.join(second.workspaceDir));
    expect(after).toEqual(before);
  });

  it('uses relative skill paths so the config is machine-independent', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-ws-'));
    const paths = generateWorkspace({ dataDir });
    const config = JSON.parse(read(paths.opencodeConfigFile)) as { skills: string[] };
    expect(config.skills).toEqual([
      'skills/job-sweep',
      'skills/job-materials',
      'skills/job-review',
      'skills/job-apply',
      'skills/job-inbox',
      'skills/job-interview',
      'skills/job-pipeline',
      'skills/job-setup',
    ]);
  });

  it('creates the isolated config home directory', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-ws-'));
    const paths = generateWorkspace({ dataDir });
    expect(fs.statSync(paths.configHomeDir).isDirectory()).toBe(true);
  });
});

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** A stable description of a tree: sorted relative paths + content hashes. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const rel = entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(out, prefix(snapshotTree(abs), rel));
    } else {
      out[rel] = hash(read(abs));
    }
  }
  return out;
}

function prefix(tree: Record<string, string>, dir: string): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).map(([k, v]) => [path.join(dir, k), v]));
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}
