import { describe, expect, it, vi } from 'vitest';
import { runTailorCv, renderTailoredDocx } from '../../src/graphs/tailor-cv.js';
import type { TailorCvInput } from '../../src/prompts/tailor-cv.js';
import type { StructuredScorer } from '../../src/graphs/score-job.js';

const INPUT: TailorCvInput = {
  job: { title: 'Senior TS Engineer', company: 'Acme', description: 'TS APIs' },
  source_cv_text: 'FooCo 2020-2024 — Node services.',
  user_profile: { full_name: 'Pat Doe', bio: 'Engineer.' },
};

function fakeModel(output: unknown, throws?: number): StructuredScorer {
  let n = 0;
  return {
    withStructuredOutput: () => ({
      invoke: vi.fn(async () => {
        n += 1;
        if (throws && n <= throws) throw new Error('llm jitter');
        return output;
      }),
    }),
  } as unknown as StructuredScorer;
}

describe('runTailorCv', () => {
  it('returns a parsed structured TailorCvOutput on first success', async () => {
    const model = fakeModel({
      summary: 'Sr TS eng. 4yrs Node.',
      bullets: [{ section: 'FooCo', bullet: 'Built Node services.' }],
      skills: ['typescript', 'node'],
    });
    const out = await runTailorCv(INPUT, model);
    expect(out.summary).toContain('TS');
    expect(out.bullets).toHaveLength(1);
    expect(out.skills).toContain('typescript');
  });

  it('retries once on a thrown LLM error then succeeds', async () => {
    const model = fakeModel({ summary: 's', bullets: [], skills: [] }, 1);
    const out = await runTailorCv(INPUT, model);
    expect(out.summary).toBe('s');
  });

  it('throws ProviderError after second failure', async () => {
    const model = fakeModel(null, 2);
    await expect(runTailorCv(INPUT, model)).rejects.toThrow(/tailor.*failed/i);
  });

  it('truncates source_cv_text over 14000 chars before sending', async () => {
    const long = 'a'.repeat(20000);
    let capturedMessages: Array<{ content: string }> = [];
    const model: StructuredScorer = {
      withStructuredOutput: () => ({
        invoke: vi.fn(async (msgs: Array<{ content: string }>) => {
          capturedMessages = msgs;
          return { summary: 's', bullets: [], skills: [] };
        }),
      }),
    } as unknown as StructuredScorer;
    await runTailorCv({ ...INPUT, source_cv_text: long }, model);
    const user = capturedMessages.find((m) => m.content.includes('## Source CV'))!;
    expect(user.content.length).toBeLessThan(20000);
  });
});

describe('renderTailoredDocx', () => {
  it('produces a non-empty Buffer that starts with the docx zip magic', async () => {
    const buf = await renderTailoredDocx(
      { summary: 'sum', bullets: [{ section: 'Acme', bullet: 'b1' }], skills: ['ts'] },
      { full_name: 'Pat Doe', email: 'p@x.com' },
    );
    expect(buf.length).toBeGreaterThan(200);
    // docx files are zips; PK\x03\x04 is the zip local-file-header signature.
    expect(buf.subarray(0, 2).toString()).toBe('PK');
  });
});
