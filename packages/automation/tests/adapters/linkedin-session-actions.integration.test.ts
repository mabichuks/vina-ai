import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchCdpSession, type CdpSessionHandle } from '../../src/browser/cdp.js';
import { linkedInAdapter } from '../../src/adapters/linkedin/index.js';
import type { ApplicationSession } from '../../src/adapters/adapter.js';

let dataDir: string;
let handle: CdpSessionHandle | null = null;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-linkedin-act-'));
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const FORM_HTML = `<!doctype html>
<html lang="en">
  <head><title>Apply</title></head>
  <body>
    <form id="f">
      <label>First name <input type="text" name="first_name"></label>
      <label>Subscribe <input type="checkbox" name="subscribe"></label>
      <label>Country
        <select name="country">
          <option value="UK">United Kingdom</option>
          <option value="FR">France</option>
        </select>
      </label>
      <button type="button" id="b">Continue</button>
    </form>
    <script>
      document.getElementById('b').addEventListener('click', () => {
        document.title = 'clicked';
      });
    </script>
  </body>
</html>`;

describe('linkedInAdapter snapshot + act (integration, real Chromium)', () => {
  it('snapshot captures the form and act(click) fires on a button ref', async () => {
    handle = await launchCdpSession({ siteId: 'lk-act-click', dataDir });
    const page = await handle.context.newPage();
    await page.setContent(FORM_HTML);
    const session: ApplicationSession = { page, formId: 'integration' };

    const tree = await linkedInAdapter.snapshot(session);
    expect(session.latestSnapshot).toBe(tree);

    const findButton = (node: typeof tree.root): typeof tree.root | null => {
      if (node.role === 'button' && node.name === 'Continue') return node;
      for (const c of node.children ?? []) {
        const f = findButton(c);
        if (f) return f;
      }
      return null;
    };
    const button = findButton(tree.root);
    expect(button).not.toBeNull();

    await linkedInAdapter.act(session, button!.ref, 'click');
    expect(await page.title()).toBe('clicked');
  }, 30_000);

  it('act(check) toggles a checkbox by ref', async () => {
    handle = await launchCdpSession({ siteId: 'lk-act-check', dataDir });
    const page = await handle.context.newPage();
    await page.setContent(FORM_HTML);
    const session: ApplicationSession = { page, formId: 'integration' };

    const tree = await linkedInAdapter.snapshot(session);

    const findCheckbox = (node: typeof tree.root): typeof tree.root | null => {
      if (node.role === 'checkbox') return node;
      for (const c of node.children ?? []) {
        const f = findCheckbox(c);
        if (f) return f;
      }
      return null;
    };
    const checkbox = findCheckbox(tree.root);
    expect(checkbox).not.toBeNull();

    await linkedInAdapter.act(session, checkbox!.ref, 'check');
    expect(await page.locator('input[name="subscribe"]').isChecked()).toBe(true);
  }, 30_000);

  it('act(select) chooses a combobox option by value', async () => {
    handle = await launchCdpSession({ siteId: 'lk-act-select', dataDir });
    const page = await handle.context.newPage();
    await page.setContent(FORM_HTML);
    const session: ApplicationSession = { page, formId: 'integration' };

    const tree = await linkedInAdapter.snapshot(session);

    const findCombobox = (node: typeof tree.root): typeof tree.root | null => {
      if (node.role === 'combobox') return node;
      for (const c of node.children ?? []) {
        const f = findCombobox(c);
        if (f) return f;
      }
      return null;
    };
    const combobox = findCombobox(tree.root);
    expect(combobox).not.toBeNull();

    await linkedInAdapter.act(session, combobox!.ref, 'select', 'FR');
    expect(await page.locator('select[name="country"]').inputValue()).toBe('FR');
  }, 30_000);
});
