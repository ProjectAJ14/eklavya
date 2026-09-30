import { describe, expect, it } from 'vitest';
import { estimateTokens, estimateTokensOf, recalledLine, savingsFrom, savingsLine } from '../src/memory/tokens.js';

describe('token accounting', () => {
  it('estimates four characters per token and ignores missing parts', () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
    // 'abc' + '\n' + 'de' = 6 chars; null, '' and undefined are dropped before the join.
    expect(estimateTokensOf(['abc', null, '', undefined, 'de'])).toBe(2);
    expect(estimateTokensOf([])).toBe(0);
  });

  it('reports each savings kind with its own banner line', () => {
    expect(savingsLine(savingsFrom({ baseTokens: 0, deliveredTokens: 0, delivery: 'confirmed' }))).toBe(
      'Your savings: — no context reused yet',
    );
    expect(savingsLine(savingsFrom({ baseTokens: 100, deliveredTokens: 10, delivery: 'unknown' }))).toBe(
      'Your savings: — unavailable',
    );
    const overhead = savingsFrom({ baseTokens: 10, deliveredTokens: 25, delivery: 'confirmed' });
    expect(overhead).toEqual({ kind: 'overhead', tokens: 15, base: 10, delivered: 25 });
    expect(savingsLine(overhead)).toBe('Reuse overhead: 15 tokens (estimated)');
    expect(savingsLine(savingsFrom({ baseTokens: 200, deliveredTokens: 50, delivery: 'confirmed' }))).toBe(
      'Your savings: 75% less context from reuse (estimated)',
    );
  });

  it('names recalled entries and indexed titles in singular and plural', () => {
    expect(recalledLine(1, 500)).toBe('Memory · 1 past entry recalled (~500 tokens)');
    expect(recalledLine(3, 2500, 1)).toBe('Memory · 3 past entries + 1 title recalled (~2.5k tokens)');
    expect(recalledLine(2, 10, 4)).toBe('Memory · 2 past entries + 4 titles recalled (~10 tokens)');
  });
});
