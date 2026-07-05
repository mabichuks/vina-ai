import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPromptLoader,
  type PromptDoc,
  type PromptLoader,
} from '@vina/orchestrator';
import { ValidationError, createLogger } from '@vina/shared';

const log = createLogger('prompts-service');

export interface PromptsServiceOptions {
  /** Vina data directory. User overrides live in `<dataDir>/prompts/`. */
  dataDir: string;
  /**
   * Override the packaged defaults dir for tests. In production the service
   * locates `packages/orchestrator/prompts/` automatically via the orchestrator
   * package's `dist/`-relative resolver — re-derived here from this file's URL
   * to keep the bundled server self-contained.
   */
  defaultsDirOverride?: string;
}

/** Locate the orchestrator's packaged `prompts/` directory at runtime. */
function locateDefaultsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // here is packages/server/{src,dist}/services/. Resolve up the workspace:
  // <repo>/packages/orchestrator/prompts/
  return path.resolve(here, '..', '..', '..', 'orchestrator', 'prompts');
}

export interface PromptsService {
  /** The cached loader graphs should call. Overrides survive process restarts. */
  loader: PromptLoader;
  list(): Promise<
    Array<{
      id: string;
      title: string;
      graph: string;
      editable_by_user: boolean;
      variables: string[];
      version: number;
      is_overridden: boolean;
    }>
  >;
  get(id: string): Promise<{
    summary: {
      id: string;
      title: string;
      graph: string;
      editable_by_user: boolean;
      variables: string[];
      version: number;
      is_overridden: boolean;
    };
    default_body: string;
    override_body: string | null;
    active_body: string;
  }>;
  update(id: string, body: string): Promise<void>;
  revert(id: string): Promise<void>;
}

export async function createPromptsService(
  opts: PromptsServiceOptions,
): Promise<PromptsService> {
  const defaultsDir = opts.defaultsDirOverride ?? locateDefaultsDir();
  const overridesDir = path.join(opts.dataDir, 'prompts');
  await fs.mkdir(overridesDir, { recursive: true });

  const loader = createPromptLoader({ defaultsDir, overridesDir });

  // Distinct loader pointing only at defaults — used to surface `default_body`
  // for the detail endpoint even when an override is active.
  const defaultsOnly = createPromptLoader({ defaultsDir });

  async function readBody(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async function defaultRawBody(id: string): Promise<string> {
    const filePath = path.join(defaultsDir, `${id}.md`);
    const raw = await fs.readFile(filePath, 'utf8');
    return raw;
  }

  function toSummary(doc: PromptDoc): {
    id: string;
    title: string;
    graph: string;
    editable_by_user: boolean;
    variables: string[];
    version: number;
    is_overridden: boolean;
  } {
    return {
      id: doc.id,
      title: doc.title,
      graph: doc.graph,
      editable_by_user: doc.editableByUser,
      variables: [...doc.variables],
      version: doc.version,
      is_overridden: doc.source === 'override',
    };
  }

  async function list() {
    const docs = await loader.list();
    return docs.map(toSummary);
  }

  async function get(id: string) {
    const activeDoc = await loader.load(id);
    const overridePath = path.join(overridesDir, `${id}.md`);
    const overrideRaw = await readBody(overridePath);
    const defaultRaw = await defaultRawBody(id);
    return {
      summary: toSummary(activeDoc),
      default_body: defaultRaw,
      override_body: overrideRaw,
      active_body:
        activeDoc.source === 'override' ? (overrideRaw ?? '') : defaultRaw,
    };
  }

  async function update(id: string, body: string): Promise<void> {
    // Step 1: editable_by_user check on the default.
    const def = await defaultsOnly.load(id);
    if (!def.editableByUser) {
      throw new ValidationError(`prompt '${id}' is not editable by the user`);
    }

    // Step 2: write to a temp path, point a fresh loader at it, ensure it
    // parses + frontmatter id matches + placeholders are a subset of default.
    // We use a one-shot tempdir + invalidate so we never trust the on-disk
    // override until validation passes.
    const overridePath = path.join(overridesDir, `${id}.md`);
    const tempDir = path.join(overridesDir, `.tmp-${id}-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${id}.md`);
    await fs.writeFile(tempPath, body, 'utf8');

    try {
      const validateLoader = createPromptLoader({
        defaultsDir,
        overridesDir: tempDir,
      });
      const validated = await validateLoader.load(id);
      if (validated.id !== id) {
        throw new ValidationError(
          `prompt '${id}': frontmatter id '${validated.id}' does not match path`,
        );
      }
      // Dry render with fixture vars (one per declared variable).
      const fixtureVars: Record<string, string> = {};
      for (const v of validated.variables) fixtureVars[v] = '<test>';
      await validateLoader.render(id, fixtureVars);
    } catch (err) {
      await fs.rm(tempDir, { recursive: true, force: true });
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(
        `prompt '${id}' failed validation: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Step 3: keep the previous override as `.bak` for one level of undo.
    const previous = await readBody(overridePath);
    if (previous !== null) {
      await fs.writeFile(`${overridePath}.bak`, previous, 'utf8').catch((err) => {
        log.warn({ err, id }, 'failed to write .bak prior override');
      });
    }

    await fs.rename(tempPath, overridePath);
    await fs.rm(tempDir, { recursive: true, force: true });
    loader.invalidate(id);
    log.info({ id }, 'prompt override written');
  }

  async function revert(id: string): Promise<void> {
    const overridePath = path.join(overridesDir, `${id}.md`);
    try {
      await fs.unlink(overridePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    loader.invalidate(id);
    log.info({ id }, 'prompt override removed');
  }

  return { loader, list, get, update, revert };
}
