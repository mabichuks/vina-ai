import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  runScoreJob,
  type PromptLoader,
  type ScoreInput,
  type StructuredScorer,
} from '@vina/orchestrator';
import { ConflictError, createLogger, NotFoundError } from '@vina/shared';
import { findJobById, updateJobScore, updateJobStatus } from '../../db/repositories/jobs.js';
import { findProfile } from '../../db/repositories/profile.js';
import { listCvs } from '../../db/repositories/cvs.js';
import { getOrInitSearchPreferences } from '../../db/repositories/search-preferences.js';
import { getOrInitSettings } from '../../db/repositories/settings.js';
import { enqueueEasyApplyForJob } from '../easy-apply-enqueuer.js';
import { enqueueManualApplyForJob } from '../manual-apply-enqueuer.js';
import { checkEasyApplyGate, dayBucketFromIso } from '../../services/easy-apply-gate.js';
import type { EventBus } from '../../events/bus.js';

const log = createLogger('handler.score');

export interface ScoreHandlerDeps {
  db: DatabaseType;
  bus: EventBus;
  /**
   * Factory rather than a singleton because the active provider can change
   * between task runs (the user may pick a different provider mid-session).
   */
  buildModel: () => Promise<BaseChatModel>;
  /** Optional — when supplied, user-override-aware. Falls back to defaults. */
  promptLoader?: PromptLoader;
}

export interface ScorePayload {
  job_id: string;
}

export function createScoreHandler(
  deps: ScoreHandlerDeps,
): (payload: ScorePayload) => Promise<void> {
  return async (payload) => {
    const job = findJobById(deps.db, payload.job_id);
    if (!job) throw new NotFoundError(`Job ${payload.job_id} not found`);

    const profile = findProfile(deps.db);
    if (!profile) throw new ConflictError('Profile not configured — cannot score');

    const prefs = getOrInitSearchPreferences(deps.db);
    const defaultCv = listCvs(deps.db).find((c) => c.is_default) ?? null;

    const input: ScoreInput = {
      job: {
        title: job.title,
        company: job.company,
        location: job.location,
        description: job.description,
      },
      profile: {
        full_name: profile.full_name,
        bio: profile.bio,
      },
      cv_text: defaultCv?.extracted_text ?? null,
      prefs: {
        description: prefs.description,
        keywords: prefs.keywords,
        locations: prefs.locations,
        work_models: prefs.work_models,
        seniority: prefs.seniority,
        excluded_companies: prefs.excluded_companies,
      },
    };

    const model = await deps.buildModel();
    // BaseChatModel.withStructuredOutput returns a Runnable typed against
    // BaseLanguageModelInput, while runScoreJob's StructuredScorer narrows
    // invoke to ScoreMessages. The shapes are runtime-compatible (LangChain
    // accepts {role, content} arrays) but TS 6's stricter variance rejects
    // the assignment. The orchestrator's interface should be widened — see
    // M10 review note M-1 — until then, cast at the boundary.
    const result = await runScoreJob(
      input,
      model as unknown as StructuredScorer,
      deps.promptLoader ? { promptLoader: deps.promptLoader } : {},
    );

    deps.db.transaction(() => {
      updateJobScore(deps.db, job.id, result.score, result.justification);
      // Only flip status if the row is still in its initial state. The user
      // can skip / mark-applied between the score task being enqueued and
      // running; clobbering 'skipped' back to 'scored' here re-surfaces jobs
      // in the New worklist that they've already triaged.
      const fresh = findJobById(deps.db, job.id);
      if (fresh?.status === 'new') {
        updateJobStatus(deps.db, job.id, 'scored');
      }
    })();
    // Two events, two concerns: jobs:updated invalidates the worklist cache;
    // score:job_completed drives the search-progress store's "scoring N/M"
    // counter. Splitting them prevents a race where a fast score task that
    // completes BEFORE search:completed emits gets miscounted as a discovery
    // event, leaving the counter stuck below totalToScore forever.
    deps.bus.emit('jobs:updated', { ids: [job.id] });
    deps.bus.emit('score:job_completed', { job_id: job.id, score: result.score });
    log.info({ job_id: job.id, score: result.score }, 'job scored');

    // Autonomy hook: in autonomous mode, any job that clears the user's
    // score threshold goes straight into its pipeline. The shared enqueuers
    // are idempotent — a re-score won't duplicate the application/task pair.
    // For auto-apply jobs the gate also gets a chance to veto at enqueue
    // time (the handler still re-checks at task pickup — this is advisory).
    const settings = getOrInitSettings(deps.db);
    if (
      settings.easy_apply_mode === 'autonomous' &&
      result.score >= prefs.score_threshold
    ) {
      if (job.apply_method === 'manual') {
        try {
          enqueueManualApplyForJob(deps.db, deps.bus, job.id);
          log.info({ job_id: job.id }, 'autonomous-mode: enqueued prepare_manual_apply');
        } catch (err) {
          // Don't fail the score task on enqueue failure (e.g. no default CV).
          // The alert surface tells the user what's missing.
          log.warn({ err, job_id: job.id }, 'autonomous enqueue skipped');
        }
      } else if (job.apply_method === 'auto') {
        const nowIso = new Date().toISOString();
        const gate = checkEasyApplyGate(deps.db, {
          jobId: job.id,
          nowIso,
          today: dayBucketFromIso(nowIso),
        });
        if (gate.decision === 'allow' || gate.decision === 'dry_run') {
          try {
            enqueueEasyApplyForJob(deps.db, deps.bus, job.id);
            log.info({ job_id: job.id }, 'autonomous-mode: enqueued apply');
          } catch (err) {
            log.warn({ err, job_id: job.id }, 'autonomous apply enqueue skipped');
          }
        } else {
          log.info(
            { job_id: job.id, gate_reason: gate.reason },
            'autonomous-mode: apply blocked by gate at enqueue time',
          );
        }
      }
    }
  };
}
