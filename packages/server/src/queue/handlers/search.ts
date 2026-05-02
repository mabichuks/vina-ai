import type { Database as DatabaseType } from 'better-sqlite3';
import { createLogger, ValidationError, type SiteKind } from '@vina/shared';
import { findSiteById } from '../../db/repositories/sites.js';
import { insertJob } from '../../db/repositories/jobs.js';
import { enqueue } from '../../db/repositories/task-queue.js';
import type { EventBus } from '../../events/bus.js';

const log = createLogger('handler.search');

export interface SearchHandlerDeps {
  db: DatabaseType;
  bus: EventBus;
}

export interface SearchPayload {
  site_id: string;
}

/**
 * M10 stub. Real adapters land in M11 (LinkedIn), M12 (Indeed), and M13
 * (Google Jobs via SerpAPI). Until then, this handler synthesises a single
 * job per invocation so the rest of the pipeline (score, eventually tailor)
 * can be wired and tested end-to-end.
 *
 * The synthetic job has `apply_method='auto'` for browser-kind sites and
 * `'manual'` for api-kind sites, mirroring what the real adapters will do.
 */
export function createSearchHandler(
  deps: SearchHandlerDeps,
): (payload: SearchPayload) => Promise<void> {
  return async (payload) => {
    const site = findSiteById(deps.db, payload.site_id);
    if (!site) {
      throw new ValidationError(`Unknown site_id: ${payload.site_id}`);
    }

    const apply_method = site.kind === ('browser' satisfies SiteKind) ? 'auto' : 'manual';
    const externalId = `m10-stub-${Date.now()}`;

    const job = insertJob(deps.db, {
      site_id: site.id,
      external_id: externalId,
      url: `https://example.invalid/${site.id}/${externalId}`,
      apply_method,
      title: 'Senior Software Engineer (synthetic)',
      company: 'Example Corp',
      location: 'Remote',
      description:
        'Synthetic listing emitted by the M10 search-handler stub so the score pipeline can be tested. Real listings land with the M11+ adapters.',
    });

    enqueue(deps.db, { kind: 'score', payload: { job_id: job.id } });
    deps.bus.emit('jobs:updated', { ids: [job.id] });
    log.info({ site: site.id, job_id: job.id }, 'synthesised stub job for M10');
  };
}
