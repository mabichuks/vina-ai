import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchCdpSession, type CdpSessionHandle } from '../../src/browser/cdp.js';
import { detectCaptchaOnPage } from '../../src/detect/captcha.js';

let dataDir: string;
let handle: CdpSessionHandle | null = null;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-captcha-int-'));
});
afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('detectCaptchaOnPage (integration, real Chromium)', () => {
  it('returns present=false on a plain HTML page', async () => {
    handle = await launchCdpSession({ siteId: 'captcha-none', dataDir });
    const page = await handle.context.newPage();
    await page.setContent('<html><body><h1>Hello</h1></body></html>');
    const result = await detectCaptchaOnPage(page);
    expect(result.present).toBe(false);
  }, 30_000);

  it('detects reCAPTCHA when the .g-recaptcha wrapper is present', async () => {
    handle = await launchCdpSession({ siteId: 'captcha-recap', dataDir });
    const page = await handle.context.newPage();
    await page.setContent(
      '<html><body><div class="g-recaptcha" data-sitekey="x"></div></body></html>',
    );
    const result = await detectCaptchaOnPage(page);
    expect(result.present).toBe(true);
    expect(result.kind).toBe('recaptcha');
  }, 30_000);

  it('detects Turnstile via the iframe host pattern', async () => {
    handle = await launchCdpSession({ siteId: 'captcha-cf', dataDir });
    const page = await handle.context.newPage();
    await page.setContent(
      '<html><body><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x"></iframe></body></html>',
    );
    const result = await detectCaptchaOnPage(page);
    expect(result.present).toBe(true);
    expect(result.kind).toBe('turnstile');
  }, 30_000);
});
