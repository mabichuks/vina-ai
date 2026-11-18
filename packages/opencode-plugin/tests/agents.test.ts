import { describe, expect, it } from 'vitest';
import { VINA_AGENTS } from '../src/index.js';

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
    expect(agent.allowed).toEqual(['vina_job_get', 'vina_profile_read', 'vina_review_record']);
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

function byId(id: (typeof VINA_AGENTS)[number]['id']) {
  const agent = VINA_AGENTS.find((a) => a.id === id);
  if (!agent) throw new Error(`missing agent ${id}`);
  return agent;
}
