import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkill, type Skill as RawSkill } from './loader.js';

/**
 * Summary returned by `index()`. Body is omitted to keep the always-available
 * "skill index" cheap — graphs see descriptions only and request the full
 * body via `load(id)` on demand. Matches the schema in `docs/skill-system.md` §4.
 */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  applies_to: string[];
  capabilities: string[];
  editable_by_user: boolean;
  version: number;
  source: 'default' | 'override' | 'user';
}

export interface Skill extends SkillSummary {
  body: string;
}

export interface SkillRegistry {
  /**
   * Descriptions-only index, optionally filtered to skills that declare
   * `applies_to` containing `graph` (or skills with no `applies_to`).
   */
  index(graph?: string): Promise<SkillSummary[]>;
  /** Full skill including body. Cached after first load. */
  load(id: string): Promise<Skill>;
  /** Every available skill summary (no body). */
  list(): Promise<SkillSummary[]>;
  /** Drop a single cached entry. Called by the CRUD endpoint after writes. */
  invalidate(id?: string): void;
}

export interface CreateSkillRegistryOptions {
  /** Packaged defaults directory, e.g. `<orchestrator>/skills/`. */
  defaultsDir: string;
  /** User overrides directory, e.g. `<dataDir>/skills/`. Optional. */
  overridesDir?: string;
  /**
   * Optional capability allowlist. When supplied, every loaded skill's
   * `capabilities` list is clamped to this set — defence in depth on top of
   * write-time validation.
   */
  capabilityAllowlist?: readonly string[];
}

async function readSkillFile(
  dir: string,
  id: string,
): Promise<RawSkill | null> {
  const filePath = path.join(dir, id, 'SKILL.md');
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return parseSkill(raw, filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function listSkillIds(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);
}

function toFull(
  raw: RawSkill,
  source: SkillSummary['source'],
  allowlist?: readonly string[],
): Skill {
  const capabilities = raw.meta.capabilities ?? [];
  const clamped = allowlist
    ? capabilities.filter((c) => allowlist.includes(c))
    : capabilities;
  return {
    id: raw.meta.id,
    name: raw.meta.name,
    description: raw.meta.description,
    applies_to: raw.meta.applies_to ?? [],
    capabilities: clamped,
    editable_by_user: raw.meta.editable_by_user ?? false,
    version: raw.meta.version ?? 1,
    source,
    body: raw.body,
  };
}

function toSummary(full: Skill): SkillSummary {
  // Body intentionally not included — `index()` callers never see it.
  const { body: _body, ...rest } = full;
  void _body;
  return rest;
}

export function createSkillRegistry(
  opts: CreateSkillRegistryOptions,
): SkillRegistry {
  const cache = new Map<string, Skill>();
  const allowlist = opts.capabilityAllowlist;

  async function resolveSkill(id: string): Promise<Skill> {
    if (opts.overridesDir) {
      const override = await readSkillFile(opts.overridesDir, id);
      if (override) {
        if (override.meta.id !== id) {
          throw new Error(
            `skill override ${id}: frontmatter id '${override.meta.id}' does not match directory`,
          );
        }
        // Determine whether this is a *replacement* of a packaged skill or a
        // brand-new user-only skill — informs the chatbot/UI what action the
        // user took.
        const packaged = await readSkillFile(opts.defaultsDir, id);
        const source: SkillSummary['source'] = packaged ? 'override' : 'user';
        return toFull(override, source, allowlist);
      }
    }
    const packaged = await readSkillFile(opts.defaultsDir, id);
    if (!packaged) throw new Error(`skill '${id}' not found`);
    if (packaged.meta.id !== id) {
      throw new Error(
        `packaged skill ${id}: frontmatter id '${packaged.meta.id}' does not match directory`,
      );
    }
    return toFull(packaged, 'default', allowlist);
  }

  async function load(id: string): Promise<Skill> {
    const cached = cache.get(id);
    if (cached) return cached;
    const full = await resolveSkill(id);
    cache.set(id, full);
    return full;
  }

  async function listIds(): Promise<string[]> {
    const [defaults, overrides] = await Promise.all([
      listSkillIds(opts.defaultsDir),
      opts.overridesDir ? listSkillIds(opts.overridesDir) : Promise.resolve([]),
    ]);
    const seen = new Set<string>([...defaults, ...overrides]);
    return [...seen].sort();
  }

  async function list(): Promise<SkillSummary[]> {
    const ids = await listIds();
    const skills = await Promise.all(ids.map(load));
    return skills.map(toSummary);
  }

  async function index(graph?: string): Promise<SkillSummary[]> {
    const all = await list();
    if (!graph) return all;
    return all.filter(
      (s) => s.applies_to.length === 0 || s.applies_to.includes(graph),
    );
  }

  function invalidate(id?: string): void {
    if (id) cache.delete(id);
    else cache.clear();
  }

  return { index, load, list, invalidate };
}

/**
 * Locate the packaged `skills/` directory next to `src/` or `dist/`. Mirrors
 * `resolvePromptDefaultsDir`.
 */
export function resolveSkillsDefaultsDir(fromFileUrl: string): string {
  const here = path.dirname(fileURLToPath(fromFileUrl));
  let dir = here;
  for (let i = 0; i < 5; i++) {
    if (path.basename(dir) === 'src' || path.basename(dir) === 'dist') {
      return path.join(dir, '..', 'skills');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`resolveSkillsDefaultsDir: could not locate skills/ above ${here}`);
}
