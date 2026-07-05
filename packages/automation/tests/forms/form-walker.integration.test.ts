import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchCdpSession, type CdpSessionHandle } from '../../src/browser/cdp.js';
import { takeSnapshot } from '../../src/snapshot/snapshot.js';
import { walkForm } from '../../src/forms/form-walker.js';

let dataDir: string;
let handle: CdpSessionHandle | null = null;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-walker-int-'));
});
afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const APPLY_HTML = `<!doctype html>
<html lang="en">
  <head><title>Easy Apply</title></head>
  <body>
    <form>
      <label>First name <input type="text" name="fn" required></label>
      <label>Last name <input type="text" name="ln" required></label>
      <label>Email <input type="email" name="em" required></label>
      <label>Mobile number <input type="tel" name="ph"></label>
      <label>LinkedIn URL <input type="url" name="li"></label>
      <label>Country
        <select name="country">
          <option>United Kingdom</option>
          <option>France</option>
        </select>
      </label>
      <label>Subscribe <input type="checkbox" name="sub"></label>
      <button type="submit">Submit</button>
    </form>
  </body>
</html>`;

describe('walkForm (integration, real Chromium snapshot)', () => {
  it('classifies a real Easy-Apply-style form deterministically', async () => {
    handle = await launchCdpSession({ siteId: 'walker-int', dataDir });
    const page = await handle.context.newPage();
    await page.setContent(APPLY_HTML);

    const tree = await takeSnapshot(page);
    const fields = walkForm(tree);

    const byCanonical = new Map(
      fields.filter((f) => f.canonicalKey).map((f) => [f.canonicalKey!, f]),
    );

    expect(byCanonical.get('first_name')).toMatchObject({
      kind: 'text',
      required: true,
    });
    expect(byCanonical.get('last_name')).toMatchObject({ kind: 'text' });
    expect(byCanonical.get('email')).toMatchObject({
      kind: 'email',
      required: true,
    });
    expect(byCanonical.get('phone')).toMatchObject({ kind: 'phone' });
    expect(byCanonical.get('linkedin_url')).toMatchObject({ kind: 'url' });
    expect(byCanonical.get('location_country')).toMatchObject({
      kind: 'select',
      options: ['United Kingdom', 'France'],
    });

    const subscribe = fields.find((f) => f.label === 'Subscribe');
    expect(subscribe).toMatchObject({ kind: 'checkbox' });

    // The submit button is interactive but not a form field — walker skips it.
    const submit = fields.find((f) => f.label === 'Submit');
    expect(submit).toBeUndefined();
  }, 30_000);
});
