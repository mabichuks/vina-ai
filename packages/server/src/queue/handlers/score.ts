import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { runScoreJob, type ScoreInput } from '@vina/orchestrator';
import { createLogger, NotFoundError } from '@vina/shared';
import { findJobById, updateJobScore, updateJobStatus } from '../../db/repositories/jobs.js';
import { findProfile } from '../../db/repositories/profile.js';
import { getOrInitSearchPreferences } from '../../db/repositories/search-preferences.js';
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
    if (!profile) throw new NotFoundError('Profile not configured — cannot score');

    const prefs = getOrInitSearchPreferences(deps.db);

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
    const result = await runScoreJob(input, model);

    updateJobScore(deps.db, job.id, result.score, result.justification);
    updateJobStatus(deps.db, job.id, 'scored');
    deps.bus.emit('jobs:updated', { ids: [job.id] });
    log.info({ job_id: job.id, score: result.score }, 'job scored');
  };
}
