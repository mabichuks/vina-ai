import type { Locator, Page } from 'playwright';
import { createLogger, newId } from '@vina/shared';
import type {
  ApplicationSession,
  SubmitResult,
} from '../adapter.js';
import { walkForm } from '../../forms/form-walker.js';
import type { FormField } from '../../forms/types.js';
import { takeSnapshot, type UiRef } from '../../snapshot/snapshot.js';
import { resolveRef } from '../../snapshot/refs.js';
import { detectCaptchaOnPage } from '../../detect/captcha.js';
import { isSessionExpiredOnPage } from '../../detect/session.js';
import { findElementByGoal } from '../element-locator.js';
import type { RawListing } from '../types.js';

const log = createLogger('automation.linkedin.application');

/** Selectors for the Easy Apply button on the job detail page. */
const EASY_APPLY_TRIGGER_SELECTORS = [
  'button[data-testid="easy-apply"]',
  'button:has-text("Easy Apply")',
  // Test fixture form has no trigger — the form is already on the page.
  // The startApplication flow detects this case via the form-root selector.
] as const;

/** Selectors for the Easy Apply form root / modal. First match wins. */
const APPLY_FORM_ROOT_SELECTORS = [
  '[role="dialog"]',
  '#easy-apply',
  'form[data-vina-fixture="easy-apply"]',
  'form',
] as const;

const SUBMIT_BUTTON_SELECTORS = [
  'button[type="submit"]',
  'button:has-text("Submit application")',
  'button:has-text("Submit")',
] as const;

const ADVANCE_BUTTON_SELECTORS = [
  'button:has-text("Continue")',
  'button:has-text("Next")',
  'button:has-text("Review")',
] as const;

const CV_FILE_SELECTORS = [
  'input[type="file"][name*="resume" i]',
  'input[type="file"][name*="cv" i]',
  'input[type="file"][data-vina-field="cv"]',
  'input[type="file"]',
] as const;

const COVER_LETTER_FILE_SELECTORS = [
  'input[type="file"][name*="cover" i]',
  'input[type="file"][data-vina-field="cover_letter"]',
] as const;

const SUBMIT_SUCCESS_SELECTORS = [
  '[data-vina-fixture="apply-success"]',
  'h2:has-text("Application submitted")',
  'h2:has-text("Your application was sent")',
  'div:has-text("Application sent")',
] as const;

const LINKEDIN_SESSION_HEURISTICS = {
  loginPathPatterns: [/^\/login/, /^\/uas\/login/],
  textPatterns: ['Sign in to continue'],
} as const;

async function firstPresent(
  page: Page,
  selectors: readonly string[],
): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) return locator;
  }
  return null;
}

/** Selectors / accessible names that signal "you've already applied". */
const ALREADY_APPLIED_SELECTORS = [
  'text=/applied\\s*\\d*\\s*(day|hour|minute|week|month)s?\\s*ago/i',
  'text=/^applied$/i',
  'text=/you applied/i',
  'button:has-text("View application")',
] as const;

/**
 * Buttons LinkedIn shows in dismissable upsell overlays that can cover
 * the Easy Apply button on first visit (Premium trial prompts, AI feature
 * intros). Clicking these makes the underlying job page interactive.
 */
const OVERLAY_DISMISS_SELECTORS = [
  'button:has-text("Not now")',
  'button:has-text("No thanks")',
  'button:has-text("Maybe later")',
  'button[aria-label="Dismiss"]',
  'button[aria-label="Close"]',
] as const;

async function alreadyApplied(page: Page): Promise<boolean> {
  for (const sel of ALREADY_APPLIED_SELECTORS) {
    if ((await page.locator(sel).count()) > 0) return true;
  }
  return false;
}

async function dismissOverlays(page: Page): Promise<number> {
  let dismissed = 0;
  for (const sel of OVERLAY_DISMISS_SELECTORS) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click().catch(() => undefined);
      dismissed++;
      // Small settle so the next iteration sees the updated DOM.
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return dismissed;
}

