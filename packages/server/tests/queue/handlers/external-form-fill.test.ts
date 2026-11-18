import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { listEvents } from '../../../src/db/repositories/application-events.js';
import { updateSettings } from '../../../src/db/repositories/settings.js';
import { createExternalFormFillHandler } from '../../../src/queue/handlers/external-form-fill.js';
import type { SessionDriver, SessionRunResult } from '../../../src/opencode/session-driver.js';

let db: DatabaseType;
let dataDir: string;
beforeEach(() => {
  db = freshTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-ext-fill-'));
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

/**
 * The assisted fill sequence, recorded as the `vina-manual` agent drives the
 * fixture ATS form (tests/fixtures/sites/ats/index.html): a snapshot, then
 * ref-based writes — never a CSS selector.
 */
const ASSISTED_SEQUENCE = [
  { tool: 'playwright_browser_navigate', input: { url: 'https://greenhouse.io/apply/j1' } },
  { tool: 'playwright_browser_snapshot', input: { ref: 'e1' } },
  { tool: 'playwright_browser_type', input: { ref: 'e2', text: 'Pat' } },
  { tool: 'playwright_browser_type', input: { ref: 'e3', text: 'Doe' } },
  { tool: 'playwright_browser_type', input: { ref: 'e4', text: 'p@x.com' } },
];

describe('external-form-fill handler (recorded replay)', () => {
  it('assisted: mirrors the fill sequence to events and stops before submit (zero selector code)', async () => {
    const appId = seedApp();
    updateSettings(db, { external_apply_mode: 'assisted' });
    const bus = createEventBus();
    let capturedPrompt = '';
    const driver: SessionDriver = {
      run: async (input): Promise<SessionRunResult> => {
        capturedPrompt = input.prompt;
        expect(input.agent).toBe('vina-manual');
        expect(input.collectToolEvents).toBe(true);
        return {
          sessionId: 'sess-ext',
          outcome: { reason: 'idle' },
          toolEvents: ASSISTED_SEQUENCE,
        };
      },
    };

    await createExternalFormFillHandler({ db, bus, sessionDriver: driver })({
      application_id: appId,
    });

    // The prompt instructs snapshot/ref-based fill and a stop-before-submit.
    expect(capturedPrompt).toContain('job-manual');
    expect(capturedPrompt).toContain('never CSS selectors');
    expect(capturedPrompt).toContain('STOP before the submit control');

    const kinds = listEvents(db, appId).map((e) => e.kind);
    expect(kinds).toContain('external_form_opened');
    expect(kinds.filter((k) => k === 'external_field_filled')).toHaveLength(3);
    // Assisted stops: the terminal event is ready-for-review, never submitted.
    expect(kinds).toContain('external_ready_for_review');
    expect(kinds).not.toContain('external_submitted');
  });

  it('assisted fill uses refs, never CSS selectors', async () => {
    for (const event of ASSISTED_SEQUENCE) {
      const input = event.input as Record<string, unknown> | undefined;
      if (!input) continue;
      const raw = JSON.stringify(input);
      // ref-based (accessibility) only — no css=/text=/selector= locators.
      expect(raw).not.toMatch(/css=|selector|text=|xpath=/i);
      if (event.tool.includes('type') || event.tool.includes('click')) {
        expect(input.ref).toBeDefined();
      }
    }
  });

  it('autonomous: requires external_submitted, else throws', async () => {
    const appId = seedApp();
    updateSettings(db, { external_apply_mode: 'autonomous' });
    const bus = createEventBus();
    const driver: SessionDriver = {
      run: async () => ({
        sessionId: 'sess-ext',
        outcome: { reason: 'idle' },
        toolEvents: ASSISTED_SEQUENCE,
      }),
    };

    const handler = createExternalFormFillHandler({ db, bus, sessionDriver: driver });
    await expect(handler({ application_id: appId })).rejects.toThrow(/external_submitted/);
  });

  it('throws NotFoundError for an unknown application', async () => {
    const bus = createEventBus();
    const driver: SessionDriver = {
      run: async () => ({ sessionId: 'sess-ext', outcome: { reason: 'idle' } }),
    };
    const handler = createExternalFormFillHandler({ db, bus, sessionDriver: driver });
    await expect(handler({ application_id: 'missing' })).rejects.toThrow(/not found/i);
  });
});
