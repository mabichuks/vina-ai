import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBrowserManager,
  linkedInAdapter,
  type BrowserManagerHandle,
} from '@vina/automation';
import type { StructuredScorer } from '@vina/orchestrator';
import {
  insertApplication,
  findApplicationById,
} from '../../src/db/repositories/applications.js';
import { insertJob } from '../../src/db/repositories/jobs.js';
import { insertCv } from '../../src/db/repositories/cvs.js';
import { insertProfile } from '../../src/db/repositories/profile.js';
import { listAlerts, resolveAlert, findAlertById } from '../../src/db/repositories/alerts.js';
import { listEvents } from '../../src/db/repositories/application-events.js';
import { findAnswer } from '../../src/db/repositories/profile-answers.js';
import { createEventBus } from '../../src/events/bus.js';
import { createApplyHandler } from '../../src/queue/handlers/apply.js';
import { createManualApplyToolKit } from '../../src/orchestrator/tools/index.js';
import { resumeFromAlertResolution } from '../../src/services/apply-resume-service.js';
import { freshTestDb } from '../db/helpers.js';
import { startFixtureServer } from '../../../../tests/fixtures/start-server.js';
import type { FixtureServerHandle } from '../../../../tests/fixtures/start-server.js';

let db: ReturnType<typeof freshTestDb>;
let dataDir: string;
let browserManager: BrowserManagerHandle;
let fixture: FixtureServerHandle;

const KNOWN_FIELDS_FORM = `<!doctype html>
<html lang="en"><head><title>Easy Apply</title></head>
<body>
  <form data-vina-fixture="easy-apply">
    <label>First name <input type="text" name="first_name" required></label>
    <label>Last name <input type="text" name="last_name" required></label>
    <label>Email <input type="email" name="email" required></label>
    <label>Resume <input type="file" name="resume" data-vina-field="cv"></label>
    <button type="submit">Submit application</button>
  </form>
  <script>
    document.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      document.body.innerHTML =
        '<h2 data-vina-fixture="apply-success">Application submitted</h2>';
    });
  </script>
</body></html>`;

const UNKNOWN_FIELD_FORM = `<!doctype html>
<html lang="en"><head><title>Easy Apply</title></head>
<body>
  <form data-vina-fixture="easy-apply">
    <label>First name <input type="text" name="first_name" required></label>
    <label>Email <input type="email" name="email" required></label>
    <label>Highest qualification
      <input type="text" name="qualification" required>
    </label>
    <label>Resume <input type="file" name="resume" data-vina-field="cv"></label>
    <button type="submit">Submit application</button>
  </form>
  <script>
    document.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      document.body.innerHTML =
        '<h2 data-vina-fixture="apply-success">Application submitted</h2>';
    });
  </script>
</body></html>`;

beforeEach(async () => {
  db = freshTestDb();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-apply-e2e-'));
  browserManager = createBrowserManager({ dataDir });
  fixture = await startFixtureServer(async (app) => {
    app.get('/jobs/view/easy-1', async (_req, reply) => {
      reply.type('text/html').send(KNOWN_FIELDS_FORM);
    });
    app.get('/jobs/view/easy-2', async (_req, reply) => {
      reply.type('text/html').send(UNKNOWN_FIELD_FORM);
    });
  });
});

