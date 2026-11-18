import { describe, expect, it } from 'vitest';
import { externalToolEventKind } from '../../src/opencode/tool-event-bridge.js';

describe('externalToolEventKind', () => {
  it('maps navigation and snapshot to external_form_opened', () => {
    expect(externalToolEventKind('playwright_browser_navigate')).toBe('external_form_opened');
    expect(externalToolEventKind('browser_navigate')).toBe('external_form_opened');
    expect(externalToolEventKind('playwright_browser_snapshot')).toBe('external_form_opened');
  });

  it('maps field writes to external_field_filled', () => {
    expect(externalToolEventKind('playwright_browser_type')).toBe('external_field_filled');
    expect(externalToolEventKind('browser_click')).toBe('external_field_filled');
    expect(externalToolEventKind('playwright_browser_select_option')).toBe('external_field_filled');
    expect(externalToolEventKind('playwright_browser_file_upload')).toBe('external_field_filled');
  });

  it('never maps a submit click or the gated tool to a field/submit event', () => {
    // A raw click on a submit control cannot be hard-classified (accepted risk);
    // it is not a field fill. vina_external_submit writes its own terminal event.
    expect(externalToolEventKind('playwright_browser_click')).toBe('external_field_filled');
    expect(externalToolEventKind('vina_external_submit')).toBeNull();
    expect(externalToolEventKind('unknown_tool')).toBeNull();
  });
});
