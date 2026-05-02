import { describe, expect, it } from 'vitest';
import {
  AuthError,
  AutomationError,
  ConflictError,
  NotFoundError,
  ProviderError,
  ValidationError,
  VinaError,
} from '../src/errors.js';

describe('VinaError hierarchy', () => {
  it('subclasses are instanceof VinaError and Error and carry the right HTTP status', () => {
    const cases = [
      [new ValidationError(), 400],
      [new AuthError(), 401],
      [new NotFoundError(), 404],
      [new ConflictError(), 409],
      [new ProviderError(), 502],
      [new AutomationError(), 500],
    ] as const;
    for (const [err, status] of cases) {
      expect(err).toBeInstanceOf(VinaError);
      expect(err).toBeInstanceOf(Error);
      expect(err.status).toBe(status);
    }
  });

  it('JSON-serialises to { code, message } and includes details when provided', () => {
    expect(JSON.parse(JSON.stringify(new NotFoundError('Job missing')))).toEqual({
      code: 'not_found',
      message: 'Job missing',
    });
    expect(
      JSON.parse(JSON.stringify(new ValidationError('Bad payload', { field: 'email' }))),
    ).toEqual({
      code: 'validation_error',
      message: 'Bad payload',
      details: { field: 'email' },
    });
  });

  it('preserves the subclass name (used for logging)', () => {
    expect(new ValidationError().name).toBe('ValidationError');
    expect(new AutomationError().name).toBe('AutomationError');
  });
});