/**
 * Open the apply form on `page`. The flow:
 *   1. Navigate to the listing URL.
 *   2. If a form root is already in the DOM (fixture path, or
 *      page-variant that renders the form inline), short-circuit.
 *   3. Detect "already applied" / closed listings up front and throw with
 *      a clear message — the graph turns this into an `apply_failed`
 *      alert instead of silently walking the page chrome looking for a
 *      non-existent submit button.
 *   4. Locate the Easy Apply button (selectors → accessibility tree).
 *   5. Click it and wait for the form root to mount.
 */
export async function startLinkedInApplication(
  page: Page,
  listing: RawListing,
): Promise<ApplicationSession> {
  if (!page.url().includes(listing.url)) {
    await page.goto(listing.url, { waitUntil: 'domcontentloaded' });
  }
  // Settle: LinkedIn's job detail is a SPA, page.goto returns before the
  // detail panel renders. Wait briefly for content to appear.
  await page
    .waitForLoadState('networkidle', { timeout: 5_000 })
    .catch(() => undefined);

  // Short-circuit: if a form root is already in the DOM (fixture pages,
  // some inline-form variants), no trigger click is needed.
  if (await firstPresent(page, APPLY_FORM_ROOT_SELECTORS)) {
    return { page, formId: newId() };
  }

  // Poll for up to 15s for the Easy Apply button. Within each iteration
  // also dismiss any overlay (Premium upsell, AI features intro) that
  // might be covering it, and check for already-applied state. The
  // polling is needed because LinkedIn's job page is a SPA and the
  // primary CTA renders after the initial domcontentloaded fires.
  const deadline = Date.now() + 15_000;
  let lastTrigger: Awaited<ReturnType<typeof findElementByGoal>> = null;
  while (Date.now() < deadline) {
    await dismissOverlays(page);

    if (await firstPresent(page, APPLY_FORM_ROOT_SELECTORS)) {
      return { page, formId: newId() };
    }
    if (await alreadyApplied(page)) {
      throw new Error(
        "Easy Apply is unavailable: LinkedIn shows you've already applied to this job",
      );
    }
    lastTrigger = await findElementByGoal(
      page,
      'easy_apply',
      EASY_APPLY_TRIGGER_SELECTORS,
    );
    if (lastTrigger) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!lastTrigger) {
    const tree = await takeSnapshot(page);
    const buttons = (await import('../element-locator.js'))
      .listAllButtons(tree)
      .slice(0, 30);
    log.warn(
      { visibleButtons: buttons, url: page.url() },
      'Easy Apply button not found after 15s polling',
    );
    throw new Error(
      'Easy Apply button not visible after 15s — the listing may be closed, the session may need a refresh, or LinkedIn is showing an overlay that does not match our dismiss patterns',
    );
  }

  log.debug({ tier: lastTrigger.tier }, 'easy apply trigger resolved');
  await lastTrigger.locator.click();

  // Wait for the form root to appear (modal or in-page form).
  let formRootFound = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await firstPresent(page, APPLY_FORM_ROOT_SELECTORS)) {
      formRootFound = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!formRootFound) {
    throw new Error(
      'Clicked Easy Apply but the application modal did not open within 5s',
    );
  }
  return { page, formId: newId() };
}

/**
 * Wraps `takeSnapshot` + `walkForm` and augments the result with file
 * inputs discovered via selector. Chrome's a11y tree surfaces
 * `<input type="file">` as role=button (the "Choose File" widget), which
 * `walkForm` correctly classifies as non-input — the apply graph relies
 * on the file fields being explicit so it knows when to call `uploadCv`.
 */
export async function inspectLinkedInFields(
  session: ApplicationSession,
): Promise<FormField[]> {
  const tree = await takeSnapshot(session.page);
  session.latestSnapshot = tree;
  const walked = walkForm(tree);

  // Selector-based augmentation: enumerate visible <input type="file"> elements
  // and add a synthetic FormField for each. `ref` uses a `file-` prefix so it
  // never collides with walked ref ids; `selector` carries the fallback handle.
  const fileInputs = session.page.locator('input[type="file"]');
  const fileCount = await fileInputs.count();
  for (let i = 0; i < fileCount; i++) {
    const input = fileInputs.nth(i);
    if (!(await input.isVisible().catch(() => false))) {
      // Many forms hide the native input and trigger it via a button. Treat
      // the field as present anyway — the upload helper uses
      // setInputFiles which works on hidden inputs.
    }
    const name = (await input.getAttribute('name')) ?? '';
    const datafield = (await input.getAttribute('data-vina-field')) ?? '';
    const label =
      datafield === 'cv' || /resume|cv/i.test(name)
        ? 'CV'
        : datafield === 'cover_letter' || /cover/i.test(name)
          ? 'Cover letter'
          : name || 'File';
    walked.push({
      ref: `file-${i}`,
      label,
      kind: 'file',
      required: false,
      selector: `input[type="file"]:nth-of-type(${i + 1})`,
    });
  }
  return walked;
}

