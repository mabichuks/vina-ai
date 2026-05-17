import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createEventBus } from '../../src/events/bus.js';
import { insertProfile } from '../../src/db/repositories/profile.js';
import { insertCv } from '../../src/db/repositories/cvs.js';
import {
  insertJob,
  updateJobScore,
  updateJobStatus,
} from '../../src/db/repositories/jobs.js';
import { findApplicationById } from '../../src/db/repositories/applications.js';
import { listAlerts } from '../../src/db/repositories/alerts.js';
import { createPrepareManualApplyHandler } from '../../src/queue/handlers/prepare-manual-apply.js';
import { createManualApplyToolKit } from '../../src/orchestrator/tools/index.js';
import { buildTestApp, type TestAppHandle } from '../http/helpers.js';

let h: TestAppHandle;

beforeEach(async () => {
  h = await buildTestApp();
  insertProfile(h.db, { full_name: 'Pat Doe', email: 'p@x.com' });
  insertCv(h.db, {
    label: 'main',
    original_filename: 'cv.pdf',
    mime_type: 'application/pdf',
    file_path: '/tmp/cv.pdf',
    extracted_text: 'FooCo 2020-2024.',
    is_default: true,
  });
});
afterEach(async () => {
  await h.cleanup();
});

function deterministicModel(): BaseChatModel {
  const outputs = [
    { summary: 'sum', bullets: [{ section: 'FooCo', bullet: 'b1' }], skills: ['ts'] },
  ];
  let i = 0;
  return {
    withStructuredOutput: () => ({
      invoke: async () => outputs[i++ % outputs.length],
    }),
  } as unknown as BaseChatModel;
}

describe('manual-apply pipeline (end-to-end)', () => {
  it('scored manual job → prepare → ready → mark applied → alert resolved', async () => {
    const job = insertJob(h.db, {
      site_id: 'linkedin',
      external_id: 'e2e-1',
      url: 'https://linkedin.com/x',
      apply_method: 'manual',
      title: 'Senior TS Engineer',
      company: 'Acme',
      description: 'TS APIs.',
      external_apply_url: 'https://greenhouse.io/apply/x',
    });
    updateJobScore(h.db, job.id, 82, 'great fit');
    updateJobStatus(h.db, job.id, 'scored');

    const headers = { authorization: `Bearer ${h.token}` };
    const prepareRes = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/prepare`,
      headers,
    });
    expect(prepareRes.statusCode).toBe(202);
    const { application_id } = prepareRes.json() as { application_id: string };

    // Drive the queue handler directly (the worker would do this in prod).
    // Use the same dataDir as the buildTestApp's config so the routes serving
    // the DOCX can find the file later.
    const handler = createPrepareManualApplyHandler({
      db: h.db,
      bus: createEventBus(),
      buildModel: async () => deterministicModel(),
      toolKit: createManualApplyToolKit({ dataDir: h.config.dataDir }),
    });
    await handler({ application_id });

    const app = findApplicationById(h.db, application_id)!;
    expect(app.status).toBe('ready_for_manual_apply');
    expect(app.tailored_cv_path).toBeTruthy();
    expect(fs.existsSync(app.tailored_cv_path!)).toBe(true);
    expect(fs.readFileSync(app.tailored_cv_path!).subarray(0, 2).toString()).toBe('PK');

    const alerts = listAlerts(h.db, { kind: 'ready_for_manual_apply' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.status).toBe('open');

    // Stream the tailored CV via the HTTP route.
    const dlRes = await h.app.inject({
      method: 'GET',
      url: `/api/applications/${application_id}/tailored-cv`,
      headers,
    });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers['content-disposition']).toMatch(/attachment/);

    // Mark applied → status flips + alert resolves.
    const markRes = await h.app.inject({
      method: 'POST',
      url: `/api/applications/${application_id}/mark-applied`,
      headers,
      payload: { notes: 'via greenhouse' },
    });
    expect(markRes.statusCode).toBe(200);
    expect(markRes.json().status).toBe('applied_manually');

    const alertsAfter = listAlerts(h.db, { kind: 'ready_for_manual_apply' });
    expect(alertsAfter[0]!.status).toBe('resolved');
  }, 30_000);
});
