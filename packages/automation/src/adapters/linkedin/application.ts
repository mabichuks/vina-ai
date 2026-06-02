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

/**
 * Open the apply form on `page`. The flow:
 *   1. Navigate to the listing URL.
 *   2. Locate the Easy Apply button (selectors → accessibility tree).
 *   3. Click it (if found) and wait for the form root to mount.
 *
 * The selector→a11y two-tier resolution (ADR-022) means the open step
 * survives LinkedIn renaming its data-testids or class names — the
 * "Easy Apply" button is still named "Easy Apply" in the a11y tree.
 */
export async function startLinkedInApplication(
  page: Page,
  listing: RawListing,
): Promise<ApplicationSession> {
  if (!page.url().includes(listing.url)) {
    await page.goto(listing.url, { waitUntil: 'domcontentloaded' });
  }
  const trigger = await findElementByGoal(
    page,
    'easy_apply',
    EASY_APPLY_TRIGGER_SELECTORS,
  );
  if (trigger) {
    log.debug({ tier: trigger.tier }, 'easy apply trigger resolved');
    await trigger.locator.click();
  }
  // Wait for the form root to appear (modal or in-page form).
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await firstPresent(page, APPLY_FORM_ROOT_SELECTORS)) break;
    await new Promise((r) => setTimeout(r, 100));
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
 * Type `value` into the field with `ref`. Resolves through the latest
 * snapshot (`act`'s stale-ref retry semantics apply). Locator-based
 * `.fill()` rather than `.type()` — faster and survives input shadows.
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
