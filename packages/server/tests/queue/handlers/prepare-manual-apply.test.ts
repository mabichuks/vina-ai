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
import {
  insertApplication,
  findApplicationById,
  setApplicationTailored,
} from '../../../src/db/repositories/applications.js';
import { listAlerts } from '../../../src/db/repositories/alerts.js';
import { listPending } from '../../../src/db/repositories/task-queue.js';
import { createPrepareManualApplyHandler } from '../../../src/queue/handlers/prepare-manual-apply.js';
import type { SessionDriver, SessionRunResult } from '../../../src/opencode/session-driver.js';

let db: DatabaseType;
let dataDir: string;
beforeEach(() => {
  db = freshTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-pma-'));
  insertProfile(db, { full_name: 'Pat Doe', email: 'p@x.com' });
});
afterEach(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function seedManualJobAndApp(): { cvId: string; jobId: string; appId: string } {
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
    status: 'queued',
  });
  return { cvId: cv.id, jobId: job.id, appId: app.id };
}

/** Fake session driver that simulates the agent reaching ready state. */
function readyDriver(appId: string): SessionDriver & { agent: string | null; prompt: string | null } {
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
      // Simulate the agent calling vina_materials_save.
      setApplicationTailored(db, appId, {
        tailored_cv_path: `${dataDir}/files/tailored/${appId}.docx`,
        tailored_cover_letter_path: null,
        tailored_cv_pdf_path: `${dataDir}/files/tailored-pdf/${appId}.pdf`,
        tailored_cover_letter_pdf_path: null,
        tailored_at: new Date().toISOString(),
        new_status: 'ready_for_manual_apply',
      });
      return { sessionId: 'sess-1', outcome: { reason: 'idle' } };
    },
  };
}

describe('prepare_manual_apply handler (session-driven)', () => {
  it('spawns a vina-materials session, verifies ready, alerts, and enqueues review', async () => {
    const { appId } = seedManualJobAndApp();
    const bus = createEventBus();
    const driver = readyDriver(appId);

    const handler = createPrepareManualApplyHandler({ db, bus, sessionDriver: driver });
    await handler({ application_id: appId });

    expect(driver.agent).toBe('vina-materials');
    expect(driver.prompt).toContain(appId);

    const after = findApplicationById(db, appId)!;
    expect(after.status).toBe('ready_for_manual_apply');

    const alerts = listAlerts(db, { kind: 'ready_for_manual_apply', application_id: appId });
    expect(alerts).toHaveLength(1);

    const pending = listPending(db);
    expect(pending.find((t) => t.kind === 'review' && t.payload.includes(appId))).toBeDefined();
  });

  it('throws when the session ends without reaching ready_for_manual_apply', async () => {
    const { appId } = seedManualJobAndApp();
    const bus = createEventBus();
    const driver: SessionDriver = {
      run: vi.fn(async () => ({ sessionId: 'sess-1', outcome: { reason: 'idle' } })),
    };

    const handler = createPrepareManualApplyHandler({ db, bus, sessionDriver: driver });
    await expect(handler({ application_id: appId })).rejects.toThrow(/ready_for_manual_apply/);
    expect(findApplicationById(db, appId)?.status).toBe('queued');
  });

  it('is idempotent: a retried run on an already-ready app does not duplicate the alert', async () => {
    const { appId } = seedManualJobAndApp();
    const bus = createEventBus();
    const driver = readyDriver(appId);
    const handler = createPrepareManualApplyHandler({ db, bus, sessionDriver: driver });

    await handler({ application_id: appId });
    const alertsAfterFirst = listAlerts(db, { kind: 'ready_for_manual_apply', application_id: appId });

    // Second run: app is already ready → fast-path, no second session.
    const noopDriver: SessionDriver = {
      run: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    };
    const handler2 = createPrepareManualApplyHandler({ db, bus, sessionDriver: noopDriver });
    await handler2({ application_id: appId });

    expect(noopDriver.run).not.toHaveBeenCalled();
    expect(
      listAlerts(db, { kind: 'ready_for_manual_apply', application_id: appId }),
    ).toHaveLength(alertsAfterFirst.length);
  });

  it('fails fast with ConflictError if the application has no CV', async () => {
    const job = insertJob(db, {
      site_id: 'linkedin',
      external_id: 'j2',
      url: 'https://linkedin.com/x',
      apply_method: 'manual',
      title: 't',
      company: 'c',
      description: 'd',
    });
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO applications (id, job_id, cv_id, apply_method, status, started_at)
       VALUES ('a-orphan', ?, 'cv-missing', 'manual', 'queued', ?)`,
    ).run(job.id, new Date().toISOString());
    db.pragma('foreign_keys = ON');

    const bus = createEventBus();
    const driver = readyDriver('a-orphan');
    const handler = createPrepareManualApplyHandler({ db, bus, sessionDriver: driver });
    await expect(handler({ application_id: 'a-orphan' })).rejects.toThrow(/cv/i);
  });
});
