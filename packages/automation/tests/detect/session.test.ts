import { describe, expect, it } from 'vitest';
import {
  isSessionExpired,
  type SessionDetectablePage,
  type SessionExpiredHeuristics,
} from '../../src/detect/session.js';

function fakePage(opts: {
  url: string;
  selectorCounts?: Record<string, number>;
  html?: string;
}): SessionDetectablePage {
  return {
    url() {
      return opts.url;
    },
    locator(selector: string) {
      return {
        async count() {
          return opts.selectorCounts?.[selector] ?? 0;
        },
      };
    },
    async content() {
      return opts.html ?? '<html></html>';
    },
  };
}

const LINKEDIN_HEURISTICS: SessionExpiredHeuristics = {
  loginPathPatterns: [/^\/login/, /^\/uas\/login/],
  selectors: ['#sign-in-form'],
  textPatterns: ['session has expired', 'sign in to continue'],
};

describe('isSessionExpired', () => {
  it('returns false on a normal authenticated page', async () => {
    const page = fakePage({ url: 'https://www.linkedin.com/feed/' });
    expect(await isSessionExpired(page, LINKEDIN_HEURISTICS)).toBe(false);
  });

  it('matches a login path pattern', async () => {
    const page = fakePage({ url: 'https://www.linkedin.com/login' });
    expect(await isSessionExpired(page, LINKEDIN_HEURISTICS)).toBe(true);
  });

  it('matches a less-common login path via the second pattern', async () => {
    const page = fakePage({ url: 'https://www.linkedin.com/uas/login?session_redirect=…' });
    expect(await isSessionExpired(page, LINKEDIN_HEURISTICS)).toBe(true);
  });

  it('matches via a selector even when the URL looks fine', async () => {
    const page = fakePage({
      url: 'https://www.linkedin.com/feed/',
      selectorCounts: { '#sign-in-form': 1 },
    });
    expect(await isSessionExpired(page, LINKEDIN_HEURISTICS)).toBe(true);
  });

  it('matches via a text pattern in the page HTML (case-insensitive)', async () => {
    const page = fakePage({
      url: 'https://www.linkedin.com/feed/',
      html: '<html><body><h1>Your Session Has Expired</h1></body></html>',
    });
    expect(await isSessionExpired(page, LINKEDIN_HEURISTICS)).toBe(true);
  });

  it('handles a non-URL page.url() value without throwing', async () => {
    const page = fakePage({ url: 'about:blank' });
    expect(await isSessionExpired(page, LINKEDIN_HEURISTICS)).toBe(false);
  });

  it('returns false when no heuristics are configured', async () => {
    const page = fakePage({ url: 'https://www.linkedin.com/login' });
    expect(await isSessionExpired(page, {})).toBe(false);
  });

  it('short-circuits to true on URL match without reading content()', async () => {
    let contentCalled = false;
    const page: SessionDetectablePage = {
      url: () => 'https://www.linkedin.com/login',
      locator: () => ({ async count() { return 0; } }),
      content: async () => {
        contentCalled = true;
        return '';
      },
    };
    expect(await isSessionExpired(page, LINKEDIN_HEURISTICS)).toBe(true);
    expect(contentCalled).toBe(false);
  });
});
