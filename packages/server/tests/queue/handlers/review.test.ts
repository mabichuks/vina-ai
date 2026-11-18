import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { freshTestDb } from '../../db/helpers.js';
import { createEventBus } from '../../../src/events/bus.js';
import { insertProfile } from '../../../src/db/repositories/profile.js';
import { insertCv } from '../../../src/db/repositories/cvs.js';
import { insertJob } from '../../../src/db/repositories/jobs.js';
import { insertApplication } from '../../../src/db/repositories/applications.js';
import { appendEvent, listEvents } from '../../../src/db/repositories/application-events.js';
import { createReviewHandler } from '../../../src/queue/handlers/review.js';
import type { SessionDriver, SessionRunResult } from '../../../src/opencode/session-driver.js';

let db: DatabaseType;
let dataDir: string;
beforeEach(() => {
  db = freshTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-review-'));
  insertProfile(db, { full_name: 'Pat Doe', email: 'p@x.com' });
});
afterEach(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function seedApp(): string {
  const cv = insertCv(db, {
    label: 'main',
    original_filename: 'cv.pdf',
    mime_type: 'application/pdf',
    file_path: '/tmp/cv.pdf',
    extracted_text: 'FooCo 2020-2024.',
    is_default: true,
  });
  const job = insertJob(db, {
    site_id: 'linkedin',
    external_id: 'j1',
    url: 'https://linkedin.com/jobs/view/j1',
    apply_method: 'manual',
    title: 'Senior TS Engineer',
    company: 'Acme',
    description: 'TS APIs.',
    external_apply_url: 'https://greenhouse.io/apply/j1',
  });
  const app = insertApplication(db, {
    job_id: job.id,
    cv_id: cv.id,
    apply_method: 'manual',
    status: 'ready_for_manual_apply',
  });
  return app.id;
}

/** Driver that records the agent and simulates the verdict being recorded. */
function recordingDriver(): SessionDriver & { agent: string | null; prompt: string | null } {
  const state = { agent: null as string | null, prompt: null as string | null };
  return {
    get agent() {
      return state.agent;
    },
    get prompt() {
      return state.prompt;
    },
    async run(input): Promise<SessionRunResult> {
      state.agent = input.agent;
      state.prompt = input.prompt;
      // The agent records a verdict for round 1 (as vina_review_record would).
      appendEvent(db, {
        application_id: extractAppId(input.prompt),
        kind: 'cv_approved',
        payload: { round: 1, findings: [], contentHash: 'h' },
      });
      return { sessionId: 'sess-review', outcome: { reason: 'idle' } };
    },
  };
}

function extractAppId(prompt: string): string {
  const m = prompt.match(/applicationId: (\S+)/);
  return m ? m[1]! : '';
}

describe('review handler', () => {
  it('spawns a fresh vina-review session and verifies a verdict', async () => {
    const appId = seedApp();
    const bus = createEventBus();
    const driver = recordingDriver();

    const handler = createReviewHandler({ db, bus, sessionDriver: driver });
    await handler({ application_id: appId });

    expect(driver.agent).toBe('vina-review');
    expect(driver.prompt).toContain(appId);
    expect(driver.prompt).not.toContain('vina-materials');

    const verdicts = listEvents(db, appId).filter(
      (e) => e.kind === 'cv_approved' || e.kind === 'cv_rejected',
    );
    expect(verdicts).toHaveLength(1);
  });

  it('never hands the reviewer the writer session id', async () => {
    const appId = seedApp();
    const bus = createEventBus();
    let capturedPrompt = '';
    const driver: SessionDriver = {
      run: async (input) => {
        capturedPrompt = input.prompt;
        appendEvent(db, { application_id: appId, kind: 'cv_rejected', payload: { round: 1 } });
        return { sessionId: 'sess-review', outcome: { reason: 'idle' } };
      },
    };

    await createReviewHandler({ db, bus, sessionDriver: driver })({ application_id: appId });
    expect(capturedPrompt).not.toMatch(/sess-/);
    expect(capturedPrompt).not.toMatch(/writer/);
  });

  it('throws when the session ends without recording a verdict', async () => {
    const appId = seedApp();
    const bus = createEventBus();
    const driver: SessionDriver = {
      run: vi.fn(async () => ({ sessionId: 'sess-review', outcome: { reason: 'idle' } })),
    };

    const handler = createReviewHandler({ db, bus, sessionDriver: driver });
    await expect(handler({ application_id: appId })).rejects.toThrow(/verdict/);
  });

  it('is idempotent: a verdict already recorded skips a second session', async () => {
    const appId = seedApp();
    appendEvent(db, { application_id: appId, kind: 'cv_approved', payload: { round: 1 } });
    const bus = createEventBus();
    const driver: SessionDriver = {
      run: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    };

    const handler = createReviewHandler({ db, bus, sessionDriver: driver });
    await handler({ application_id: appId });
    expect(driver.run).not.toHaveBeenCalled();
  });

  it('throws NotFoundError for an unknown application', async () => {
    const bus = createEventBus();
    const driver = recordingDriver();
    const handler = createReviewHandler({ db, bus, sessionDriver: driver });
    await expect(handler({ application_id: 'missing' })).rejects.toThrow(/not found/i);
  });
});
