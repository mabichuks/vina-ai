import fs from 'node:fs/promises';
import path from 'node:path';
import { NotFoundError } from '@vina/shared';

/**
 * Prompt CRUD is retired with the prompt registry (#19 deletes the
 * orchestrator's prompt loader and the packaged `.md` prompts — score/tailor
 * wording now lives in the server scoring service and the vendored skills).
 * The service is kept as a no-op so the `/api/prompts` route and the Settings
 * "Prompts" tile keep a stable (empty) contract without referencing the
 * deleted orchestrator loader. Removed wholesale in a later cleanup.
 */

export interface PromptsServiceOptions {
  dataDir: string;
  defaultsDirOverride?: string;
}

export interface PromptSummary {
  id: string;
  title: string;
  graph: string;
  editable_by_user: boolean;
  variables: string[];
  version: number;
  is_overridden: boolean;
}

export interface PromptDetail {
  summary: PromptSummary;
  default_body: string;
  override_body: string | null;
  active_body: string;
}

export interface PromptsService {
  list(): Promise<PromptSummary[]>;
  get(id: string): Promise<PromptDetail>;
  update(id: string, body: string): Promise<void>;
  revert(id: string): Promise<void>;
}

export async function createPromptsService(
  opts: PromptsServiceOptions,
): Promise<PromptsService> {
  // Keep the overrides directory in place so any prior user overrides are not
  // orphaned silently, but nothing reads them anymore.
  await fs.mkdir(path.join(opts.dataDir, 'prompts'), { recursive: true }).catch(() => {});

  return {
    async list() {
      return [];
    },
    async get(id: string) {
      throw new NotFoundError(`prompt '${id}' not found`);
    },
    async update(id: string) {
      throw new NotFoundError(`prompt '${id}' not found`);
    },
    async revert(_id: string) {
      // No prompts exist; reverting is a no-op.
    },
  };
}