afterEach(async () => {
  await browserManager.closeAll();
  await fixture.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

/**
 * Tiny FIFO LLM stand-in. `withStructuredOutput` returns a Runnable whose
 * `invoke` pops the next scripted output. Used for both the tailor-cv
 * call and the apply-fallback call.
 */
function fifoModel(outputs: unknown[]): StructuredScorer {
  let i = 0;
  return {
    withStructuredOutput: () => ({
      async invoke() {
        if (i >= outputs.length) {
          throw new Error(`fifoModel: no more outputs (call ${i + 1})`);
        }
        return outputs[i++];
      },
    }),
  } as unknown as StructuredScorer;
}

const SUBMITTED_TAILOR_OUT = {
  summary: 'Senior engineer with broad backend experience.',
  bullets: [{ section: 'FooCo, 2020-2024', bullet: 'Built Postgres pipelines.' }],
  skills: ['TypeScript', 'Postgres'],
};

function seedShared() {
  insertProfile(db, {
    full_name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '+44 20 7946 0991',
    location: 'London, UK',
    linkedin_url: 'https://linkedin.com/in/ada',
    website_url: 'https://ada.dev',
    bio: 'Pioneer of computing.',
  });
  const cv = insertCv(db, {
    label: 'Default',
    original_filename: 'cv.docx',
    mime_type:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    file_path: path.join(dataDir, 'cv.docx'),
    extracted_text: 'FooCo 2020-2024 — built Postgres pipelines.',
    is_default: true,
  });
  // The CV file itself needs to exist on disk because uploadCv resolves it.
  return cv;
}

describe('M15 — end-to-end apply against fixture (Done-when)', () => {
  it(
    'submits a job with all-resolvable fields and writes a complete event timeline',
    async () => {
      const cv = seedShared();
      // Ensure the file uploadCv will pass to setInputFiles actually exists.
      await fs.writeFile(cv.file_path, 'fake cv bytes', 'utf8');

      const job = insertJob(db, {
        site_id: 'linkedin',
        external_id: 'easy-1',
        url: `${fixture.url}/jobs/view/easy-1`,
        apply_method: 'auto',
        title: 'Senior Engineer',
        company: 'Acme',
        description: 'Build Postgres-backed services.',
      });
      const app = insertApplication(db, {
        job_id: job.id,
        cv_id: cv.id,
        apply_method: 'auto',
        status: 'queued',
      });

      const handler = createApplyHandler({
        db,
        bus: createEventBus(),
        browserManager,
        adapters: { linkedin: linkedInAdapter },
        manualApplyToolKit: createManualApplyToolKit({ dataDir }),
        buildModel: async () => fifoModel([SUBMITTED_TAILOR_OUT]) as unknown as never,
      });

      await handler({ application_id: app.id });

      const after = findApplicationById(db, app.id);
      expect(after?.status).toBe('submitted');
      expect(after?.submitted_at).toBeTruthy();
      expect(after?.tailored_cv_path).toBeTruthy();

      const events = listEvents(db, app.id);
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain('apply_started');
      expect(kinds).toContain('cv_tailored');
      expect(kinds).toContain('field_filled');
      expect(kinds).toContain('submitted');
    },
    60_000,
  );

  it(
    'pauses on a missing field, raises an alert, and resumes after the user supplies the value',
    async () => {
      const cv = seedShared();
      await fs.writeFile(cv.file_path, 'fake cv bytes', 'utf8');

      const job = insertJob(db, {
        site_id: 'linkedin',
        external_id: 'easy-2',
        url: `${fixture.url}/jobs/view/easy-2`,
        apply_method: 'auto',
        title: 'Senior Engineer',
        company: 'Acme',
        description: 'Build things.',
      });
      const app = insertApplication(db, {
        job_id: job.id,
        cv_id: cv.id,
        apply_method: 'auto',
        status: 'queued',
      });

      const handler = createApplyHandler({
        db,
        bus: createEventBus(),
        browserManager,
        adapters: { linkedin: linkedInAdapter },
        manualApplyToolKit: createManualApplyToolKit({ dataDir }),
        // First run: tailor + LLM-says-skip on the unknown qualification field.
        // Second run (post-resume): no LLM calls at all (tailor cached, field
        // resolves from saved answer).
        buildModel: async () =>
          fifoModel([
            SUBMITTED_TAILOR_OUT,
            { action: 'skip', reason: 'profile lacks education data' },
          ]) as unknown as never,
      });

      // Pass 1: should pause with a missing_field alert.
      await handler({ application_id: app.id });

      const pausedApp = findApplicationById(db, app.id);
      expect(pausedApp?.status).toBe('awaiting_approval');

      const alerts = listAlerts(db, { status: 'open' });
      const missingField = alerts.find((a) => a.kind === 'missing_field');
      expect(missingField).toBeTruthy();
      expect(missingField?.application_id).toBe(app.id);

      // Resolve the alert with the user's answer. This is what the resume
      // service does on the production resolve path.
      const resolved = resolveAlert(db, missingField!.id, 'PhD, Mathematics');
      const outcome = resumeFromAlertResolution(db, resolved, 'PhD, Mathematics');
      expect(outcome.resumed).toBe(true);
      expect(outcome.savedAnswer).toBe(true);
      expect(findAnswer(db, 'highest_qualification')?.value).toBe(
        'PhD, Mathematics',
      );
      expect(findApplicationById(db, app.id)?.status).toBe('queued');

      // Pass 2: the saved answer satisfies the previously-unknown field; no
      // LLM calls needed (tailor is cached, field resolves from answers).
      const handler2 = createApplyHandler({
        db,
        bus: createEventBus(),
        browserManager,
        adapters: { linkedin: linkedInAdapter },
        manualApplyToolKit: createManualApplyToolKit({ dataDir }),
        buildModel: async () => fifoModel([]) as unknown as never,
      });
      await handler2({ application_id: app.id });

      const submittedApp = findApplicationById(db, app.id);
      expect(submittedApp?.status).toBe('submitted');

      const stillOpen = listAlerts(db, { status: 'open' });
      expect(stillOpen.find((a) => a.id === missingField!.id)).toBeUndefined();
      expect(findAlertById(db, missingField!.id)?.status).toBe('resolved');

      const events = listEvents(db, app.id);
      expect(events.some((e) => e.kind === 'resumed')).toBe(true);
      expect(events.some((e) => e.kind === 'submitted')).toBe(true);
    },
    90_000,
  );
});
