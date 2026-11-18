import { describe, expect, it } from 'vitest';
import { isToolDenied, trimToolsForAgent, VINA_AGENTS } from '../src/index.js';

/**
 * The allowlist is the security boundary, not documentation
 * (docs/opencode-orchestration.md §5). This test pins each of the six agents'
 * allowed/denied tool sets to the §5 table exactly, so a drift in the typed
 * table fails loudly. The two notes the issue calls out are asserted directly:
 * `vina-manual` holds `external_submit`, and `vina-review` denies every write
 * outside `vina_review_record`.
 */
describe('VINA_AGENTS allowlists match opencode-orchestration.md §5', () => {
  it('defines exactly the six agents, in dependency order', () => {
    expect(VINA_AGENTS.map((a) => a.id)).toEqual([
      'vina-sweep',
      'vina-materials',
      'vina-review',
      'vina-apply',
      'vina-manual',
      'vina-chat',
    ]);
  });

  it('vina-sweep: search, jobs list/get, score, playwright; denies materials_save, easy_apply', () => {
    const agent = byId('vina-sweep');
    expect(agent.allowed).toEqual([
      'vina_search_jobs',
      'vina_jobs_list',
      'vina_job_get',
      'vina_score_job',
      'playwright',
    ]);
    expect(agent.denied).toEqual(['vina_materials_save', 'vina_easy_apply']);
  });

  it('vina-materials: profile_read, job_get, materials_save, ask_user; denies playwright, easy_apply', () => {
    const agent = byId('vina-materials');
    expect(agent.allowed).toEqual([
      'vina_profile_read',
      'vina_job_get',
      'vina_materials_save',
      'vina_ask_user',
    ]);
    expect(agent.denied).toEqual(['playwright', 'vina_easy_apply']);
  });

  it('vina-review: job_get, materials read, review_record; denies every write outside review_record', () => {
    const agent = byId('vina-review');
    expect(agent.allowed).toEqual([
      'vina_job_get',
      'vina_profile_read',
      'vina_materials_read',
      'vina_review_record',
    ]);
    // Every mutating tool except review_record must be denied.
    expect(agent.denied).toEqual(
      expect.arrayContaining([
        'vina_materials_save',
        'vina_easy_apply',
        'vina_application_status',
        'vina_score_job',
        'vina_external_submit',
        'vina_search_jobs',
      ]),
    );
    // review_record itself is the reviewer's only write and must not be denied.
    expect(agent.denied).not.toContain('vina_review_record');
    expect(agent.allowed).toContain('vina_review_record');
  });

  it('vina-apply: easy_apply, job_get, ask_user; denies playwright, materials write', () => {
    const agent = byId('vina-apply');
    expect(agent.allowed).toEqual(['vina_easy_apply', 'vina_job_get', 'vina_ask_user']);
    expect(agent.denied).toEqual(['playwright', 'vina_materials_save']);
  });

  it('vina-manual: playwright, job_get, materials read, status, external_submit; denies easy_apply', () => {
    const agent = byId('vina-manual');
    expect(agent.allowed).toEqual([
      'playwright',
      'vina_job_get',
      'vina_profile_read',
      'vina_application_status',
      'vina_external_submit',
    ]);
    expect(agent.allowed).toContain('vina_external_submit');
    expect(agent.denied).toEqual(['vina_easy_apply']);
  });

  it('vina-chat: profile_read, jobs, status, search, ask_user; denies easy_apply, playwright', () => {
    const agent = byId('vina-chat');
    expect(agent.allowed).toEqual([
      'vina_profile_read',
      'vina_jobs_list',
      'vina_application_status',
      'vina_search_jobs',
      'vina_ask_user',
    ]);
    expect(agent.denied).toEqual(['vina_easy_apply', 'playwright']);
  });

  it('no agent is allowed and denied the same tool', () => {
    for (const agent of VINA_AGENTS) {
      const overlap = agent.allowed.filter((t) => agent.denied.includes(t));
      expect(overlap, agent.id).toEqual([]);
    }
  });
});

