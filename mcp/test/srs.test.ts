import { describe, it, expect } from 'vitest';
import {
  applyGrade,
  decayedScore,
  initialMastery,
  isDue,
  isKnown,
  nextEase,
  nextTierToAsk,
  scoreFromGrades,
  suggestedTier,
  DECAY_FLOOR,
  MIN_EASE,
  MS_PER_DAY,
} from '../src/srs.js';

const NOW = new Date('2026-08-26T10:00:00.000Z');
const daysFrom = (base: Date, d: number) => new Date(base.getTime() + d * MS_PER_DAY);

function grade(state = initialMastery(), grades: number[], now = NOW) {
  let s = state;
  const seen: number[] = [];
  for (const g of grades) {
    seen.push(g);
    s = applyGrade({ state: s, grade: g, grades: seen, now });
  }
  return s;
}

describe('nextEase', () => {
  it('rises on a perfect answer and falls on a poor one', () => {
    expect(nextEase(2.5, 5)).toBeGreaterThan(2.5);
    expect(nextEase(2.5, 3)).toBeLessThan(2.5);
    expect(nextEase(2.5, 0)).toBeLessThan(nextEase(2.5, 2));
  });

  it('holds steady at grade 4', () => {
    expect(nextEase(2.5, 4)).toBeCloseTo(2.5, 6);
  });

  it('never falls below the floor, however many failures', () => {
    let ease = 2.5;
    for (let i = 0; i < 50; i += 1) ease = nextEase(ease, 0);
    expect(ease).toBe(MIN_EASE);
  });
});

describe('applyGrade — interval ladder', () => {
  it('walks 1d then 6d then interval x ease on successive passes', () => {
    let s = grade(initialMastery(), [4]);
    expect(s.reps).toBe(1);
    expect(s.interval_d).toBe(1);

    s = applyGrade({ state: s, grade: 4, grades: [4, 4], now: NOW });
    expect(s.reps).toBe(2);
    expect(s.interval_d).toBe(6);

    const before = s.interval_d;
    s = applyGrade({ state: s, grade: 4, grades: [4, 4, 4], now: NOW });
    expect(s.reps).toBe(3);
    expect(s.interval_d).toBe(Math.round(before * s.ease));
  });

  it('sets next_review to now plus the interval', () => {
    const s = grade(initialMastery(), [4, 4]);
    expect(s.next_review).toBe(daysFrom(NOW, 6).toISOString());
    expect(s.last_seen).toBe(NOW.toISOString());
  });

  it.each([0, 1, 2])('resets the ladder on a failing grade %i', (q) => {
    const passed = grade(initialMastery(), [5, 5, 5]);
    expect(passed.reps).toBe(3);

    const failed = applyGrade({ state: passed, grade: q, grades: [5, 5, 5, q], now: NOW });
    expect(failed.reps).toBe(0);
    expect(failed.interval_d).toBe(1);
    expect(failed.next_review).toBe(daysFrom(NOW, 1).toISOString());
  });

  it.each([3, 4, 5])('advances on a passing grade %i', (q) => {
    const s = grade(initialMastery(), [q]);
    expect(s.reps).toBe(1);
    expect(s.interval_d).toBe(1);
  });

  it('makes a failed concept harder, not just sooner', () => {
    const passed = grade(initialMastery(), [5, 5]);
    const failed = applyGrade({ state: passed, grade: 1, grades: [5, 5, 1], now: NOW });
    expect(failed.ease).toBeLessThan(passed.ease);
  });

  it('clamps out-of-range grades rather than corrupting state', () => {
    const s = applyGrade({ state: initialMastery(), grade: 99, grades: [99], now: NOW });
    expect(s.score).toBe(1);
    expect(s.reps).toBe(1);
  });
});

