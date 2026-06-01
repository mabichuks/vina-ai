import { describe, expect, it } from 'vitest';
import {
  detectCaptcha,
  type DetectablePage,
} from '../../src/detect/captcha.js';

function fakePage(matchingSelectors: Record<string, number>): DetectablePage {
  return {
    locator(selector: string) {
      return {
        async count() {
          return matchingSelectors[selector] ?? 0;
        },
      };
    },
  };
}

describe('detectCaptcha', () => {
  it('returns present=false when no widget selectors match', async () => {
    const result = await detectCaptcha(fakePage({}));
    expect(result).toEqual({ present: false });
  });

  it('detects reCAPTCHA via the Google iframe', async () => {
    const result = await detectCaptcha(
      fakePage({ 'iframe[src*="google.com/recaptcha"]': 1 }),
    );
    expect(result.present).toBe(true);
    expect(result.kind).toBe('recaptcha');
    expect(result.selector).toBe('iframe[src*="google.com/recaptcha"]');
  });

  it('detects reCAPTCHA via the .g-recaptcha wrapper', async () => {
    const result = await detectCaptcha(fakePage({ '.g-recaptcha': 1 }));
    expect(result.kind).toBe('recaptcha');
  });

  it('detects hCaptcha via its iframe host', async () => {
    const result = await detectCaptcha(
      fakePage({ 'iframe[src*="hcaptcha.com"]': 1 }),
    );
    expect(result.kind).toBe('hcaptcha');
  });

  it('detects Cloudflare Turnstile', async () => {
    const result = await detectCaptcha(
      fakePage({ 'iframe[src*="challenges.cloudflare.com"]': 1 }),
    );
    expect(result.kind).toBe('turnstile');
  });

  it('returns the first match when multiple widgets are present', async () => {
    // Order in the heuristic list is recaptcha → hcaptcha → turnstile.
    const result = await detectCaptcha(
      fakePage({
        '.h-captcha': 1,
        '.g-recaptcha': 1,
      }),
    );
    expect(result.kind).toBe('recaptcha');
  });
});