describe('isToolDenied / trimToolsForAgent (hard boundary)', () => {
  const chatToolSet: Record<string, unknown> = {
    vina_profile_read: {},
    vina_jobs_list: {},
    vina_application_status: {},
    vina_search_jobs: {},
    vina_ask_user: {},
    vina_easy_apply: {},
    vina_external_submit: {},
    vina_materials_save: {},
    playwright_navigate: {},
    playwright_click: {},
  };

  it('vina-chat loses the submit tools and every playwright* tool', () => {
    const tools = { ...chatToolSet };
    const removed = trimToolsForAgent('vina-chat', tools, 'autonomous');
    expect(removed).toEqual(
      expect.arrayContaining([
        'vina_easy_apply',
        'vina_external_submit',
        'playwright_navigate',
        'playwright_click',
      ]),
    );
    expect(tools).not.toHaveProperty('vina_easy_apply');
    expect(tools).not.toHaveProperty('vina_external_submit');
    expect(Object.keys(tools)).not.toContain('playwright_navigate');
    expect(Object.keys(tools)).not.toContain('playwright_click');
    // Its allowed read/status tools survive.
    expect(tools).toHaveProperty('vina_profile_read');
    expect(tools).toHaveProperty('vina_jobs_list');
    expect(tools).toHaveProperty('vina_application_status');
    expect(tools).toHaveProperty('vina_search_jobs');
    expect(tools).toHaveProperty('vina_ask_user');
  });

  it('vina-review removes every write tool except vina_review_record', () => {
    const tools: Record<string, unknown> = {
      vina_job_get: {},
      vina_profile_read: {},
      vina_materials_read: {},
      vina_review_record: {},
      vina_materials_save: {},
      vina_application_status: {},
      vina_score_job: {},
      vina_easy_apply: {},
      vina_external_submit: {},
      playwright_navigate: {},
    };
    trimToolsForAgent('vina-review', tools, 'autonomous');
    expect(tools).toHaveProperty('vina_review_record');
    expect(tools).toHaveProperty('vina_materials_read');
    expect(tools).not.toHaveProperty('vina_materials_save');
    expect(tools).not.toHaveProperty('vina_application_status');
    expect(tools).not.toHaveProperty('vina_score_job');
    expect(tools).not.toHaveProperty('vina_easy_apply');
    expect(tools).not.toHaveProperty('vina_external_submit');
    expect(tools).not.toHaveProperty('playwright_navigate');
  });

  it('vina-apply keeps vina_easy_apply but loses external_submit and playwright', () => {
    const tools: Record<string, unknown> = {
      vina_easy_apply: {},
      vina_job_get: {},
      vina_ask_user: {},
      vina_external_submit: {},
      playwright_navigate: {},
    };
    trimToolsForAgent('vina-apply', tools, 'autonomous');
    expect(tools).toHaveProperty('vina_easy_apply');
    expect(tools).not.toHaveProperty('vina_external_submit');
    expect(tools).not.toHaveProperty('playwright_navigate');
  });

  it('vina-manual keeps external_submit and playwright but loses easy_apply', () => {
    const tools: Record<string, unknown> = {
      vina_external_submit: {},
      playwright_navigate: {},
      vina_job_get: {},
      vina_profile_read: {},
      vina_application_status: {},
      vina_easy_apply: {},
    };
    trimToolsForAgent('vina-manual', tools, 'autonomous');
    expect(tools).toHaveProperty('vina_external_submit');
    expect(tools).toHaveProperty('playwright_navigate');
    expect(tools).not.toHaveProperty('vina_easy_apply');
  });

  it('an unknown/mis-resolved agent id default-denies submit and browser', () => {
    const tools: Record<string, unknown> = {
      vina_easy_apply: {},
      vina_external_submit: {},
      playwright_navigate: {},
      vina_profile_read: {},
    };
    trimToolsForAgent('does-not-exist-xyz', tools, 'autonomous');
    expect(tools).not.toHaveProperty('vina_easy_apply');
    expect(tools).not.toHaveProperty('vina_external_submit');
    expect(tools).not.toHaveProperty('playwright_navigate');
    // Non-submit tools are left alone for an unknown agent.
    expect(tools).toHaveProperty('vina_profile_read');
  });

  it('playwright matches by namespace prefix, not only exact', () => {
    expect(isToolDenied('vina-chat', 'playwright', 'autonomous')).toBe(true);
    expect(isToolDenied('vina-chat', 'playwright_navigate', 'autonomous')).toBe(true);
    expect(isToolDenied('vina-chat', 'playwright_click', 'autonomous')).toBe(true);
    expect(isToolDenied('vina-chat', 'vina_easy_apply', 'autonomous')).toBe(true);
    expect(isToolDenied('vina-chat', 'vina_profile_read', 'autonomous')).toBe(false);
  });
});

