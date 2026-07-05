import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSkillRegistry,
  parseSkill,
  type Skill as RegistrySkill,
  type SkillRegistry,
} from '@vina/orchestrator';
import { ValidationError, createLogger } from '@vina/shared';

const log = createLogger('skills-service');

/**
 * Server-side allowlist of capability names a user-authored or override
 * skill may declare. Names not in this list are stripped on read (defence
 * in depth) and rejected on write. Extend as new capabilities ship.
 */
export const CAPABILITY_ALLOWLIST: readonly string[] = [
  // Browser-apply operating loop
  'snapshot',
  'inspectFields',
  'fillField',
  'act',
  'uploadCv',
  'uploadCoverLetter',
  'submit',
  'takeScreenshot',
  'createAlert',
  // Tailoring graphs
  'tailorCv',
  'tailorCoverLetter',
  // Prompt-editing tools (chatbot)
  'listPrompts',
  'getPrompt',
  'updatePrompt',
  'revertPrompt',
  // Skill-editing tools (chatbot)
  'listSkills',
  'getSkill',
  'createSkill',
  'updateSkill',
  'removeSkill',
  // Job-domain helpers
  'scoreJob',
  'searchJobs',
  'markApplied',
  'skipApplication',
];

/**
 * Skill IDs that ship packaged with `editable_by_user: false` and additional
 * server-side protection: even authoring a *new* skill with one of these
 * IDs is refused. Drives the "cannot overwrite a packaged safety skill" rule.
 */
const LOCKED_IDS = new Set(['browser-apply', 'prompt-editing']);

/** 16k character cap on user-authored skill bodies — protects token budgets. */
const MAX_BODY_CHARS = 16_384;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

export interface SkillsServiceOptions {
  dataDir: string;
  /** Override the packaged defaults dir for tests. */
  defaultsDirOverride?: string;
}

function locateDefaultsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'orchestrator', 'skills');
}

export interface SkillsService {
  registry: SkillRegistry;
  list(): Promise<RegistrySkill[]>;
  get(id: string): Promise<RegistrySkill>;
  /** Update or create. Validates frontmatter, capability allowlist, and locked IDs. */
  write(id: string, body: string): Promise<RegistrySkill>;
  remove(id: string): Promise<void>;
}

export async function createSkillsService(
  opts: SkillsServiceOptions,
): Promise<SkillsService> {
  const defaultsDir = opts.defaultsDirOverride ?? locateDefaultsDir();
  const overridesDir = path.join(opts.dataDir, 'skills');
  await fs.mkdir(overridesDir, { recursive: true });

  const registry = createSkillRegistry({
    defaultsDir,
    overridesDir,
    capabilityAllowlist: CAPABILITY_ALLOWLIST,
  });

  async function isPackagedSkill(id: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path.join(defaultsDir, id, 'SKILL.md'));
      return stat.isFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  function validateBody(id: string, body: string): void {
    if (body.length > MAX_BODY_CHARS) {
      throw new ValidationError(
        `skill '${id}' body exceeds ${MAX_BODY_CHARS} character cap`,
      );
    }
    const parsed = parseSkill(body, `skill ${id}`);
    if (parsed.meta.id !== id) {
      throw new ValidationError(
        `skill '${id}': frontmatter id '${parsed.meta.id}' does not match path`,
      );
    }
    if (parsed.meta.editable_by_user === false) {
      throw new ValidationError(
        `skill '${id}': cannot author an editable_by_user=false skill via the API`,
      );
    }
    const caps = parsed.meta.capabilities ?? [];
    const disallowed = caps.filter((c) => !CAPABILITY_ALLOWLIST.includes(c));
    if (disallowed.length > 0) {
      throw new ValidationError(
        `skill '${id}': disallowed capabilities ${JSON.stringify(disallowed)}`,
      );
    }
  }

  async function list(): Promise<RegistrySkill[]> {
    const summaries = await registry.list();
    return Promise.all(summaries.map((s) => registry.load(s.id)));
  }

  async function get(id: string): Promise<RegistrySkill> {
    return registry.load(id);
  }

  async function write(id: string, body: string): Promise<RegistrySkill> {
    if (!ID_RE.test(id)) {
      throw new ValidationError(`skill id '${id}' must be kebab-case`);
    }

    // Locked IDs may not be overridden OR re-created by the user.
    if (LOCKED_IDS.has(id)) {
      throw new ValidationError(
        `skill '${id}' is safety-critical and cannot be overwritten by the user`,
      );
    }

    // If the id maps to a packaged skill whose default has editable_by_user=false,
    // refuse the write. Locked IDs above are the common case; this catches any
    // future packaged skill that ships read-only without being listed.
    if (await isPackagedSkill(id)) {
      const packaged = await registry.load(id);
      if (!packaged.editable_by_user && packaged.source === 'default') {
        throw new ValidationError(
          `skill '${id}' is read-only — overrides are not permitted`,
        );
      }
    }

    validateBody(id, body);

    const dir = path.join(overridesDir, id);
    const filePath = path.join(dir, 'SKILL.md');
    await fs.mkdir(dir, { recursive: true });

    // Keep one level of undo as `.bak` next to the file.
    try {
      const previous = await fs.readFile(filePath, 'utf8');
      await fs.writeFile(`${filePath}.bak`, previous, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err, id }, 'failed to write .bak for skill override');
      }
    }
    await fs.writeFile(filePath, body, 'utf8');
    registry.invalidate(id);
    log.info({ id }, 'skill override written');
    return registry.load(id);
  }

  async function remove(id: string): Promise<void> {
    if (LOCKED_IDS.has(id)) {
      throw new ValidationError(
        `skill '${id}' is safety-critical and cannot be removed`,
      );
    }
    const dir = path.join(overridesDir, id);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    registry.invalidate(id);
    log.info({ id }, 'skill override removed');
  }

  return { registry, list, get, write, remove };
}
