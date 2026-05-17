import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { freshTestDb } from '../../db/helpers.js';
import { createEventBus } from '../../../src/events/bus.js';
import { insertProfile } from '../../../src/db/repositories/profile.js';
import { insertCv } from '../../../src/db/repositories/cvs.js';
import { insertCoverLetter } from '../../../src/db/repositories/cover-letters.js';
import { insertJob } from '../../../src/db/repositories/jobs.js';
import {
  insertApplication,
  findApplicationById,
} from '../../../src/db/repositories/applications.js';
import { listAlerts } from '../../../src/db/repositories/alerts.js';
import { createManualApplyToolKit } from '../../../src/orchestrator/tools/index.js';
import { createPrepareManualApplyHandler } from '../../../src/queue/handlers/prepare-manual-apply.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

let db: DatabaseType;
let dataDir: string;
beforeEach(() => {
  db = freshTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-pma-'));
  insertProfile(db, { full_name: 'Pat Doe', email: 'p@x.com' });
});
afterEach(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
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

function fakeModel(outputs: unknown[]): BaseChatModel {
  let i = 0;
  return {
    withStructuredOutput: () => ({
      invoke: vi.fn(async () => outputs[i++]),
    }),
  } as unknown as BaseChatModel;
}

describe('prepare_manual_apply handler', () => {
  it('happy path: tailors CV (no cover letter), persists paths, transitions to ready_for_manual_apply, inserts alert, emits events', async () => {
    const { appId, jobId } = seedManualJobAndApp();
    const bus = createEventBus();
    const readyEvents: unknown[] = [];
    bus.on('application:ready_for_manual_apply', (p) => readyEvents.push(p));

    const handler = createPrepareManualApplyHandler({
      db,
      bus,
      buildModel: async () => fakeModel([{ summary: 's', bullets: [], skills: [] }]),
      toolKit: createManualApplyToolKit({ dataDir }),
    });

    await handler({ application_id: appId });

    const after = findApplicationById(db, appId)!;
    expect(after.status).toBe('ready_for_manual_apply');
    expect(after.tailored_cv_path).toMatch(/files\/tailored\/.*\.docx$/);
    expect(after.tailored_cover_letter_path).toBeNull();
    expect(after.tailored_at).toBeTruthy();

    const alerts = listAlerts(db, { kind: 'ready_for_manual_apply' });
    expect(alerts).toHaveLength(1);
    expect(JSON.parse(alerts[0]!.payload!)).toMatchObject({
      application_id: appId,
      job_id: jobId,
      external_apply_url: 'https://greenhouse.io/apply/j1',
    });

    expect(readyEvents).toHaveLength(1);
  });

  it('tailors cover letter when one is uploaded', async () => {
    const cl = insertCoverLetter(db, {
      label: 'main',
      original_filename: 'cl.pdf',
      mime_type: 'application/pdf',
      file_path: '/tmp/cl.pdf',
      extracted_text: 'Dear Sir/Madam,',
      is_default: true,
    });
    const { appId } = seedManualJobAndApp();
    db.prepare(`UPDATE applications SET cover_letter_id = ? WHERE id = ?`).run(cl.id, appId);

    const handler = createPrepareManualApplyHandler({
      db,
      bus: createEventBus(),
      buildModel: async () =>
        fakeModel([
          { summary: 's', bullets: [], skills: [] },
          { greeting: 'Dear', body_paragraphs: ['p'], closing: 'Sincerely' },
        ]),
      toolKit: createManualApplyToolKit({ dataDir }),
    });
    await handler({ application_id: appId });

    const after = findApplicationById(db, appId)!;
    expect(after.tailored_cover_letter_path).toMatch(/tailored-cover-letters\/.*\.docx$/);
  });

  it('throws on LLM failure so the worker retries (status stays queued)', async () => {
    const { appId } = seedManualJobAndApp();
    const handler = createPrepareManualApplyHandler({
      db,
      bus: createEventBus(),
      buildModel: async () =>
        ({
          withStructuredOutput: () => ({
            invoke: async () => {
              throw new Error('5xx');
            },
          }),
        }) as unknown as BaseChatModel,
      toolKit: createManualApplyToolKit({ dataDir }),
    });

    await expect(handler({ application_id: appId })).rejects.toThrow();
    expect(findApplicationById(db, appId)?.status).toBe('queued');
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
    // Force a dangling cv_id. The FK is normally enforced (init.sql) so this
    // shape can't happen via the public API, but we need to verify the
    // handler's defensive `if (!cv)` guard still fires if the row ever ends
    // up corrupt.
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO applications (id, job_id, cv_id, apply_method, status, started_at)
       VALUES ('a-orphan', ?, 'cv-missing', 'manual', 'queued', ?)`,
    ).run(job.id, new Date().toISOString());
    db.pragma('foreign_keys = ON');

    const handler = createPrepareManualApplyHandler({
      db,
      bus: createEventBus(),
      buildModel: async () => fakeModel([]),
      toolKit: createManualApplyToolKit({ dataDir }),
    });
    await expect(handler({ application_id: 'a-orphan' })).rejects.toThrow(/cv/i);
  });
});