describe('mode-aware external-apply trim (external_apply_mode)', () => {
  const manualTools: Record<string, unknown> = {
    vina_external_submit: {},
    playwright_navigate: {},
    playwright_type: {},
    vina_job_get: {},
    vina_profile_read: {},
    vina_application_status: {},
    vina_easy_apply: {},
  };

  it('manual: vina-manual loses playwright* AND vina_external_submit', () => {
    const tools = { ...manualTools };
    trimToolsForAgent('vina-manual', tools, 'manual');
    expect(tools).not.toHaveProperty('vina_external_submit');
    expect(tools).not.toHaveProperty('playwright_navigate');
    expect(tools).not.toHaveProperty('playwright_type');
    // Its read/status tools survive; easy_apply stays denied by the static table.
    expect(tools).toHaveProperty('vina_job_get');
    expect(tools).toHaveProperty('vina_profile_read');
    expect(tools).not.toHaveProperty('vina_easy_apply');
  });

  it('assisted: vina-manual keeps playwright* but loses vina_external_submit', () => {
    const tools = { ...manualTools };
    trimToolsForAgent('vina-manual', tools, 'assisted');
    expect(tools).toHaveProperty('playwright_navigate');
    expect(tools).toHaveProperty('playwright_type');
    expect(tools).not.toHaveProperty('vina_external_submit');
  });

  it('autonomous: vina-manual keeps both playwright* and vina_external_submit', () => {
    const tools = { ...manualTools };
    trimToolsForAgent('vina-manual', tools, 'autonomous');
    expect(tools).toHaveProperty('playwright_navigate');
    expect(tools).toHaveProperty('playwright_type');
    expect(tools).toHaveProperty('vina_external_submit');
  });

  it('manual mode denies playwright* to every agent (no external browser)', () => {
    // vina-sweep is granted playwright in the static table but must lose it in manual mode.
    const tools = { playwright_navigate: {}, vina_search_jobs: {} };
    trimToolsForAgent('vina-sweep', tools, 'manual');
    expect(tools).not.toHaveProperty('playwright_navigate');
    expect(tools).toHaveProperty('vina_search_jobs');
  });

  it('vina_external_submit is unreachable outside autonomous for any agent', () => {
    expect(isToolDenied('vina-manual', 'vina_external_submit', 'manual')).toBe(true);
    expect(isToolDenied('vina-manual', 'vina_external_submit', 'assisted')).toBe(true);
    expect(isToolDenied('vina-manual', 'vina_external_submit', 'autonomous')).toBe(false);
  });
});

function byId(id: (typeof VINA_AGENTS)[number]['id']) {
  const agent = VINA_AGENTS.find((a) => a.id === id);
  if (!agent) throw new Error(`missing agent ${id}`);
  return agent;
}
