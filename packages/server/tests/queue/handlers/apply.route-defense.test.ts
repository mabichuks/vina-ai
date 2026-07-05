import { describe, expect, it, beforeEach } from 'vitest';
import type { BrowserManagerHandle } from '@vina/automation';
import { ConflictError } from '@vina/shared';
import { createApplyHandler } from '../../../src/queue/handlers/apply.js';
import {
  insertApplication,
  findApplicationById,
} from '../../../src/db/repositories/applications.js';
import { insertJob } from '../../../src/db/repositories/jobs.js';
import { insertCv } from '../../../src/db/repositories/cvs.js';
import { listAlerts } from '../../../src/db/repositories/alerts.js';
import { freshTestDb } from '../../db/helpers.js';
import { createEventBus } from '../../../src/events/bus.js';

let db: ReturnType<typeof freshTestDb>;

beforeEach(() => {
  db = freshTestDb();
});

const STUB_MANAGER: BrowserManagerHandle = {
  async getContext() {
    throw new Error('STUB_MANAGER should not be invoked in route-defense tests');
  },
  async closeContext() {
    /* noop */
  },
  async closeAll() {
    /* noop */
  },
};

describe('apply handler — route defence', () => {
  it('refuses to run a manual-apply job, marks it failed, and raises an alert', async () => {
    const cv = insertCv(db, {
      label: 'Default',
      original_filename: 'cv.docx',
      mime_type:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      file_path: '/tmp/cv.docx',
      extracted_text: 'Some CV text',
      is_default: true,
    });
    const job = insertJob(db, {
      site_id: 'linkedin',
      external_id: 'job-1',
      url: 'https://www.linkedin.com/jobs/view/1',
      apply_method: 'manual',
      title: 'Senior Engineer',
      company: 'Acme',
      description: 'A role',
    });
    const app = insertApplication(db, {
      job_id: job.id,
      cv_id: cv.id,
      apply_method: 'manual',
    });

    const handler = createApplyHandler({
      db,
      bus: createEventBus(),
      browserManager: STUB_MANAGER,
      adapters: {},
      manualApplyToolKit: {
        async saveTailoredCv() {
          return { path: '/dev/null' };
        },
        async saveTailoredCoverLetter() {
          return { path: '/dev/null' };
        },
        async saveTailoredCvPdf() {
          return { path: '/dev/null' };
        },
        async saveTailoredCoverLetterPdf() {
          return { path: '/dev/null' };
        },
      },
      buildModel: () => {
        throw new Error('buildModel should not be invoked in route-defense path');
      },
    });

    await expect(handler({ application_id: app.id })).rejects.toBeInstanceOf(
      ConflictError,
    );

    const after = findApplicationById(db, app.id);
    expect(after?.status).toBe('failed');
    expect(after?.failure_reason).toBe('apply_method_mismatch');

    const alerts = listAlerts(db);
    expect(alerts.some((a) => a.kind === 'apply_failed')).toBe(true);
  });
});
