import { createHash } from 'node:crypto';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ApplicationEventKind,
  type ApplicationStatus,
} from '@vina/shared';
import {
  runApply,
  runPrepareManualApply,
  runScoreJob,
  type StructuredScorer,
  type StructuredApplyDecider,
  type RunApplyOptions,
  type ApplyResult,
  type ApplyEvent,
  type ManualApplyToolKit,
  type SkillRegistry,
  type PromptLoader,
} from '@vina/orchestrator';
import type { BrowserManagerHandle, SiteAdapter } from '@vina/automation';
import type {
  VinaServices,
  ProfileReadInput,
  ProfileReadOutput,
  SearchJobsInput,
  SearchJobsOutput,
  JobsListInput,
  JobsListOutput,
  JobGetInput,
  JobGetOutput,
  ScoreJobInput,
  ScoreJobOutput,
  MaterialsSaveInput,
  MaterialsSaveOutput,
  ReviewRecordInput,
  ReviewRecordOutput,
  ApplicationStatusInput,
  ApplicationStatusOutput,
  EasyApplyInput,
  EasyApplyOutput,
  AskUserInput,
  AskUserOutput,
} from '@vina/opencode-plugin';

import { findProfile } from '../db/repositories/profile.js';
import { findCvById, listCvs } from '../db/repositories/cvs.js';
import { listAnswers } from '../db/repositories/profile-answers.js';
import {
  countJobs,
  findJobById,
  insertJob,
  listJobs,
  updateJobScore,
  updateJobStatus,
} from '../db/repositories/jobs.js';
import {
  findActiveApplicationForJob,
  findApplicationById,
  markApplicationApplied,
  setApplicationTailored,
  updateApplicationFormState,
  updateApplicationStatus,
} from '../db/repositories/applications.js';
import { appendEvent, listEvents } from '../db/repositories/application-events.js';
import {
  recordAttempt,
  recordSuccess,
  recordFailure,
} from '../db/repositories/apply-rate-limit.js';
import { insertAlert } from '../db/repositories/alerts.js';
import { findSiteById } from '../db/repositories/sites.js';
import { getOrInitSearchPreferences } from '../db/repositories/search-preferences.js';
import { checkEasyApplyGate, dayBucketFromIso } from '../services/easy-apply-gate.js';
import {
  searchGoogleJobs,
  type GoogleJobsListing,
  type GoogleJobsSearchInput,
} from '../services/serpapi-service.js';
import { getDecryptedSerpApiKey } from '../services/settings-service.js';
import { createManualApplyToolKit } from '../orchestrator/tools/index.js';
import type { EventBus } from '../events/bus.js';

export type EasyApplyRunOutcome = {
  outcome: 'submitted' | 'awaiting_user' | 'failed';
  reason?: string;
  events: ApplyEvent[];
};

/** Runs the real `runApply` graph for an application. Mirrors the apply handler. */
export type RunApplySeam = (applicationId: string) => Promise<EasyApplyRunOutcome>;

export interface VinaServicesDeps {
  db: DatabaseType;
  bus: EventBus;
  /** LLM factory — score/materials/easy-apply. Matches the queue handler convention. */
  buildModel: () => Promise<BaseChatModel>;
  /** Vina data directory for rendered tailored files. */
  dataDir: string;
  /** SerpAPI iterator seam. Defaults to `searchGoogleJobs` + decrypted key. */
  serpapiSearch?: (
    input: GoogleJobsSearchInput,
    opts: { apiKey: string; signal?: AbortSignal },
  ) => AsyncIterable<GoogleJobsListing>;
  /**
   * Easy Apply submit seam: runs the real `runApply` graph (the gate is
   * checked by the tool first). Defaults to wiring `runApply` to the browser
   * via `createAutoApplyToolKit` when the browser deps are supplied. Tests
   * inject a fake so no browser is required.
   */
  runApply?: RunApplySeam;
  browserManager?: BrowserManagerHandle;
  adapters?: Record<string, SiteAdapter>;
  manualApplyToolKit?: ManualApplyToolKit;
  promptLoader?: PromptLoader;
  skillRegistry?: SkillRegistry;
}

