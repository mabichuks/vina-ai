import { describe, expect, it, vi } from 'vitest';
import {
  runTailorCoverLetter,
  renderTailoredCoverLetterDocx,
} from '../../src/graphs/tailor-cover-letter.js';
import type { TailorCoverLetterInput } from '../../src/prompts/tailor-cover-letter.js';
import type { StructuredScorer } from '../../src/graphs/score-job.js';

const INPUT: TailorCoverLetterInput = {
  job: { title: 'Sr TS Eng', company: 'Acme', description: 'TS APIs' },
  source_template: 'Dear Hiring Manager, I am writing about your role.',
  user_profile: { full_name: 'Pat Doe', bio: 'Engineer.' },
};

function fakeModel(output: unknown): StructuredScorer {
  return {
    withStructuredOutput: () => ({
      invoke: vi.fn(async () => output),
    }),
  } as unknown as StructuredScorer;
}

describe('runTailorCoverLetter', () => {
  it('returns structured greeting, body, closing', async () => {
    const model = fakeModel({
      greeting: 'Dear Acme team,',
      body_paragraphs: ['I have 4 years of TS.', 'I lead small teams.'],
      closing: 'Sincerely, Pat Doe',
    });
    const out = await runTailorCoverLetter(INPUT, model);
    expect(out.greeting).toBe('Dear Acme team,');
    expect(out.body_paragraphs).toHaveLength(2);
    expect(out.closing).toContain('Pat Doe');
  });
});

describe('renderTailoredCoverLetterDocx', () => {
  it('produces a non-empty zip Buffer', async () => {
    const buf = await renderTailoredCoverLetterDocx(
      {
        greeting: 'Dear team,',
        body_paragraphs: ['Para one.', 'Para two.'],
        closing: 'Sincerely, P',
      },
      { full_name: 'Pat Doe', email: 'p@x.com' },
    );
    expect(buf.length).toBeGreaterThan(200);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
  });
});
