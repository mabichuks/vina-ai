export class VinaError extends Error {
  static readonly status: number = 500;
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (details !== undefined) this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  get status(): number {
    return (this.constructor as typeof VinaError).status;
  }

  toJSON(): { code: string; message: string; details?: unknown } {
    const out: { code: string; message: string; details?: unknown } = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export class ValidationError extends VinaError {
  static override readonly status = 400;
  constructor(message = 'Validation failed', details?: unknown, code = 'validation_error') {
    super(code, message, details);
  }
}

export class AuthError extends VinaError {
  static override readonly status = 401;
  constructor(message = 'Unauthorized', details?: unknown, code = 'auth_error') {
    super(code, message, details);
  }
}

export class NotFoundError extends VinaError {
  static override readonly status = 404;
  constructor(message = 'Not found', details?: unknown) {
    super('not_found', message, details);
  }
}

export class ConflictError extends VinaError {
  static override readonly status = 409;
  constructor(message = 'Conflict', details?: unknown, code = 'conflict') {
    super(code, message, details);
  }
}

export class ProviderError extends VinaError {
  static override readonly status = 502;
  constructor(message = 'Upstream provider failed', details?: unknown) {
    super('provider_error', message, details);
  }
}

export class AutomationError extends VinaError {
  static override readonly status = 500;
  constructor(message = 'Automation failed', details?: unknown) {
    super('automation_error', message, details);
  }
}
