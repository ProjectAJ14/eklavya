import { describe, it, expect } from 'vitest';
import { scoreAll, type GeneratedQuestion } from '../src/eval/question-checks.js';
import { extractJson } from '../src/eval/extract-json.js';
import { checkExtractionShape, summarizeExtraction } from '../src/eval/extraction-score.js';
import { compare, scoreQuery, summarise } from '../src/eval/retrieval-score.js';

function q(over: Partial<GeneratedQuestion> = {}): GeneratedQuestion {
  return {
    fixture: 'f1',
    slug: 'httponly-cookies',
    tier_to_ask: 3,
    answer_position: 2,
    stem: 'Why is httpOnly set on the refresh cookie here but not on the access token?',
    options: ['alpha beta', 'gamma delta epsilon', 'zeta eta', 'theta iota'],
    correct: 2,
    ...over,
  };
}

describe('question checks edge cases', () => {
  it('counts slots three and four, and skips an out-of-range answer', () => {
    const { summary } = scoreAll([
      q({ correct: 3, answer_position: 3 }),
      q({ correct: 4, answer_position: 4, options: ['a', 'b', 'c', 'd e f g'] }),
      q({ correct: 0 }),
    ]);
    expect(summary.slots).toEqual([0, 0, 1, 1]);
    // Only the fourth-slot answer is uniquely longest; the out-of-range one is not counted.
    expect(summary.correctLongest).toBe(1);
  });

  it('does not credit a correct slot that has no option at all', () => {
    const { summary } = scoreAll([q({ correct: 4, options: ['a', 'b'] })]);
    expect(summary.slots).toEqual([0, 0, 0, 1]);
    expect(summary.correctLongest).toBe(0);
  });
});

describe('extractJson edge cases', () => {
  it('skips balanced braces that are not JSON', () => {
    expect(extractJson('{not json}')).toBeNull();
    expect(extractJson('{bad} then {"ok":1}')).toEqual({ ok: 1 });
  });
});

describe('extraction shape edge cases', () => {
  it('reports a missing context as naming nothing, even against an empty diff', () => {
    const checks = checkExtractionShape([{ slug: 'jwt-rotation' }], '');
    expect(checks.find((c) => c.id === 'every_concept_has_context')!.ok).toBe(false);
    expect(checks.find((c) => c.id === 'context_names_the_code')!.ok).toBe(false);
  });

  it('reports f1 as zero rather than dividing by zero', () => {
    const summary = summarizeExtraction([
      { fixture: 'f', matched: [], missed: ['a'], unlabelled: ['b'], precision: 0, recall: 0, f1: 0 },
    ]);
    expect(summary.f1).toBe(0);
    expect(summary.unlabelled).toBe(1);
  });
});

describe('retrieval comparison', () => {
  const at = (top1: number, recall: number) => ({
    mode: `m${top1}-${recall}`,
    summary: { queries: 1, k: 5, top1, precision: 0, recall, mrr: 0, misses: [] },
  });

  it('scores recall as zero when nothing was relevant', () => {
    expect(scoreQuery([1, 2], [], 5).recall).toBe(0);
    expect(summarise([], 5).queries).toBe(0);
  });

  it('names the winner only when neither number goes backwards', () => {
    expect(compare(at(0.5, 0.5), at(0.6, 0.5)).better).toBe('m0.6-0.5');
    expect(compare(at(0.5, 0.5), at(0.6, 0.4)).better).toBeNull();
    expect(compare(at(0.5, 0.5), at(0.4, 0.5)).better).toBe('m0.5-0.5');
    expect(compare(at(0.5, 0.5), at(0.4, 0.6)).better).toBeNull();
    expect(compare(at(0.5, 0.5), at(0.5, 0.6)).better).toBe('m0.5-0.6');
    expect(compare(at(0.5, 0.6), at(0.5, 0.5)).better).toBe('m0.5-0.6');
    expect(compare(at(0.5, 0.5), at(0.5, 0.5)).better).toBeNull();
  });
});
