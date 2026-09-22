import { describe, expect, it } from 'vitest';
import { compare, scoreQuery, summarise } from '../src/eval/retrieval-score.js';

describe('retrieval scoring', () => {
  it('scores a perfect top hit', () => {
    const s = scoreQuery([7, 2, 3], [7], 3);
    expect(s.top1).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.rr).toBe(1);
  });

  it('gives no credit for a relevant result below the cut', () => {
    // A hit at rank 6 with a budget of 5 was not delivered, so it did not help.
    const s = scoreQuery([1, 2, 3, 4, 5, 7], [7], 5);
    expect(s.hits).toBe(0);
    expect(s.rr).toBe(0);
    expect(s.recall).toBe(0);
  });

  it('halves the reciprocal rank for a hit in second place', () => {
    expect(scoreQuery([1, 7], [7], 5).rr).toBe(0.5);
    expect(scoreQuery([1, 7], [7], 5).top1).toBe(0);
  });

  it('names every query that found nothing, which is the failure a saving hides', () => {
    const scores = [
      { ...scoreQuery([7], [7], 5), query: 'found' },
      { ...scoreQuery([1], [7], 5), query: 'missed' },
    ];
    expect(summarise(scores, 5).misses).toEqual(['missed']);
  });

  it('refuses to name a winner that traded recall for top-1', () => {
    // A mode that puts the right answer first more often but finds less of what
    // mattered has not won, and blending the two into one score would hide it.
    const a = { mode: 'keyword', summary: summarise([{ ...scoreQuery([7, 8], [7, 8], 5), query: 'a' }], 5) };
    const b = { mode: 'hybrid', summary: summarise([{ ...scoreQuery([7], [7, 8], 5), query: 'a' }], 5) };
    expect(compare(a, b).better).toBe('keyword');
    expect(compare(a, b).recallDelta).toBeLessThan(0);
  });

  it('is empty-safe rather than dividing by zero', () => {
    expect(summarise([], 5).precision).toBe(0);
    expect(scoreQuery([], [7], 5).recall).toBe(0);
  });
});