function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Default Easy Apply runner: the single `runApply` graph, wired to the browser. */
function defaultRunApplySeam(deps: VinaServicesDeps): RunApplySeam {
  return async (applicationId: string): Promise<EasyApplyRunOutcome> => {
    const { createAutoApplyToolKit } = await import('../orchestrator/tools/auto-apply.js');
    if (!deps.browserManager || !deps.adapters || !deps.manualApplyToolKit) {
      throw new ConflictError(
        'Easy Apply is not wired: supply browserManager/adapters/manualApplyToolKit or a runApply seam',
      );
    }
    const app = findApplicationById(deps.db, applicationId);
    if (!app) throw new NotFoundError(`Application ${applicationId} not found`);
    const model = await deps.buildModel();
    const toolKit = createAutoApplyToolKit({
      db: deps.db,
      browserManager: deps.browserManager,
      adapters: deps.adapters,
      manualApplyToolKit: deps.manualApplyToolKit,
      buildModel: deps.buildModel,
    });
    const result: ApplyResult = await runApply(
      { applicationId: app.id, jobId: app.job_id, cvId: app.cv_id },
      model as unknown as StructuredApplyDecider,
      toolKit,
      {
        ...(deps.promptLoader ? { promptLoader: deps.promptLoader } : {}),
        ...(deps.skillRegistry ? { skillRegistry: deps.skillRegistry } : {}),
      } satisfies RunApplyOptions,
    );
    return { outcome: result.outcome, reason: result.reason, events: result.events };
  };
}

/**
 * Maps a graph event step name to an `application_events.kind`, mirroring the
 * `apply` queue handler's `EVENT_KIND_MAP` so the per-field audit timeline is
 * persisted identically for agent-initiated applies.
 */
const APPLY_EVENT_KIND_MAP: Partial<Record<string, ApplicationEventKind>> = {
  started: 'apply_started',
  tailored: 'cv_tailored',
  field_filled: 'field_filled',
  field_unresolved: 'field_unknown',
  submit_failed: 'failed',
  submitted: 'submitted',
};

/** Persists the graph's event stream into `application_events`. */
function recordApplyEvents(
  db: DatabaseType,
  applicationId: string,
  events: ApplyEvent[],
): void {
  for (const event of events) {
    const kind = APPLY_EVENT_KIND_MAP[event.step];
    if (!kind) continue;
    appendEvent(db, {
      application_id: applicationId,
      kind,
      ...(event.detail ? { payload: event.detail } : {}),
    });
  }
}

/**
 * Legal status transitions for `vina_application_status`. A transition to the
 * same status is an idempotent no-op; terminal statuses admit no transitions.
 * Mirrors the manual-apply terminal transition (`markApplicationApplied` is
 * used for `applied_manually` to stamp `applied_manually_at`).
 */
const ALLOWED_TRANSITIONS: Record<ApplicationStatus, ReadonlySet<ApplicationStatus>> = {
  queued: new Set(['applying', 'failed', 'skipped']),
  applying: new Set(['awaiting_user', 'awaiting_approval', 'submitted', 'failed', 'skipped']),
  awaiting_user: new Set(['queued', 'applying', 'failed', 'skipped']),
  awaiting_approval: new Set(['queued', 'applying', 'failed', 'skipped']),
  ready_for_manual_apply: new Set(['applied_manually', 'skipped', 'failed']),
  submitted: new Set(),
  applied_manually: new Set(),
  failed: new Set(),
  skipped: new Set(),
};

/**
 * Event kind written alongside a status transition. There is no dedicated
 * `status_changed` kind in `APPLICATION_EVENT_KINDS`, so the closest kind is
 * used; the actual target status is always carried in the event payload.
 */
const STATUS_EVENT_KIND: Record<ApplicationStatus, ApplicationEventKind> = {
  queued: 'resumed',
  applying: 'apply_started',
  awaiting_user: 'resumed',
  awaiting_approval: 'resumed',
  ready_for_manual_apply: 'ready_for_manual_apply',
  submitted: 'submitted',
  applied_manually: 'applied_manually',
  failed: 'failed',
  skipped: 'failed',
};

