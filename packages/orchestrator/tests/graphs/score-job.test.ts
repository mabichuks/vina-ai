import { describe, expect, it } from 'vitest';
import { ProviderError } from '@vina/shared';
import {
  runScoreJob,
  type ScoreMessages,
  type StructuredScorer,
} from '../../src/graphs/score-job.js';
import type { ScoreInput } from '../../src/prompts/score.js';

const FIXTURE: ScoreInput = {
  job: {
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    description: 'Build payment systems in Go.',
  },
  profile: { full_name: 'Ada', bio: null },
  prefs: {
    description: 'Senior backend',
    keywords: ['go', 'payments'],
    locations: ['Remote'],
    work_models: ['remote'],
    seniority: ['senior'],
    excluded_companies: [],
  },
};

/**
 * Build a fake `StructuredScorer` whose generated runnable yields the values
 * from `responses` in order. A response can be a parsed object (success) or
 * an Error (the runnable rejects — simulates malformed model output).
 */
function fakeScorer(
  responses: ReadonlyArray<{ score: number; justification: string } | Error>,
): StructuredScorer & { calls: ScoreMessages[] } {
  const calls: ScoreMessages[] = [];
  let i = 0;
  return {
    calls,
    withStructuredOutput: () =>
      ({
        invoke: (messages: ScoreMessages) => {
          calls.push(messages);
          const r = responses[i++];
          if (r === undefined) return Promise.reject(new Error('out of responses'));
          if (r instanceof Error) return Promise.reject(r);
          return Promise.resolve(r);
        },
      }) as never,
  };
}

describe('runScoreJob', () => {
  it('returns a high-match score on the first try', async () => {
    const model = fakeScorer([{ score: 92, justification: 'Strong title + skills.' }]);
    const out = await runScoreJob(FIXTURE, model);
    expect(out).toEqual({ score: 92, justification: 'Strong title + skills.' });
    expect(model.calls).toHaveLength(1);
  });

  it('passes through a low-match score', async () => {
    const model = fakeScorer([
      { score: 18, justification: 'Title too junior; skills barely overlap.' },
    ]);
    const out = await runScoreJob(FIXTURE, model);
    expect(out.score).toBe(18);
  });

  it('retries once on malformed output, then succeeds', async () => {
    const model = fakeScorer([
      new Error('zod parse failed: expected number'),
      { score: 75, justification: 'Decent fit on second pass.' },
    ]);
    const out = await runScoreJob(FIXTURE, model);
    expect(out.score).toBe(75);
    expect(model.calls).toHaveLength(2);
  });

  it('throws ProviderError after two failed attempts', async () => {
    const model = fakeScorer([new Error('first failure'), new Error('second failure')]);
    await expect(runScoreJob(FIXTURE, model)).rejects.toBeInstanceOf(ProviderError);
    expect(model.calls).toHaveLength(2);
  });

  it('clamps out-of-range scores to [0, 100] and rounds to integer', async () => {
    const high = fakeScorer([{ score: 105, justification: 'Way over.' }]);
    expect((await runScoreJob(FIXTURE, high)).score).toBe(100);

    const low = fakeScorer([{ score: -3, justification: 'Negative.' }]);
    expect((await runScoreJob(FIXTURE, low)).score).toBe(0);

    const fractional = fakeScorer([{ score: 73.6, justification: 'Fractional.' }]);
    expect((await runScoreJob(FIXTURE, fractional)).score).toBe(74);
  });
});
