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
export { type SiteAdapter } from './adapters/adapter.js';
export { type JobDetail, type RawListing } from './adapters/types.js';
export { firstVisible, getHref, isExternalUrl } from './detect/apply-method.js';
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