describe('scoreFromGrades', () => {
  it('is zero with no history', () => {
    expect(scoreFromGrades([])).toBe(0);
  });

  it('is exactly grade/5 for a single attempt', () => {
    expect(scoreFromGrades([5])).toBe(1);
    expect(scoreFromGrades([3])).toBeCloseTo(0.6, 6);
    expect(scoreFromGrades([0])).toBe(0);
  });

  it('weights recent attempts more heavily than old ones', () => {
    const improving = scoreFromGrades([0, 0, 5]);
    const declining = scoreFromGrades([5, 5, 0]);
    expect(improving).toBeGreaterThan(declining);
  });

  it('only considers the last five attempts', () => {
    expect(scoreFromGrades([0, 0, 0, 5, 5, 5, 5, 5])).toBe(scoreFromGrades([5, 5, 5, 5, 5]));
  });

  it('stays within 0..1 for every grade path', () => {
    for (const g of [0, 1, 2, 3, 4, 5]) {
      const s = scoreFromGrades([g, g, g]);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

describe('isKnown', () => {
  it('needs both a high score and repeated success', () => {
    expect(isKnown({ score: 0.95, reps: 1 })).toBe(false);
    expect(isKnown({ score: 0.5, reps: 9 })).toBe(false);
    expect(isKnown({ score: 0.7, reps: 2 })).toBe(true);
  });

  it('is not reached by a single perfect answer', () => {
    expect(isKnown(grade(initialMastery(), [5]))).toBe(false);
    expect(isKnown(grade(initialMastery(), [5, 5]))).toBe(true);
  });
});

describe('decayedScore', () => {
  it('leaves a concept alone before its review date', () => {
    const future = daysFrom(NOW, 3).toISOString();
    expect(decayedScore(0.9, future, NOW)).toBe(0.9);
  });

  it('leaves a never-reviewed concept alone', () => {
    expect(decayedScore(0.9, null, NOW)).toBe(0.9);
  });

  it('costs 0.05 per full overdue week', () => {
    const twoWeeksAgo = daysFrom(NOW, -14).toISOString();
    expect(decayedScore(0.9, twoWeeksAgo, NOW)).toBeCloseTo(0.8, 6);
  });

  it('ignores a partial overdue week', () => {
    const sixDaysAgo = daysFrom(NOW, -6).toISOString();
    expect(decayedScore(0.9, sixDaysAgo, NOW)).toBe(0.9);
  });

  it('stops at the floor however long it is ignored', () => {
    const ancient = daysFrom(NOW, -3650).toISOString();
    expect(decayedScore(1, ancient, NOW)).toBe(DECAY_FLOOR);
  });

  it('never raises a score that was already below the floor', () => {
    const ancient = daysFrom(NOW, -3650).toISOString();
    expect(decayedScore(0.1, ancient, NOW)).toBe(0.1);
  });

  it('is a read-time view — the input state is untouched', () => {
    const state = grade(initialMastery(), [5, 5]);
    const snapshot = { ...state };
    decayedScore(state.score, state.next_review, daysFrom(NOW, 400));
    expect(state).toEqual(snapshot);
  });
});

describe('isDue', () => {
  it('is due once the review date has passed', () => {
    expect(isDue(daysFrom(NOW, -1).toISOString(), NOW)).toBe(true);
    expect(isDue(daysFrom(NOW, 1).toISOString(), NOW)).toBe(false);
    expect(isDue(null, NOW)).toBe(false);
  });
});

describe('nextTierToAsk', () => {
  it('starts at the concept tier when never attempted', () => {
    expect(nextTierToAsk({ conceptTier: 3 })).toBe(3);
  });

  it('escalates when the learner nails it', () => {
    expect(nextTierToAsk({ conceptTier: 2, lastDifficulty: 2, lastGrade: 5, score: 0.8 })).toBe(3);
  });

  it('does not escalate on a good answer from a shaky learner', () => {
    expect(nextTierToAsk({ conceptTier: 2, lastDifficulty: 2, lastGrade: 5, score: 0.4 })).toBe(2);
  });

  it('drops a tier after a poor answer', () => {
    expect(nextTierToAsk({ conceptTier: 4, lastDifficulty: 4, lastGrade: 1, score: 0.5 })).toBe(3);
  });

  it('holds on a middling answer', () => {
    expect(nextTierToAsk({ conceptTier: 2, lastDifficulty: 3, lastGrade: 3, score: 0.6 })).toBe(3);
  });

  it('clamps to 1..5 at both ends', () => {
    expect(nextTierToAsk({ conceptTier: 5, lastDifficulty: 5, lastGrade: 5, score: 1 })).toBe(5);
    expect(nextTierToAsk({ conceptTier: 1, lastDifficulty: 1, lastGrade: 0, score: 0 })).toBe(1);
  });
});

describe('suggestedTier', () => {
  it('starts at 1 for a learner who knows nothing yet', () => {
    expect(suggestedTier([])).toBe(1);
  });

  it('is the median of what is known', () => {
    expect(suggestedTier([1, 2, 3])).toBe(2);
    expect(suggestedTier([1, 1, 4, 4])).toBe(3);
    expect(suggestedTier([5, 5, 5])).toBe(5);
  });
});