export function createVinaServices(deps: VinaServicesDeps): VinaServices {
  const db = deps.db;
  const runApplySeam = deps.runApply ?? defaultRunApplySeam(deps);

  async function profileRead(_input: ProfileReadInput): Promise<ProfileReadOutput> {
    const profile = findProfile(db);
    const cvs = listCvs(db).map((c) => ({ id: c.id, label: c.label, is_default: c.is_default }));
    const answers = listAnswers(db).map((a) => ({ key: a.key, label: a.label, value: a.value }));
    return {
      profile: profile
        ? {
            full_name: profile.full_name,
            email: profile.email,
            phone: profile.phone,
            location: profile.location,
            linkedin_url: profile.linkedin_url,
            website_url: profile.website_url,
            bio: profile.bio,
          }
        : null,
      cvs,
      answers,
    };
  }

  async function searchJobs(input: SearchJobsInput): Promise<SearchJobsOutput> {
    const added: SearchJobsOutput['jobs'] = [];

    for (const source of input.sources) {
      const site = findSiteById(db, source);
      if (!site) throw new ValidationError(`Unknown source: ${source}`);

      if (site.kind === 'browser') {
        // Browser-kind search stays on the existing search handler until the
        // agent sweep is re-routed in stage 2. The tool contract accepts the
        // source id; the api-kind path below is the no-browser implementation.
        throw new ValidationError(
          `Browser-kind source '${source}' is not yet available via the vina tool; use the existing search`,
        );
      }

      // api-kind: Google Jobs via SerpAPI. No browser.
      const apiKey = getDecryptedSerpApiKey(db);
      if (!apiKey) throw new ValidationError('SerpAPI key not configured');

      const searchImpl = deps.serpapiSearch ?? searchGoogleJobs;
      const searchInput: GoogleJobsSearchInput = {
        keywords: input.query,
        location: input.location,
        num: input.limit,
        date_posted: 'week',
      };

      let remaining = input.limit ?? 100;
      for await (const listing of searchImpl(searchInput, { apiKey })) {
        if (remaining <= 0) break;
        const job = insertJob(db, {
          site_id: source,
          external_id: listing.external_id,
          url: listing.apply_url,
          external_apply_url: listing.apply_url,
          apply_method: 'manual',
          original_source: listing.via,
          title: listing.title,
          company: listing.company,
          location: listing.location,
          description: listing.description,
          salary_text: listing.salary_text,
        });
        added.push({
          id: job.id,
          title: job.title,
          company: job.company,
          location: job.location,
          apply_method: job.apply_method,
        });
        remaining -= 1;
      }
    }

    if (added.length > 0) {
      deps.bus.emit('jobs:updated', { ids: added.map((j) => j.id) });
    }
    return { added: added.length, jobs: added };
  }

  async function jobsList(input: JobsListInput): Promise<JobsListOutput> {
    const jobs = listJobs(db, { status: input.status, limit: input.limit ?? 100 });
    const total = countJobs(db, { status: input.status });
    return {
      total,
      jobs: jobs.map((j) => ({
        id: j.id,
        title: j.title,
        company: j.company,
        location: j.location,
        status: j.status,
        match_score: j.match_score,
        apply_method: j.apply_method,
        posted_at: j.posted_at,
      })),
    };
  }

  async function jobGet(input: JobGetInput): Promise<JobGetOutput> {
    const job = findJobById(db, input.jobId);
    if (!job) throw new NotFoundError(`Job ${input.jobId} not found`);
    const application = findActiveApplicationForJob(db, job.id);
    return {
      job: {
        id: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        description: job.description,
        salary_text: job.salary_text,
        posted_at: job.posted_at,
        url: job.url,
        external_apply_url: job.external_apply_url,
        apply_method: job.apply_method,
        match_score: job.match_score,
        match_justification: job.match_justification,
        status: job.status,
      },
      application: application
        ? { id: application.id, status: application.status, apply_method: application.apply_method }
        : null,
    };
  }

  async function scoreJob(input: ScoreJobInput): Promise<ScoreJobOutput> {
    const job = findJobById(db, input.jobId);
    if (!job) throw new NotFoundError(`Job ${input.jobId} not found`);
    const profile = findProfile(db);
    if (!profile) throw new ConflictError('Profile not configured — cannot score');

    const prefs = getOrInitSearchPreferences(db);
    const defaultCv = listCvs(db).find((c) => c.is_default) ?? null;
    const model = await deps.buildModel();
    const result = await runScoreJob(
      {
        job: {
          title: job.title,
          company: job.company,
          location: job.location,
          description: job.description,
        },
        profile: { full_name: profile.full_name, bio: profile.bio },
        cv_text: defaultCv?.extracted_text ?? null,
        prefs: {
          description: prefs.description,
          keywords: prefs.keywords,
          locations: prefs.locations,
          work_models: prefs.work_models,
          seniority: prefs.seniority,
          excluded_companies: prefs.excluded_companies,
        },
      },
      model as unknown as StructuredScorer,
    );

    db.transaction(() => {
      updateJobScore(db, job.id, result.score, result.justification);
      const fresh = findJobById(db, job.id);
      if (fresh?.status === 'new') updateJobStatus(db, job.id, 'scored');
    })();

    deps.bus.emit('jobs:updated', { ids: [job.id] });
    deps.bus.emit('score:job_completed', { job_id: job.id, score: result.score });
    const fresh = findJobById(db, job.id)!;
    return {
      job_id: job.id,
      score: result.score,
      justification: result.justification,
      status: fresh.status,
    };
  }

  async function materialsSave(input: MaterialsSaveInput): Promise<MaterialsSaveOutput> {
    const app = findApplicationById(db, input.applicationId);
    if (!app) throw new NotFoundError(`Application ${input.applicationId} not found`);
    const job = findJobById(db, app.job_id);
    if (!job) throw new NotFoundError(`Job ${app.job_id} not found`);
    const cv = findCvById(db, app.cv_id);
    if (!cv) throw new ConflictError('Application has no CV — upload one in Profile first');
    const profile = findProfile(db);
    if (!profile) throw new ConflictError('Profile not configured — cannot tailor');

    const contentHash = hashString(
      JSON.stringify({
        cvMarkdown: input.cvMarkdown,
        coverLetterMarkdown: input.coverLetterMarkdown ?? null,
        formAnswers: input.formAnswers ?? null,
      }),
    );

    // Idempotency on (applicationId, contentHash): a retried session must not
    // re-render identical materials.
    const prior = listEvents(db, app.id).find(
      (e) => e.kind === 'cv_tailored' && e.payload?.includes(contentHash),
    );
    if (prior && app.tailored_cv_path) {
      return {
        application_id: app.id,
        status: app.status,
        tailored_cv_path: app.tailored_cv_path,
        tailored_cover_letter_path: app.tailored_cover_letter_path,
      };
    }

    const model = await deps.buildModel();
    const toolKit = createManualApplyToolKit({ dataDir: deps.dataDir });
    const result = await runPrepareManualApply(
      {
        application_id: app.id,
        job: { title: job.title, company: job.company, description: job.description },
        cv: { text: input.cvMarkdown },
        cover_letter_template: input.coverLetterMarkdown
          ? { text: input.coverLetterMarkdown }
          : null,
        user_profile: {
          full_name: profile.full_name,
          email: profile.email,
          bio: profile.bio,
        },
      },
      model as unknown as StructuredScorer,
      toolKit,
      deps.promptLoader ? { promptLoader: deps.promptLoader } : {},
    );

    db.transaction(() => {
      setApplicationTailored(db, app.id, {
        tailored_cv_path: result.tailored_cv_path,
        tailored_cover_letter_path: result.tailored_cover_letter_path,
        tailored_cv_pdf_path: result.tailored_cv_pdf_path,
        tailored_cover_letter_pdf_path: result.tailored_cover_letter_pdf_path,
        tailored_at: new Date().toISOString(),
        new_status: 'ready_for_manual_apply',
      });
      if (input.formAnswers) {
        updateApplicationFormState(db, app.id, JSON.stringify(input.formAnswers));
      }
      appendEvent(db, {
        application_id: app.id,
        kind: 'cv_tailored',
        payload: { contentHash, source: 'agent', job_id: job.id },
      });
    })();

    deps.bus.emit('application:ready_for_manual_apply', {
      application_id: app.id,
      job_id: job.id,
      external_apply_url: job.external_apply_url ?? job.url,
      tailored_cv_path: result.tailored_cv_path,
      tailored_cover_letter_path: result.tailored_cover_letter_path,
    });
    deps.bus.emit('jobs:updated', { ids: [job.id] });

    return {
      application_id: app.id,
      status: 'ready_for_manual_apply',
      tailored_cv_path: result.tailored_cv_path,
      tailored_cover_letter_path: result.tailored_cover_letter_path,
    };
  }

  async function reviewRecord(input: ReviewRecordInput): Promise<ReviewRecordOutput> {
    const app = findApplicationById(db, input.applicationId);
    if (!app) throw new NotFoundError(`Application ${input.applicationId} not found`);

    const kind: ApplicationEventKind = input.verdict === 'approve' ? 'cv_approved' : 'cv_rejected';
    const contentHash = hashString(
      JSON.stringify({ round: input.round, findings: input.findings ?? [] }),
    );

    // Idempotent on (applicationId, round): a retried review must not write a
    // second verdict row for the same round.
    const prior = listEvents(db, app.id).find((e) => {
      if (e.kind !== 'cv_approved' && e.kind !== 'cv_rejected') return false;
      if (!e.payload) return false;
      try {
        return (JSON.parse(e.payload) as { round?: number }).round === input.round;
      } catch {
        return false;
      }
    });
    if (prior) {
      return {
        application_id: app.id,
        event_id: prior.id,
        verdict: prior.kind as 'cv_approved' | 'cv_rejected',
      };
    }

    const payload = {
      round: input.round,
      findings: input.findings ?? [],
      contentHash,
    };

    const event = db.transaction(() => {
      return appendEvent(db, { application_id: app.id, kind, payload });
    })();

    deps.bus.emit('application:event', {
      application_id: app.id,
      kind,
      payload: JSON.stringify(payload),
    });

    return { application_id: app.id, event_id: event.id, verdict: kind };
  }

  async function applicationStatus(
    input: ApplicationStatusInput,
  ): Promise<ApplicationStatusOutput> {
    const app = findApplicationById(db, input.applicationId);
    if (!app) throw new NotFoundError(`Application ${input.applicationId} not found`);

    if (input.status === app.status) {
      return { application_id: app.id, status: app.status };
    }

    const allowed = ALLOWED_TRANSITIONS[app.status];
    if (!allowed.has(input.status)) {
      throw new ConflictError(
        `Illegal transition: '${app.status}' -> '${input.status}' for application ${app.id}`,
      );
    }

    const kind = STATUS_EVENT_KIND[input.status];
    db.transaction(() => {
      if (input.status === 'applied_manually') {
        markApplicationApplied(db, app.id);
      } else {
        updateApplicationStatus(db, app.id, input.status, {
          failure_reason: input.status === 'failed' ? (input.reason ?? null) : undefined,
        });
      }
      appendEvent(db, {
        application_id: app.id,
        kind,
        payload: { status: input.status, ...(input.reason ? { reason: input.reason } : {}) },
      });
    })();

    deps.bus.emit('application:updated', { id: app.id, status: input.status });
    deps.bus.emit('jobs:updated', { ids: [app.job_id] });

    return { application_id: app.id, status: input.status };
  }

  async function easyApply(input: EasyApplyInput): Promise<EasyApplyOutput> {
    const app = findApplicationById(db, input.applicationId);
    if (!app) throw new NotFoundError(`Application ${input.applicationId} not found`);
    const job = findJobById(db, app.job_id);
    if (!job) throw new NotFoundError(`Job ${app.job_id} not found`);
    if (job.apply_method !== 'auto') {
      throw new ConflictError(`Job ${job.id} is apply_method=manual — cannot Easy Apply`);
    }

    // ADR-023: the single gate runs before any browser/model spend.
    const nowIso = new Date().toISOString();
    const today = dayBucketFromIso(nowIso);
    const gate = checkEasyApplyGate(db, {
      jobId: job.id,
      nowIso,
      today,
      excludeApplicationId: app.id,
    });
    if (gate.decision === 'block') {
      throw new ConflictError(`Easy Apply blocked by gate: ${gate.reason}`);
    }

    // Record the attempt regardless of dry_run vs allow. Dry-run still
    // consumes a velocity slot so the throttle is visible to the user.
    recordAttempt(db, nowIso, today);

    if (gate.decision === 'dry_run') {
      // Mirror the apply handler: no runApply, no submit. The application
      // pauses for the user; only `allow` may proceed to submit.
      db.transaction(() => {
        updateApplicationStatus(db, app.id, 'awaiting_user', {
          failure_reason: 'dry_run',
        });
        appendEvent(db, {
          application_id: app.id,
          kind: 'resumed',
          payload: { status: 'awaiting_user', reason: 'dry_run' },
        });
      })();
      deps.bus.emit('application:updated', { id: app.id, status: 'awaiting_user' });
      deps.bus.emit('jobs:updated', { ids: [job.id] });
      return { application_id: app.id, outcome: 'awaiting_user', reason: 'dry_run' };
    }

    const runResult = await runApplySeam(app.id);
    recordApplyEvents(db, app.id, runResult.events);

    if (runResult.outcome === 'submitted') {
      db.transaction(() => {
        updateApplicationStatus(db, app.id, 'submitted', {
          submitted_at: new Date().toISOString(),
        });
        // The job row mirrors the terminal application state so the Jobs
        // worklist drops it and the Applied tab picks it up.
        updateJobStatus(db, job.id, 'submitted');
        appendEvent(db, { application_id: app.id, kind: 'submitted' });
      })();
      const completedAt = new Date().toISOString();
      recordSuccess(db, completedAt, dayBucketFromIso(completedAt));
      deps.bus.emit('application:updated', { id: app.id, status: 'submitted' });
    } else if (runResult.outcome === 'failed') {
      db.transaction(() => {
        updateApplicationStatus(db, app.id, 'failed', {
          failure_reason: runResult.reason ?? null,
        });
        appendEvent(db, {
          application_id: app.id,
          kind: 'failed',
          payload: runResult.reason ? { reason: runResult.reason } : undefined,
        });
      })();
      recordFailure(db);
    } else {
      db.transaction(() => {
        updateApplicationStatus(db, app.id, 'awaiting_user', {
          failure_reason: runResult.reason ?? null,
        });
        appendEvent(db, {
          application_id: app.id,
          kind: 'resumed',
          payload: {
            status: 'awaiting_user',
            ...(runResult.reason ? { reason: runResult.reason } : {}),
          },
        });
      })();
      deps.bus.emit('application:updated', { id: app.id, status: 'awaiting_user' });
    }
    deps.bus.emit('jobs:updated', { ids: [job.id] });

    return {
      application_id: app.id,
      outcome: runResult.outcome,
      ...(runResult.reason ? { reason: runResult.reason } : {}),
    };
  }

  async function askUser(input: AskUserInput): Promise<AskUserOutput> {
    const questions = input.questions;
    if (questions.length === 0) {
      throw new ValidationError('ask_user requires at least one question');
    }
    const alert = insertAlert(db, {
      kind: 'general',
      severity: 'action_required',
      title: `Answer ${questions.length} question${questions.length === 1 ? '' : 's'} to continue`,
      description: questions.map((q, i) => `${i + 1}. ${q.label}`).join('\n'),
      payload: { questions },
    });
    deps.bus.emit('alert:created', alert);
    return { status: 'pending', alert_id: alert.id, question_count: questions.length };
  }

  return {
    profileRead,
    searchJobs,
    jobsList,
    jobGet,
    scoreJob,
    materialsSave,
    reviewRecord,
    applicationStatus,
    easyApply,
    askUser,
  };
}
