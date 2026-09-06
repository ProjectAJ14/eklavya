import { describe, it, expect } from 'vitest';
import {
  repeatStats,
  tierStats,
  gapStats,
  outcomeStats,
  REPEAT_WINDOW,
  type AttemptRow,
} from '../src/eval/history-stats.js';

let nextId = 1;
function attempt(over: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: nextId++,
    concept_id: 1,
    question: `Question number ${nextId}?`,
    grade: 4,
    difficulty: 2,
    outcome: 'answered',
    ts: '2026-09-01 10:00:00',
    ...over,
  };
}

describe('repeatStats', () => {
  it('counts a stem asked twice on the same concept', () => {
    const s = repeatStats([
      attempt({ question: 'Why is httpOnly set here?' }),
      attempt({ question: 'Why is httpOnly set here?' }),
    ]);
    expect(s.repeats).toBe(1);
    expect(s.withinWindow).toBe(1);
    expect(s.worstRun).toBe(2);
  });

  it('uses the product own fingerprint, so punctuation and case are not a new question', () => {
    // If this ever diverges from store.ts the measurement stops describing the
    // product, which is the only reason it imports from there.
    const s = repeatStats([
      attempt({ question: 'Why is httpOnly set here?' }),
      attempt({ question: '  why is HTTPONLY set here!!  ' }),
    ]);
    expect(s.repeats).toBe(1);
  });

  it('does not count the same stem on a different concept', () => {
    const s = repeatStats([
      attempt({ concept_id: 1, question: 'What does this flag do?' }),
      attempt({ concept_id: 2, question: 'What does this flag do?' }),
    ]);
    expect(s.repeats).toBe(0);
    expect(s.concepts).toBe(2);
  });

  it('separates repeats the product should have caught from ones outside its window', () => {
    // hasAskedQuestion only fingerprints the last 20 attempts on a concept. A
    // repeat older than that is a stated design limit; a repeat inside it is a
    // broken promise. Reporting them as one number would flatter or damn the
    // tool depending only on which happened.
    const rows = [attempt({ question: 'the original stem' })];
    for (let i = 0; i < REPEAT_WINDOW; i++) rows.push(attempt({ question: `filler ${i}` }));
    rows.push(attempt({ question: 'the original stem' }));

    const s = repeatStats(rows);
    expect(s.repeats).toBe(1);
    expect(s.withinWindow).toBe(0);
    expect(s.outsideWindow).toBe(1);
  });

  it('counts a repeat exactly at the window edge as one the product saw', () => {
    const rows = [attempt({ question: 'edge stem' })];
    for (let i = 0; i < REPEAT_WINDOW - 1; i++) rows.push(attempt({ question: `filler ${i}` }));
    rows.push(attempt({ question: 'edge stem' }));
    expect(repeatStats(rows).withinWindow).toBe(1);
  });

  it('counts only the attempts that could have repeated', () => {
    // The honest denominator. A history of one attempt each on many concepts
    // has almost no chance to break the promise, and dividing by every attempt
    // claims opportunities that never existed.
    const s = repeatStats([
      attempt({ concept_id: 1 }),
      attempt({ concept_id: 2 }),
      attempt({ concept_id: 3 }),
      attempt({ concept_id: 3 }),
    ]);
    expect(s.attempts).toBe(4);
    expect(s.repeatable).toBe(1);
  });

  it('ignores an empty fingerprint rather than matching every blank to every other', () => {
    const s = repeatStats([attempt({ question: '???' }), attempt({ question: '!!!' })]);
    expect(s.repeats).toBe(0);
  });

  it('orders by id, not by array position', () => {
    const later = attempt({ id: 99, question: 'same stem' });
    const earlier = attempt({ id: 1, question: 'same stem' });
    expect(repeatStats([later, earlier]).repeats).toBe(1);
  });
});

