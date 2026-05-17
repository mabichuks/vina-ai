import { describe, expect, it, vi } from 'vitest';
import {
  runPrepareManualApply,
  type PrepareManualApplyInput,
  type PrepareManualApplyResult,
} from '../../src/graphs/prepare-manual-apply.js';
import type { StructuredScorer } from '../../src/graphs/score-job.js';
import type { ManualApplyToolKit } from '../../src/tools/types.js';

const BASE_INPUT: PrepareManualApplyInput = {
  application_id: 'a1',
  job: { title: 'Sr TS Eng', company: 'Acme', description: 'TS APIs' },
  cv: { text: 'FooCo 2020-2024.' },
  cover_letter_template: null,
  user_profile: { full_name: 'Pat Doe', email: 'p@x.com', bio: 'Engineer.' },
};

function modelFor(outputs: unknown[]): StructuredScorer {
  let i = 0;
  return {
    withStructuredOutput: () => ({
      invoke: vi.fn(async () => outputs[i++]),
    }),
  } as unknown as StructuredScorer;
}

function fakeToolKit(): ManualApplyToolKit {
  return {
    saveTailoredCv: vi.fn(async ({ application_id }) => ({
      path: `/tmp/${application_id}.docx`,
    })),
    saveTailoredCoverLetter: vi.fn(async ({ application_id }) => ({
      path: `/tmp/${application_id}-cover.docx`,
    })),
  };
}

describe('runPrepareManualApply', () => {
  it('runs only tailor_cv when cover_letter_template is null', async () => {
    const tk = fakeToolKit();
    const model = modelFor([{ summary: 's', bullets: [], skills: [] }]);
    const out: PrepareManualApplyResult = await runPrepareManualApply(BASE_INPUT, model, tk);
    expect(out.tailored_cv_path).toBe('/tmp/a1.docx');
    expect(out.tailored_cover_letter_path).toBeNull();
    expect(tk.saveTailoredCoverLetter).not.toHaveBeenCalled();
  });

  it('also runs tailor_cover_letter when template provided', async () => {
    const tk = fakeToolKit();
    const model = modelFor([
      { summary: 's', bullets: [], skills: [] },
      { greeting: 'Dear', body_paragraphs: ['p1'], closing: 'Sincerely' },
    ]);
    const out = await runPrepareManualApply(
      { ...BASE_INPUT, cover_letter_template: { text: 'Dear Sir/Madam,' } },
      model,
      tk,
    );
    expect(out.tailored_cv_path).toBe('/tmp/a1.docx');
    expect(out.tailored_cover_letter_path).toBe('/tmp/a1-cover.docx');
    expect(tk.saveTailoredCoverLetter).toHaveBeenCalledOnce();
  });

  it('surfaces the failing stage when tailor_cv throws', async () => {
    const tk = fakeToolKit();
    const model: StructuredScorer = {
      withStructuredOutput: () => ({
        invoke: vi.fn(async () => {
          throw new Error('llm down');
        }),
      }),
    } as unknown as StructuredScorer;
    await expect(runPrepareManualApply(BASE_INPUT, model, tk)).rejects.toMatchObject({
      stage: 'tailor_cv',
    });
  });
});
