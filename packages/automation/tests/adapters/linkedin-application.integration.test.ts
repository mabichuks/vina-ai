import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchCdpSession, type CdpSessionHandle } from '../../src/browser/cdp.js';
import { linkedInAdapter } from '../../src/adapters/linkedin/index.js';
import type { RawListing } from '../../src/adapters/types.js';

let dataDir: string;
let handle: CdpSessionHandle | null = null;
let fixtureDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-apply-int-'));
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-apply-fix-'));
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

const SINGLE_STEP_FIXTURE = `<!doctype html>
<html lang="en">
  <head><title>Easy Apply</title></head>
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
        const fields = new FormData(e.target);
        const ok = ['first_name','last_name','email'].every((k) => fields.get(k));
        if (ok) {
          document.body.innerHTML =
            '<h2 data-vina-fixture="apply-success">Application submitted</h2>';
        }
      });
    </script>
  </body>
</html>`;

const MULTI_STEP_FIXTURE = `<!doctype html>
<html lang="en">
  <head><title>Easy Apply (multi-step)</title></head>
  <body>
    <form data-vina-fixture="easy-apply">
      <fieldset id="step-1">
        <label>First name <input type="text" name="first_name" required></label>
        <label>Last name <input type="text" name="last_name" required></label>
        <button type="button" id="continue-btn">Continue</button>
      </fieldset>
      <fieldset id="step-2" hidden>
        <label>Email <input type="email" name="email" required></label>
        <label>Resume <input type="file" name="resume" data-vina-field="cv"></label>
        <button type="submit">Submit application</button>
      </fieldset>
    </form>
    <script>
      document.getElementById('continue-btn').addEventListener('click', () => {
        document.getElementById('step-1').setAttribute('hidden', '');
        document.getElementById('step-2').removeAttribute('hidden');
      });
      document.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        document.body.innerHTML =
          '<h2 data-vina-fixture="apply-success">Application submitted</h2>';
      });
    </script>
  </body>
</html>`;

async function writeFixtureCv(): Promise<string> {
  const cvPath = path.join(fixtureDir, 'cv.txt');
  await fs.writeFile(cvPath, 'Fake CV bytes', 'utf8');
  return cvPath;
}

function listing(url: string): RawListing {
  return {
    externalId: 'fixture-1',
    title: 'Senior Engineer',
    company: 'Acme',
    location: 'Remote',
    url,
    snippet: null,
    postedAt: null,
    cardApplyMethod: 'auto',
  };
}

describe('linkedInAdapter — single-step Easy Apply (integration)', () => {
  it('inspects, fills, uploads CV, and submits successfully', async () => {
    handle = await launchCdpSession({ siteId: 'apply-int', dataDir });
    const page = await handle.context.newPage();
    await page.setContent(SINGLE_STEP_FIXTURE);
    const cvPath = await writeFixtureCv();

    const session = await linkedInAdapter.startApplication(page, listing('about:blank'));
    expect(session.formId).toBeTruthy();

    const fields = await linkedInAdapter.inspectFields(session);
    expect(fields.some((f) => f.canonicalKey === 'first_name')).toBe(true);
    expect(fields.some((f) => f.canonicalKey === 'last_name')).toBe(true);
    expect(fields.some((f) => f.canonicalKey === 'email')).toBe(true);
    expect(fields.some((f) => f.kind === 'file')).toBe(true);

    for (const f of fields) {
      if (f.canonicalKey === 'first_name') {
        await linkedInAdapter.fillField(session, f.ref, 'Ada');
      } else if (f.canonicalKey === 'last_name') {
        await linkedInAdapter.fillField(session, f.ref, 'Lovelace');
      } else if (f.canonicalKey === 'email') {
        await linkedInAdapter.fillField(session, f.ref, 'ada@example.com');
      }
    }

    await linkedInAdapter.uploadCv(session, cvPath);

    const advance = await linkedInAdapter.advanceStep(session);
    expect(advance.advanced).toBe(false);

    const submit = await linkedInAdapter.submit(session);
    expect(submit.ok).toBe(true);
  }, 30_000);

  it('takeScreenshot returns base64 PNG bytes', async () => {
    handle = await launchCdpSession({ siteId: 'screenshot', dataDir });
    const page = await handle.context.newPage();
    await page.setContent(SINGLE_STEP_FIXTURE);
    const session = await linkedInAdapter.startApplication(page, listing('about:blank'));
    const shot = await linkedInAdapter.takeScreenshot(session);
    expect(shot.pngBase64.length).toBeGreaterThan(100);
    // PNG signature in base64 starts with iVBORw0KGgo
    expect(shot.pngBase64.startsWith('iVBORw0KGgo')).toBe(true);
  }, 30_000);
});

describe('linkedInAdapter — multi-step Easy Apply (integration)', () => {
  it('advanceStep clicks Continue and exposes step 2 fields', async () => {
    handle = await launchCdpSession({ siteId: 'apply-multi', dataDir });
    const page = await handle.context.newPage();
    await page.setContent(MULTI_STEP_FIXTURE);

    const session = await linkedInAdapter.startApplication(page, listing('about:blank'));
    const step1Fields = await linkedInAdapter.inspectFields(session);
    expect(step1Fields.some((f) => f.canonicalKey === 'first_name')).toBe(true);
    // Email should NOT be visible yet (hidden step).
    expect(step1Fields.some((f) => f.canonicalKey === 'email')).toBe(false);

    for (const f of step1Fields) {
      if (f.canonicalKey === 'first_name')
        await linkedInAdapter.fillField(session, f.ref, 'Ada');
      else if (f.canonicalKey === 'last_name')
        await linkedInAdapter.fillField(session, f.ref, 'Lovelace');
    }

    const advance = await linkedInAdapter.advanceStep(session);
    expect(advance.advanced).toBe(true);

    const step2Fields = await linkedInAdapter.inspectFields(session);
    expect(step2Fields.some((f) => f.canonicalKey === 'email')).toBe(true);
  }, 30_000);
});

describe('linkedInAdapter.submit — captcha / session-expired escalation', () => {
  it('returns reason=captcha when a reCAPTCHA widget is on the page pre-submit', async () => {
    handle = await launchCdpSession({ siteId: 'captcha-submit', dataDir });
    const page = await handle.context.newPage();
    await page.setContent(`<!doctype html>
      <html><body>
        <form data-vina-fixture="easy-apply">
          <div class="g-recaptcha" data-sitekey="x"></div>
          <button type="submit">Submit application</button>
        </form>
      </body></html>`);
    const session = await linkedInAdapter.startApplication(page, listing('about:blank'));
    const result = await linkedInAdapter.submit(session);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('captcha');
    }
  }, 30_000);

  it('returns reason=other when there is no submit button', async () => {
    handle = await launchCdpSession({ siteId: 'no-submit', dataDir });
    const page = await handle.context.newPage();
    await page.setContent(`<!doctype html>
      <html><body><form data-vina-fixture="easy-apply"><p>No submit here</p></form></body></html>`);
    const session = await linkedInAdapter.startApplication(page, listing('about:blank'));
    const result = await linkedInAdapter.submit(session);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('other');
    }
  }, 30_000);
});
