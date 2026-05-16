import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock modules before importing the module under test
vi.mock('../../src/lib/status.js', () => ({
  readStatus: vi.fn(),
}));

vi.mock('../../src/lib/api.js', () => ({
  authedRequest: vi.fn(),
}));

vi.mock('../../src/lib/pid.js', () => ({
  readPidFile: vi.fn(() => null),
  isProcessAlive: vi.fn(() => false),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    accessSync: vi.fn(),
  };
});

import { readStatus } from '../../src/lib/status.js';
import { authedRequest } from '../../src/lib/api.js';
import { doctorCommand } from '../../src/commands/doctor.js';

const mockReadStatus = vi.mocked(readStatus);
const mockAuthedRequest = vi.mocked(authedRequest);

beforeEach(() => {
  vi.clearAllMocks();
  // Capture stdout output
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

describe('doctorCommand SerpAPI checks', () => {
  it('skips both SerpAPI checks when daemon not running', async () => {
    mockReadStatus.mockReturnValue(null);

    await doctorCommand();

    const output = (process.stdout.write as ReturnType<typeof vi.fn>).mock.calls
      .map((args: unknown[]) => args[0] as string)
      .join('');

    expect(output).toContain('SerpAPI key configured');
    expect(output).toContain('SerpAPI key valid');
    // Both should be PASS (skipped is informational)
    const lines = output.split('\n');
    const configuredLine = lines.find((l) => l.includes('SerpAPI key configured'));
    const validLine = lines.find((l) => l.includes('SerpAPI key valid'));
    expect(configuredLine).toContain('[PASS]');
    expect(validLine).toContain('[PASS]');
    // Should mention skipped
    expect(output).toMatch(/daemon not running \(skipped\)/);
  });

  it('shows SerpAPI checks as skipped when google_state is not_configured', async () => {
    mockReadStatus.mockReturnValue({ port: 7341, token: 'test-token' } as ReturnType<typeof readStatus>);
    mockAuthedRequest.mockResolvedValue({
      active_provider: null,
      schedule_paused: false,
      google_state: 'not_configured',
      items: [],
      available: true,
      executable_path: '/usr/bin/chromium',
    } as unknown as Awaited<ReturnType<typeof authedRequest>>);

    await doctorCommand();

    const output = (process.stdout.write as ReturnType<typeof vi.fn>).mock.calls
      .map((args: unknown[]) => args[0] as string)
      .join('');

    const lines = output.split('\n');
    const configuredLine = lines.find((l) => l.includes('SerpAPI key configured'));
    const validLine = lines.find((l) => l.includes('SerpAPI key valid'));
    expect(configuredLine).toContain('[PASS]');
    expect(validLine).toContain('[PASS]');
    expect(output).toContain('not configured (skipped)');
    expect(output).toContain('no key configured (skipped)');
  });

  it('passes SerpAPI key valid check when key is configured and test returns ok', async () => {
    mockReadStatus.mockReturnValue({ port: 7341, token: 'test-token' } as ReturnType<typeof readStatus>);
    mockAuthedRequest.mockImplementation(
      async (_port: number, _method: string, path: string) => {
        if (path === '/api/system/status') {
          return {
            active_provider: null,
            schedule_paused: false,
            google_state: 'connected',
          } as unknown as Awaited<ReturnType<typeof authedRequest>>;
        }
        if (path === '/api/system/chromium') {
          return {
            available: true,
            executable_path: '/usr/bin/chromium',
          } as unknown as Awaited<ReturnType<typeof authedRequest>>;
        }
        if (path === '/api/sites/google/test') {
          return { ok: true, latency_ms: 123 } as unknown as Awaited<ReturnType<typeof authedRequest>>;
        }
        if (path.startsWith('/api/alerts')) {
          return { items: [] } as unknown as Awaited<ReturnType<typeof authedRequest>>;
        }
        return {} as unknown as Awaited<ReturnType<typeof authedRequest>>;
      },
    );

    await doctorCommand();

    const output = (process.stdout.write as ReturnType<typeof vi.fn>).mock.calls
      .map((args: unknown[]) => args[0] as string)
      .join('');

    const lines = output.split('\n');
    const configuredLine = lines.find((l) => l.includes('SerpAPI key configured'));
    const validLine = lines.find((l) => l.includes('SerpAPI key valid'));
    expect(configuredLine).toContain('[PASS]');
    expect(validLine).toContain('[PASS]');
    // Should not have skipped text
    expect(output).not.toContain('no key configured (skipped)');
  });

  it('fails SerpAPI key valid check when test returns ok: false', async () => {
    mockReadStatus.mockReturnValue({ port: 7341, token: 'test-token' } as ReturnType<typeof readStatus>);
    mockAuthedRequest.mockImplementation(
      async (_port: number, _method: string, path: string) => {
        if (path === '/api/system/status') {
          return {
            active_provider: null,
            schedule_paused: false,
            google_state: 'connected',
          } as unknown as Awaited<ReturnType<typeof authedRequest>>;
        }
        if (path === '/api/system/chromium') {
          return {
            available: true,
            executable_path: '/usr/bin/chromium',
          } as unknown as Awaited<ReturnType<typeof authedRequest>>;
        }
        if (path === '/api/sites/google/test') {
          return {
            ok: false,
            reason: 'auth_failed',
          } as unknown as Awaited<ReturnType<typeof authedRequest>>;
        }
        if (path.startsWith('/api/alerts')) {
          return { items: [] } as unknown as Awaited<ReturnType<typeof authedRequest>>;
        }
        return {} as unknown as Awaited<ReturnType<typeof authedRequest>>;
      },
    );

    const exitCode = await doctorCommand();

    const output = (process.stdout.write as ReturnType<typeof vi.fn>).mock.calls
      .map((args: unknown[]) => args[0] as string)
      .join('');

    const lines = output.split('\n');
    const validLine = lines.find((l) => l.includes('SerpAPI key valid'));
    expect(validLine).toContain('[FAIL]');
    expect(output).toContain('auth_failed');
    expect(exitCode).toBe(1);
  });
});
