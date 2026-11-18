/**
 * The six Vina agent definitions (docs/opencode-orchestration.md §5).
 *
 * A single typed table is the source of truth for each agent's role, model
 * tier, and tool allow/deny list. The workspace generator renders this table
 * to markdown in `<dataDir>/workspace/agents/` so the UI can show it, and the
 * allowlist is the security boundary: a role denied `vina_easy_apply` must not
 * see it.
 *
 * Tool ids are the flattened `vina_<name>` form, plus `playwright` for the
 * browser MCP. `external_submit` is listed for `vina-manual` per §5 even
 * though the tool lands in a later stage (the allowlist is a forward contract).
 */

/** The `vina` tool short names an agent may be granted, in flattened form. */
export const VINA_ALL_TOOL_IDS = [
  'vina_profile_read',
  'vina_search_jobs',
  'vina_jobs_list',
  'vina_job_get',
  'vina_score_job',
  'vina_materials_save',
  'vina_review_record',
  'vina_application_status',
  'vina_easy_apply',
  'vina_external_submit',
  'vina_ask_user',
] as const;

/** The Playwright MCP browser capability id used in allow/deny lists. */
export const PLAYWRIGHT_TOOL_ID = 'playwright' as const;

export type VinaAgentId =
  | 'vina-sweep'
  | 'vina-materials'
  | 'vina-review'
  | 'vina-apply'
  | 'vina-manual'
  | 'vina-chat';

export interface VinaAgent {
  id: VinaAgentId;
  title: string;
  model: 'cheap' | 'strong';
  description: string;
  /** Tool ids the agent may call (positive allowlist). */
  allowed: readonly string[];
  /** Tool ids the agent must never call (the boundary §5 names as Denied). */
  denied: readonly string[];
  /** Extra prose notes (e.g. "workspace write" capability that is not a tool). */
  notes?: readonly string[];
}

/**
 * The six agents, dependency-ordered as in §5. `allowed`/`denied` mirror the
 * table's Allowed/Denied columns exactly, translated to concrete tool ids:
 *
 * - "search" → `vina_search_jobs`; "jobs list/get" → `vina_jobs_list` /
 *   `vina_job_get`; "score" → `vina_score_job`; "status" → `vina_application_status`.
 * - "materials read" → `vina_job_get` + `vina_profile_read`; "materials write" →
 *   `vina_materials_save`; "workspace write" is a non-tool capability, noted.
 * - "playwright" → the browser MCP.
 */
export const VINA_AGENTS: readonly VinaAgent[] = [
  {
    id: 'vina-sweep',
    title: 'Sweep',
    model: 'cheap',
    description: 'Find and score job leads; never prepares materials or applies.',
    allowed: ['vina_search_jobs', 'vina_jobs_list', 'vina_job_get', 'vina_score_job', PLAYWRIGHT_TOOL_ID],
    denied: ['vina_materials_save', 'vina_easy_apply'],
  },
  {
    id: 'vina-materials',
    title: 'Materials',
    model: 'strong',
    description: 'Tailor the CV and cover letter for one role; never submits.',
    allowed: ['vina_profile_read', 'vina_job_get', 'vina_materials_save', 'vina_ask_user'],
    denied: [PLAYWRIGHT_TOOL_ID, 'vina_easy_apply'],
    notes: ['May write workspace files (notes, intermediate HTML) under <dataDir>/workspace/runs/.'],
  },
  {
    id: 'vina-review',
    title: 'Review',
    model: 'strong',
    description: 'Independently audit tailored materials; records findings only.',
    allowed: ['vina_job_get', 'vina_profile_read', 'vina_review_record'],
    denied: [
      'vina_materials_save',
      'vina_easy_apply',
      'vina_application_status',
      'vina_score_job',
      'vina_external_submit',
      'vina_search_jobs',
    ],
    notes: ['Denies every write outside vina_review_record (fresh session, never sees the writer transcript).'],
  },
  {
    id: 'vina-apply',
    title: 'Apply',
    model: 'cheap',
    description: 'Submits a ready Easy Apply application; never tailors materials.',
    allowed: ['vina_easy_apply', 'vina_job_get', 'vina_ask_user'],
    denied: [PLAYWRIGHT_TOOL_ID, 'vina_materials_save'],
  },
  {
    id: 'vina-manual',
    title: 'Manual Apply',
    model: 'cheap',
    description: 'Assists external ATS applications; the user submits.',
    allowed: [
      PLAYWRIGHT_TOOL_ID,
      'vina_job_get',
      'vina_profile_read',
      'vina_application_status',
      'vina_external_submit',
    ],
    denied: ['vina_easy_apply'],
  },
  {
    id: 'vina-chat',
    title: 'Chat',
    model: 'strong',
    description: 'Conversational assistant over the pipeline; never submits or drives the browser.',
    allowed: ['vina_profile_read', 'vina_jobs_list', 'vina_application_status', 'vina_search_jobs', 'vina_ask_user'],
    denied: ['vina_easy_apply', PLAYWRIGHT_TOOL_ID],
  },
];
