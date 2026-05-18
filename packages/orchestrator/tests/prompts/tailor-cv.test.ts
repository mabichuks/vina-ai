import { describe, expect, it } from 'vitest';
import {
  TAILOR_CV_SYSTEM,
  tailorCvUserPrompt,
  type TailorCvInput,
} from '../../src/prompts/tailor-cv.js';

const BASE: TailorCvInput = {
  job: {
    title: 'Senior TypeScript Engineer',
    company: 'Acme Corp',
    description: 'We build Postgres pipelines and TypeScript APIs.',
  },
  source_cv_text: 'Worked at FooCo 2020-2024 on Node services.',
  user_profile: { full_name: 'Pat Doe', bio: 'Generalist engineer.' },
};

describe('TAILOR_CV_SYSTEM', () => {
  it('forbids fact invention explicitly', () => {
    expect(TAILOR_CV_SYSTEM).toMatch(/do not (invent|fabricate|make up)/i);
  });

  it('shows a worked example of acceptable rephrasing', () => {
    expect(TAILOR_CV_SYSTEM).toMatch(/example/i);
    expect(TAILOR_CV_SYSTEM).toMatch(/rephrase/i);
  });
});

describe('tailorCvUserPrompt', () => {
  it('places the job listing before the source CV', () => {
    const out = tailorCvUserPrompt(BASE);
    expect(out.indexOf('## Job')).toBeLessThan(out.indexOf('## Source CV'));
  });

  it('includes the user profile', () => {
    const out = tailorCvUserPrompt(BASE);
    expect(out).toContain('Pat Doe');
  });
});
