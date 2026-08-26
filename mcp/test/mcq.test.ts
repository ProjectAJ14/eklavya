import { describe, it, expect } from 'vitest';
import { answerPosition, MCQ_OPTION_COUNT } from '../src/mcq.js';
import { loadSeedGraphs } from '../src/seed.js';

describe('answerPosition', () => {
  it('always names a real slot', () => {
    for (const slug of ['csrf', 'jwt-structure', 'react-usestate', 'git-rebase']) {
      for (let asked = 0; asked < 10; asked += 1) {
        const p = answerPosition(slug, asked);
        expect(p).toBeGreaterThanOrEqual(1);
        expect(p).toBeLessThanOrEqual(MCQ_OPTION_COUNT);
        expect(Number.isInteger(p)).toBe(true);
      }
    }
  });

  it('is stable — the same question does not move under the learner', () => {
    expect(answerPosition('csrf', 2)).toBe(answerPosition('csrf', 2));
  });

  it('moves when the concept comes back for review', () => {
    const positions = new Set([0, 1, 2, 3].map((n) => answerPosition('csrf', n)));
    expect(positions.size).toBeGreaterThan(1);
  });

  it('spreads across all four slots over the real concept graph', () => {
    // The bug this exists to prevent: every correct answer landing in slot 1.
    const slugs = loadSeedGraphs().flatMap((g) => g.concepts.map((c) => c.slug));
    const counts = new Map<number, number>();
    for (const slug of slugs) {
      const p = answerPosition(slug, 0);
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }

    expect(counts.size).toBe(MCQ_OPTION_COUNT);

    // No slot should dominate. With 87 concepts an even split is ~22 each;
    // anything above half of them in one slot is a broken distribution.
    for (const [slot, n] of counts) {
      expect(n, `slot ${slot} holds ${n} of ${slugs.length}`).toBeLessThan(slugs.length / 2);
    }
  });

  it('does not favour the first slot', () => {
    const slugs = loadSeedGraphs().flatMap((g) => g.concepts.map((c) => c.slug));
    const first = slugs.filter((s) => answerPosition(s, 0) === 1).length;
    expect(first).toBeLessThan(slugs.length * 0.5);
  });
});
