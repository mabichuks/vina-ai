export class LinkedInSessionExpiredError extends Error {
  constructor() {
    super('linkedin_session_expired');
    this.name = 'LinkedInSessionExpiredError';
  }
}

/**
 * Thrown by a handler when an in-flight task observes its `AbortSignal` flip
 * mid-iteration. The worker maps this to a clean `cancelled` row transition
 * rather than the normal retry path — cancellation is user-driven and does
 * not consume a retry budget or trip `onTerminalFailure`.
 */
export class AbortedError extends Error {
  constructor() {
    super('cancelled_by_user');
    this.name = 'AbortedError';
  }
}
