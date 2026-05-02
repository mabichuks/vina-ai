import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertJob } from '../../src/db/repositories/jobs.js';
import { insertApplication } from '../../src/db/repositories/applications.js';
import { auth, buildTestApp, type TestAppHandle } from './helpers.js';
import { buildMultipart } from './multipart.js';

let h: TestAppHandle;

beforeEach(async () => {
  h = await buildTestApp();
});
afterEach(() => h.cleanup());

// A sample PDF Buffer that pdf-parse can ingest without throwing.
function smallPdf(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\n' +
      'xref\n0 3\n0000000000 65535 f\n0000000009 00000 n\n0000000054 00000 n\n' +
      'trailer<</Size 3/Root 1 0 R>>\nstartxref\n100\n%%EOF\n',
  );
}

describe('cv routes', () => {
  it('POST upload writes to disk with sanitised filename and DB row carries it', async () => {
    const { body, contentType } = buildMultipart([
      { name: 'label', value: 'Senior Backend' },
      {
        name: 'file',
        // Path separator + spaces should be stripped by sanitiseFilename.
        filename: '../weird path/cv with spaces.pdf',
        contentType: 'application/pdf',
        body: smallPdf(),
      },
    ]);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/cvs',
      headers: { ...auth(h.token), 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const row = res.json() as { id: string; original_filename: string; file_path: string };
    expect(row.original_filename).not.toContain('/');
    expect(row.original_filename).not.toContain('..');
    expect(row.original_filename).not.toContain(' ');

    const onDisk = path.join(h.config.filesDir, row.file_path);
    expect(fs.existsSync(onDisk)).toBe(true);
  });

  it('DELETE with a referencing application returns 409 cv_in_use', async () => {
    const { body, contentType } = buildMultipart([
      { name: 'label', value: 'A' },
      {
        name: 'file',
        filename: 'cv.pdf',
        contentType: 'application/pdf',
        body: smallPdf(),
      },
    ]);
    const cv = (
      await h.app.inject({
        method: 'POST',
        url: '/api/cvs',
        headers: { ...auth(h.token), 'content-type': contentType },
        payload: body,
      })
    ).json() as { id: string };

    // Manually seed an application that references this CV.
    const job = insertJob(h.db, {
      site_id: 'linkedin',
      external_id: 'x',
      url: 'https://x',
      apply_method: 'auto',
      title: 't',
      company: 'c',
      description: 'd',
    });
    insertApplication(h.db, { job_id: job.id, cv_id: cv.id, apply_method: 'auto' });

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/cvs/${cv.id}`,
      headers: auth(h.token),
    });
    expect(del.statusCode).toBe(409);
    expect(del.json()).toMatchObject({ code: 'cv_in_use' });
  });
});
