import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auth, buildTestApp, type TestAppHandle } from './helpers.js';
import { buildMultipart } from './multipart.js';

let h: TestAppHandle;

beforeEach(async () => {
  h = await buildTestApp();
});
afterEach(() => h.cleanup());

function smallPdf(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\n' +
      'xref\n0 3\n0000000000 65535 f\n0000000009 00000 n\n0000000054 00000 n\n' +
      'trailer<</Size 3/Root 1 0 R>>\nstartxref\n100\n%%EOF\n',
  );
}

describe('cover-letter routes', () => {
  it('POST upload + GET list round-trips', async () => {
    const { body, contentType } = buildMultipart([
      { name: 'label', value: 'Default' },
      {
        name: 'file',
        filename: 'cover.pdf',
        contentType: 'application/pdf',
        body: smallPdf(),
      },
    ]);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/cover-letters',
      headers: { ...auth(h.token), 'content-type': contentType },
      payload: body,
    });
    expect(created.statusCode).toBe(200);

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/cover-letters',
      headers: auth(h.token),
    });
    expect((list.json() as unknown[]).length).toBe(1);
  });
});
