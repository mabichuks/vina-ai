import { describe, expect, it } from 'vitest';
import { createLoggerForTest, type Logger } from '../src/logger.js';

function withLogger(fn: (log: Logger) => void, module = 'test'): Record<string, unknown> {
  const lines: string[] = [];
  const logger = createLoggerForTest(module, {
    write: (msg) => {
      lines.push(typeof msg === 'string' ? msg : Buffer.from(msg).toString('utf8'));
    },
  });
  fn(logger);
  return JSON.parse(lines.at(-1) ?? '') as Record<string, unknown>;
}

describe('createLogger redaction', () => {
  it('redacts secrets at top-level and nested under one and two layers', () => {
    const record = withLogger((log) =>
      log.info(
        {
          api_key: 'top',
          provider: { api_key: 'one-deep' },
          req: { headers: { cookies: 'two-deep' } },
        },
        'msg',
      ),
    );
    expect(record['api_key']).toBe('[redacted]');
    expect((record['provider'] as Record<string, unknown>)['api_key']).toBe('[redacted]');
    expect((record['req'] as Record<string, Record<string, unknown>>)['headers']?.['cookies']).toBe(
      '[redacted]',
    );
  });

  it('does not redact unrelated fields and tags the module', () => {
    const record = withLogger((log) => log.info({ company: 'Acme', score: 87 }, 'hi'), 'queue');
    expect(record['company']).toBe('Acme');
    expect(record['score']).toBe(87);
    expect(record['module']).toBe('queue');
  });
});
