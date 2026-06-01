import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPromptLoader } from '../../src/prompts/loader.js';
import { tailorCvUserPrompt, type TailorCvInput } from '../../src/prompts/tailor-cv.js';

const loader = createPromptLoader({
  defaultsDir: fileURLToPath(new URL('../../prompts/', import.meta.url)),
});

const BASE: TailorCvInput = {
  job: {
    title: 'Senior TypeScript Engineer',
    company: 'Acme Corp',
    description: 'We build Postgres pipelines and TypeScript APIs.',
  },
  source_cv_text: 'Worked at FooCo 2020-2024 on Node services.',
  user_profile: { full_name: 'Pat Doe', bio: 'Generalist engineer.' },
};

describe('tailor-cv system prompt (loaded from prompts/tailor-cv.md)', () => {
  it('forbids fact invention explicitly', async () => {
    const body = await loader.render('tailor-cv');
    expect(body).toMatch(/do not (invent|fabricate|make up)/i);
  });

  it('shows a worked example of acceptable rephrasing', async () => {
    const body = await loader.render('tailor-cv');
    expect(body).toMatch(/example/i);
    expect(body).toMatch(/rephrase/i);
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
