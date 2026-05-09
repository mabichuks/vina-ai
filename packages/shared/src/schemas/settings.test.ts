import { describe, expect, it } from 'vitest';
import { SettingsSchema, SettingsUpdateSchema } from './settings.js';

describe('SettingsSchema', () => {
  it('parses a representative row', () => {
    const fixture = {
      id: 'app' as const,
      mode: 'autonomous' as const,
      approval: 'review-first' as const,
      browser_headful: false,
      paused: false,
      active_llm_provider_id: '01HPROV',
      has_serpapi_key: true,
      updated_at: '2026-04-28T12:00:00Z',
    };
    expect(SettingsSchema.parse(fixture)).toEqual(fixture);
  });

  it('rejects unknown mode', () => {
    expect(() =>
      SettingsSchema.parse({
        id: 'app',
        mode: 'manual',
        approval: 'auto-apply',
        browser_headful: false,
        paused: false,
        active_llm_provider_id: null,
        has_serpapi_key: false,
        updated_at: '2026-04-28T12:00:00Z',
      }),
    ).toThrow();
  });

  it('forbids serpapi_key as a response field', () => {
    const parsed = SettingsSchema.safeParse({
      id: 'app',
      mode: 'supervised',
      approval: 'auto-apply',
      browser_headful: true,
      paused: false,
      active_llm_provider_id: null,
      has_serpapi_key: false,
      serpapi_key: 'leak',
      updated_at: '2026-04-28T12:00:00Z',
    });
    // Strict-by-default zod object would reject; default behaviour strips unknowns.
    // Either way: result must not contain serpapi_key.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('serpapi_key');
    }
  });
});

describe('SettingsUpdateSchema', () => {
  it('accepts plaintext serpapi_key (write-only)', () => {
    expect(SettingsUpdateSchema.parse({ serpapi_key: 'sk_live_x' })).toEqual({
      serpapi_key: 'sk_live_x',
    });
  });

  it('accepts null serpapi_key to clear the saved key', () => {
    expect(SettingsUpdateSchema.parse({ serpapi_key: null })).toEqual({
      serpapi_key: null,
    });
  });

  it('accepts partial input', () => {
    expect(SettingsUpdateSchema.parse({ paused: true })).toEqual({ paused: true });
    expect(SettingsUpdateSchema.parse({})).toEqual({});
  });

  it('rejects unknown approval value', () => {
    expect(() => SettingsUpdateSchema.parse({ approval: 'maybe' })).toThrow();
  });
});
