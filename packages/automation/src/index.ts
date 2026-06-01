export type { BrowserContext, Page } from 'playwright';
export { getChromiumInfo, type ChromiumInfo } from './browser/chromium-info.js';
export {
  launchCdpSession,
  type LaunchCdpOptions,
  type CdpSessionHandle,
} from './browser/cdp.js';
export {
  LISTING_MAX_MS,
  LISTING_MIN_MS,
  pause,
  sleepBetweenListings,
} from './browser/humanise.js';
export {
  type ActAction,
  type ApplicationSession,
  type SiteAdapter,
  type SubmitResult,
} from './adapters/adapter.js';
export { actOnSession, snapshotSession } from './adapters/session-actions.js';
export { walkForm } from './forms/form-walker.js';
export {
  resolveFieldValue,
  type AnswerEntry,
  type ResolveContext,
  type ResolveProfile,
  type ResolveResult,
  type ResolveSource,
} from './forms/field-resolver.js';
export {
  CANONICAL_KEYS,
  matchCanonicalKey,
  type CanonicalKeySpec,
} from './forms/field-map.js';
export { type FormField, type FormFieldKind } from './forms/types.js';
export { type JobDetail, type RawListing } from './adapters/types.js';
export { firstVisible, getHref, isExternalUrl } from './detect/apply-method.js';
export {
  detectCaptcha,
  detectCaptchaOnPage,
  type CaptchaDetection,
  type CaptchaKind,
  type DetectablePage,
} from './detect/captcha.js';
export {
  isSessionExpired,
  isSessionExpiredOnPage,
  type SessionDetectablePage,
  type SessionExpiredHeuristics,
} from './detect/session.js';
export {
  accessibilityNodeToUiTree,
  takeSnapshot,
  type RawAccessibilityNode,
  type UiNode,
  type UiRef,
  type UiTree,
} from './snapshot/snapshot.js';
export { findByLabel, resolveRef, walkTree } from './snapshot/refs.js';
export {
  createBrowserManager,
  type BrowserManagerHandle,
  type BrowserManagerOptions,
} from './browser/manager.js';
export {
  linkedInAdapter,
  iterateLinkedInCards,
  openLinkedInListing,
  capturePageDomSummary,
  type DetailSelectorOverrides,
} from './adapters/linkedin/index.js';