/**
 * Apply `value` to the field with `ref`. Dispatches by role:
 *  - textbox / searchbox / spinbutton → `.fill(value)`
 *  - combobox / listbox → `.selectOption({ label })`, falling back to value
 *  - checkbox → `.check()` / `.uncheck()` based on a truthy value
 *  - radio → `.check()` (caller is responsible for picking the right radio
 *    by name; the ref already points at the desired one)
 *
 * Pre-Chunk-21 versions of this always called `.fill()`, which threw on
 * `<select>` elements (Chrome surfaces them as `combobox`). The graph
 * was happy to send LLM-resolved text to a combobox field and the whole
 * task died on a Playwright type error.
 */
export async function fillLinkedInField(
  session: ApplicationSession,
  ref: UiRef,
  value: string,
): Promise<void> {
  const tree = session.latestSnapshot;
  if (!tree) throw new Error('fillField: call inspectFields() (or snapshot) first');
  const node = resolveRef(tree, ref);
  if (!node) throw new Error(`fillField: ref ${ref} not in latest snapshot`);
  const locator = session.page
    .getByRole(node.role as Parameters<Page['getByRole']>[0], {
      name: node.name,
      exact: true,
    })
    .first();

  if (node.role === 'combobox' || node.role === 'listbox') {
    // Try label first (visible text the LLM/resolver gave us), then value
    // (the underlying HTML <option value="…">). Both can match real options.
    try {
      await locator.selectOption({ label: value });
    } catch {
      await locator.selectOption(value);
    }
    return;
  }
  if (node.role === 'checkbox' || node.role === 'switch') {
    const truthy = /^(true|yes|on|1|checked|agree)$/i.test(value);
    if (truthy) await locator.check();
    else await locator.uncheck();
    return;
  }
  if (node.role === 'radio') {
    await locator.check();
    return;
  }
  // textbox, searchbox, spinbutton, slider, and the rest — text-like.
  await locator.fill(value);
}

/**
 * Heuristic: LinkedIn Easy Apply usually pre-attaches the resume on the
 * user's profile. The modal renders something like "Resume.pdf · 12 KB"
 * with a "Replace" / "Remove" button, and no empty file input. When we
 * detect this, skip our upload entirely — the user explicitly asked for
 * the profile resume to be used when present.
 */
async function existingResumeAttached(page: Page): Promise<boolean> {
  // Test-fixture marker first (used by integration tests).
  if (
    (await page.locator('[data-vina-fixture="existing-resume"]').count()) > 0
  ) {
    return true;
  }
  // Filename-like text — Playwright's text engine accepts /regex/flags.
  if ((await page.locator('text=/Resume.*\\.(pdf|docx?)/i').count()) > 0) {
    return true;
  }
  if ((await page.locator('text=/CV.*\\.(pdf|docx?)/i').count()) > 0) {
    return true;
  }
  // A "Replace" / "Remove" button without a visible empty file input
  // means LinkedIn currently has a resume attached.
  const replaceBtn = page.locator(
    'button:has-text("Replace"), button:has-text("Remove")',
  );
  if ((await replaceBtn.count()) > 0) {
    const visibleFileInput = await page.locator('input[type="file"]:visible').count();
    if (visibleFileInput === 0) return true;
  }
  return false;
}