describe('tierStats', () => {
  it('reports mean grade and pass rate per tier', () => {
    const s = tierStats([
      attempt({ difficulty: 1, grade: 4 }),
      attempt({ difficulty: 1, grade: 2 }),
      attempt({ difficulty: 3, grade: 1 }),
    ]);
    expect(s.rows[0]).toMatchObject({ tier: 1, attempts: 2, meanGrade: 3, passRate: 0.5 });
    expect(s.rows[1]).toMatchObject({ tier: 3, attempts: 1, meanGrade: 1, passRate: 0 });
  });

  it('leaves declines out, because a decline is not evidence of not knowing', () => {
    // Grade 0 with outcome declined means "not now". Averaging it in makes any
    // tier the developer happened to skip look harder than it is.
    const s = tierStats([
      attempt({ difficulty: 4, grade: 4 }),
      attempt({ difficulty: 4, grade: 0, outcome: 'declined' }),
    ]);
    expect(s.rows[0]).toMatchObject({ tier: 4, attempts: 1, meanGrade: 4 });
    expect(s.excludedDeclines).toBe(1);
  });

  it('keeps a blank, which is evidence of not knowing', () => {
    const s = tierStats([
      attempt({ difficulty: 4, grade: 4 }),
      attempt({ difficulty: 4, grade: 0, outcome: 'dont_know' }),
    ]);
    expect(s.rows[0]).toMatchObject({ attempts: 2, meanGrade: 2 });
  });

  it('says whether grades fall as tiers rise', () => {
    const falling = tierStats([
      attempt({ difficulty: 1, grade: 5 }),
      attempt({ difficulty: 2, grade: 3 }),
      attempt({ difficulty: 3, grade: 1 }),
    ]);
    expect(falling.monotonic).toBe(true);

    const rising = tierStats([
      attempt({ difficulty: 1, grade: 1 }),
      attempt({ difficulty: 2, grade: 4 }),
    ]);
    expect(rising.monotonic).toBe(false);
  });
});

describe('gapStats', () => {
  it('counts a concept that came back a day later and held', () => {
    const s = gapStats([
      attempt({ concept_id: 7, grade: 2, ts: '2026-09-01 10:00:00' }),
      attempt({ concept_id: 7, grade: 4, ts: '2026-09-03 10:00:00' }),
    ]);
    expect(s).toMatchObject({ pairs: 1, held: 1 });
  });

  it('ignores two attempts in the same sitting', () => {
    const s = gapStats([
      attempt({ concept_id: 7, ts: '2026-09-01 10:00:00' }),
      attempt({ concept_id: 7, ts: '2026-09-01 10:20:00' }),
    ]);
    expect(s.pairs).toBe(0);
  });

  it('counts consecutive gaps only, so a much-asked concept does not dominate', () => {
    const s = gapStats([
      attempt({ concept_id: 7, ts: '2026-09-01 10:00:00' }),
      attempt({ concept_id: 7, ts: '2026-09-03 10:00:00' }),
      attempt({ concept_id: 7, ts: '2026-09-05 10:00:00' }),
    ]);
    // Three attempts, two gaps -- not the three pairs an all-pairs count gives.
    expect(s.pairs).toBe(2);
  });

  it('does not treat a decline as a failure to remember', () => {
    const s = gapStats([
      attempt({ concept_id: 7, ts: '2026-09-01 10:00:00' }),
      attempt({ concept_id: 7, grade: 0, outcome: 'declined', ts: '2026-09-04 10:00:00' }),
    ]);
    expect(s.pairs).toBe(0);
  });
});

describe('outcomeStats', () => {
  it('keeps rows written before the column existed separate from known outcomes', () => {
    const s = outcomeStats([
      attempt({ outcome: 'answered' }),
      attempt({ outcome: 'dont_know' }),
      attempt({ outcome: 'declined' }),
      attempt({ outcome: null }),
    ]);
    expect(s).toEqual({ answered: 1, dontKnow: 1, declined: 1, unrecorded: 1 });
  });
});
