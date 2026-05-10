export class LinkedInSessionExpiredError extends Error {
  constructor() {
    super('linkedin_session_expired');
    this.name = 'LinkedInSessionExpiredError';
  }
}
