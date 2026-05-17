import { describe, expect, it } from 'vitest';
import {
  SaveTailoredCvInputSchema,
  SaveTailoredCoverLetterInputSchema,
  type ManualApplyToolKit,
} from '../../src/tools/types.js';

describe('manual-apply tool kit schemas', () => {
  it('SaveTailoredCvInputSchema accepts an application_id and a Buffer', () => {
    const buf = Buffer.from('docx-bytes', 'utf8');
    const parsed = SaveTailoredCvInputSchema.parse({ application_id: 'a1', docx: buf });
    expect(parsed.application_id).toBe('a1');
    expect(Buffer.isBuffer(parsed.docx)).toBe(true);
  });

  it('SaveTailoredCoverLetterInputSchema requires application_id and Buffer', () => {
    expect(() => SaveTailoredCoverLetterInputSchema.parse({ application_id: 'a1' })).toThrow();
  });

  it('ManualApplyToolKit is interface-only — callers supply the implementation', () => {
    const fake: ManualApplyToolKit = {
      saveTailoredCv: async () => ({ path: '/tmp/a.docx' }),
      saveTailoredCoverLetter: async () => ({ path: '/tmp/a-cover.docx' }),
    };
    expect(typeof fake.saveTailoredCv).toBe('function');
  });
});
