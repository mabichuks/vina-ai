import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchCdpSession, type CdpSessionHandle } from '../../src/browser/cdp.js';
import { takeSnapshot } from '../../src/snapshot/snapshot.js';
import { findByLabel, walkTree } from '../../src/snapshot/refs.js';

let dataDir: string;
let handle: CdpSessionHandle | null = null;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-snap-test-'));
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(dataDir, { recursive: true, force: true });
});

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><title>Apply</title></head>
  <body>
    <form>
      <label>First name <input type="text" name="first_name" required></label>
      <label>Email <input type="email" name="email" required></label>
      <label>Country
        <select name="country">
          <option>United Kingdom</option>
          <option>France</option>
          <option>Germany</option>
        </select>
      </label>
      <button type="submit">Submit</button>
    </form>
  </body>
</html>`;

describe('takeSnapshot (integration, real Chromium via managed CDP)', () => {
  it('captures form accessibility tree with refs', async () => {
    handle = await launchCdpSession({ siteId: 'snapshot-int', dataDir });
    const page = await handle.context.newPage();
    await page.setContent(FIXTURE_HTML);

    const tree = await takeSnapshot(page);
    const firstName = findByLabel(tree, 'textbox', 'First name');
    const email = findByLabel(tree, 'textbox', 'Email');
    const submit = findByLabel(tree, 'button', 'Submit');

    expect(firstName).not.toBeNull();
    expect(firstName?.required).toBe(true);
    expect(email).not.toBeNull();
    expect(submit).not.toBeNull();

    // Refs are non-empty strings and unique within the tree.
    const refs = new Set<string>();
    walkTree(tree, (n) => {
      expect(n.ref).toMatch(/^r\d+$/);
      refs.add(n.ref);
    });
    let total = 0;
    walkTree(tree, () => total++);
    expect(refs.size).toBe(total);
  }, 30_000);
});
