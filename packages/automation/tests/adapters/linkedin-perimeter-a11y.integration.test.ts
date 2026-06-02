import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchCdpSession, type CdpSessionHandle } from '../../src/browser/cdp.js';
import { linkedInAdapter } from '../../src/adapters/linkedin/index.js';
import type { RawListing } from '../../src/adapters/types.js';

let dataDir: string;
let handle: CdpSessionHandle | null = null;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-perim-a11y-'));
});
afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(dataDir, { recursive: true, force: true });
});

function listing(): RawListing {
  return {
    externalId: 'fix',
    title: 'Engineer',
    company: 'Acme',
    location: 'Remote',
    url: 'about:blank',
    snippet: null,
    postedAt: null,
    cardApplyMethod: 'auto',
  };
}

/**
 * Fixture that deliberately uses a button class no Vina selector knows
 * about (`.totally-renamed-2026-class`) and no `data-vina-fixture`.
 * Inputs have no name/id either. Only the accessible name survives.
 */
const RENAMED_FORM = `<!doctype html>
<html lang="en"><head><title>Renamed Easy Apply</title></head>
<body>
  <form data-vina-fixture="easy-apply">
    <section class="totally-renamed-2026-container">
      <label>First name <input type="text"></label>
      <label>Email <input type="email"></label>
      <button class="totally-renamed-2026-class" type="button" id="continue-btn">Continue</button>
      <button class="totally-renamed-2026-class" type="button" id="submit-btn" hidden>Submit application</button>
    </section>
  </form>
  <script>
    document.getElementById('continue-btn').addEventListener('click', () => {
      document.getElementById('continue-btn').setAttribute('hidden', '');
      document.getElementById('submit-btn').removeAttribute('hidden');
    });
    document.getElementById('submit-btn').addEventListener('click', () => {
      document.body.innerHTML =
        '<h2 data-vina-fixture="apply-success">Application submitted</h2>';
    });
  </script>
</body></html>`;

describe('LinkedIn perimeter actions — selector drift survived via a11y fallback', () => {
  it('advanceStep finds Continue by accessible name when selectors miss', async () => {
    handle = await launchCdpSession({ siteId: 'a11y-advance', dataDir });
    const page = await handle.context.newPage();
    await page.setContent(RENAMED_FORM);
    const session = await linkedInAdapter.startApplication(page, listing());

    const advance = await linkedInAdapter.advanceStep(session);
    expect(advance.advanced).toBe(true);
    // After clicking Continue, the Submit button is now visible.
    expect(await page.locator('#submit-btn').isVisible()).toBe(true);
  }, 30_000);

  it('submit finds Submit by accessible name when selectors miss', async () => {
    handle = await launchCdpSession({ siteId: 'a11y-submit', dataDir });
    const page = await handle.context.newPage();
    await page.setContent(RENAMED_FORM);
    const session = await linkedInAdapter.startApplication(page, listing());
    // Advance first so the submit button becomes visible.
    await linkedInAdapter.advanceStep(session);

    const submit = await linkedInAdapter.submit(session);
    expect(submit.ok).toBe(true);
  }, 30_000);
});

describe('uploadCv — pre-attached resume', () => {
  const EXISTING_RESUME_FORM = `<!doctype html>
<html><body>
  <form data-vina-fixture="easy-apply">
    <label>First name <input type="text" name="first_name"></label>
    <div data-vina-fixture="existing-resume">Resume.pdf · 24 KB</div>
    <button type="button">Replace</button>
    <button type="submit">Submit application</button>
  </form>
</body></html>`;

  it('no-ops when a resume is already attached on the LinkedIn profile', async () => {
    handle = await launchCdpSession({ siteId: 'existing-cv', dataDir });
    const page = await handle.context.newPage();
    await page.setContent(EXISTING_RESUME_FORM);
    const session = await linkedInAdapter.startApplication(page, listing());

    // The path is a real-looking string but we never expect it to be read —
    // uploadCv should detect the pre-attached resume and short-circuit.
    const fakeCvPath = path.join(dataDir, 'tailored-but-not-used.docx');
    await fs.writeFile(fakeCvPath, 'unused', 'utf8');

    // No throw — even though there's no `input[type=file]:visible`, the
    // pre-attached resume widget tells uploadCv to keep what's there.
    await expect(linkedInAdapter.uploadCv(session, fakeCvPath)).resolves.toBeUndefined();
  }, 30_000);
});