export async function uploadLinkedInCv(
  session: ApplicationSession,
  path: string,
): Promise<void> {
  if (await existingResumeAttached(session.page)) {
    log.info('uploadCv: existing resume detected on LinkedIn profile — keeping it');
    return;
  }
  const input = await firstPresent(session.page, CV_FILE_SELECTORS);
  if (!input) {
    log.info('uploadCv: no file input visible — skipping (likely pre-attached)');
    return;
  }
  await input.setInputFiles(path);
}

export async function uploadLinkedInCoverLetter(
  session: ApplicationSession,
  path: string,
): Promise<void> {
  const input =
    (await firstPresent(session.page, COVER_LETTER_FILE_SELECTORS)) ??
    // Fallback: many forms have a single "additional documents" file input.
    (await firstPresent(session.page, ['input[type="file"]:nth-of-type(2)']));
  if (!input) {
    log.info('uploadCoverLetter: no file input found — skipping');
    return;
  }
  await input.setInputFiles(path);
}

export async function advanceLinkedInStep(
  session: ApplicationSession,
): Promise<{ advanced: boolean }> {
  const button = await findElementByGoal(
    session.page,
    'advance',
    ADVANCE_BUTTON_SELECTORS,
  );
  if (!button) return { advanced: false };
  log.debug({ tier: button.tier }, 'advance button resolved');
  await button.locator.click();
  // Best-effort: wait for the DOM to settle before the next inspectFields.
  await session.page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
  return { advanced: true };
}

export async function submitLinkedInApplication(
  session: ApplicationSession,
): Promise<SubmitResult> {
  // Captcha check before clicking submit — the graph escalates and we
  // don't want to lose the form state by clicking into a doomed submit.
  const captcha = await detectCaptchaOnPage(session.page);
  if (captcha.present) {
    return { ok: false, reason: 'captcha', detail: `widget=${captcha.kind}` };
  }
  if (
    await isSessionExpiredOnPage(session.page, LINKEDIN_SESSION_HEURISTICS)
  ) {
    return { ok: false, reason: 'session_expired' };
  }
  let missDiagnostic: Array<{ role: string; name: string }> | null = null;
  const button = await findElementByGoal(
    session.page,
    'submit',
    SUBMIT_BUTTON_SELECTORS,
    {
      onMiss: ({ buttons }) => {
        missDiagnostic = buttons;
        log.warn(
          { visibleButtons: buttons.slice(0, 30) },
          'submit button not found — logging all visible buttons in a11y tree',
        );
      },
    },
  );
  if (!button) {
    const detail = missDiagnostic
      ? `no submit button found; visible buttons: ${(missDiagnostic as Array<{ name: string }>)
          .slice(0, 10)
          .map((b) => `"${b.name}"`)
          .join(', ')}`
      : 'no submit button found';
    return { ok: false, reason: 'other', detail };
  }
  log.debug({ tier: button.tier }, 'submit button resolved');
  await button.locator.click();
  // Post-click verification: success indicator, or captcha/session_expired
  // surfacing now that the click triggered them.
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await firstPresent(session.page, SUBMIT_SUCCESS_SELECTORS)) {
      return { ok: true };
    }
    const postCaptcha = await detectCaptchaOnPage(session.page);
    if (postCaptcha.present) {
      return { ok: false, reason: 'captcha', detail: `widget=${postCaptcha.kind}` };
    }
    if (
      await isSessionExpiredOnPage(session.page, LINKEDIN_SESSION_HEURISTICS)
    ) {
      return { ok: false, reason: 'session_expired' };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: false, reason: 'other', detail: 'no success indicator within 5s' };
}

export async function takeLinkedInScreenshot(
  session: ApplicationSession,
): Promise<{ pngBase64: string }> {
  const buf = await session.page.screenshot({ type: 'png', fullPage: false });
  return { pngBase64: buf.toString('base64') };
}

export async function closeLinkedInApplication(
  session: ApplicationSession,
): Promise<void> {
  // For the fixture flow and the in-page Easy Apply, nothing to close —
  // the worker holds the page and reuses it for the next listing. If the
  // form opened in a separate tab/window, close it.
  // Best-effort dismiss: click any X button if present.
  const close = session.page
    .locator('button[aria-label="Dismiss"], button[aria-label="Close"]')
    .first();
  if ((await close.count()) > 0) {
    await close.click().catch(() => undefined);
  }
}
