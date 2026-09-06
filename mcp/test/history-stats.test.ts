import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  repeatStats,
  tierStats,
  tierReadings,
  gapStats,
  outcomeStats,
  REPEAT_WINDOW,
  PLANNER_HISTORY,
  type AttemptRow,
} from '../src/eval/history-stats.js';

const srcDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src');

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
    expect(s.plannerSaw).toBe(1);
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
    expect(s.plannerSaw).toBe(0);
    expect(s.recorderOnly).toBe(0);
    expect(s.outsideBoth).toBe(1);
  });

  it('separates what the planner had in front of it from what only the recorder saw', () => {
    // The planner fills asked_before from the last PLANNER_HISTORY questions,
    // and that is what actually prevents a repeat. hasAskedQuestion looks back
    // REPEAT_WINDOW but only reports -- record_attempt writes the row anyway.
    const at = (distance: number) => {
      const rows = [attempt({ question: 'the stem' })];
      for (let i = 0; i < distance - 1; i++) rows.push(attempt({ question: `filler ${i}` }));
      rows.push(attempt({ question: 'the stem' }));
      return repeatStats(rows);
    };
    expect(at(PLANNER_HISTORY)).toMatchObject({ plannerSaw: 1, recorderOnly: 0, outsideBoth: 0 });
    expect(at(PLANNER_HISTORY + 1)).toMatchObject({ plannerSaw: 0, recorderOnly: 1, outsideBoth: 0 });
    expect(at(REPEAT_WINDOW)).toMatchObject({ plannerSaw: 0, recorderOnly: 1, outsideBoth: 0 });
    expect(at(REPEAT_WINDOW + 1)).toMatchObject({ plannerSaw: 0, recorderOnly: 0, outsideBoth: 1 });
  });

  it('takes the nearest earlier copy, not the oldest', () => {
    // With three copies where the oldest is out of every window and a newer one
    // is inside it, indexOf would report the repeat as unseen -- an error in the
    // direction that flatters the tool.
    const rows = [attempt({ question: 'the stem' })];
    for (let i = 0; i < REPEAT_WINDOW; i++) rows.push(attempt({ question: `filler ${i}` }));
    rows.push(attempt({ question: 'the stem' }));
    rows.push(attempt({ question: 'the stem' }));

    const s = repeatStats(rows);
    expect(s.repeats).toBe(2);
    expect(s.plannerSaw).toBe(1);
    expect(s.outsideBoth).toBe(1);
  });

  it('pins both windows to the code they describe', () => {
    // These constants are copies of numbers that live in other files. If either
    // moves and this does not, every repeat is filed under the wrong mechanism
    // and nothing fails.
    expect(fs.readFileSync(path.join(srcDir, 'store.ts'), 'utf8')).toContain(
      'ORDER BY id DESC LIMIT 20',
    );
    expect(REPEAT_WINDOW).toBe(20);
    expect(fs.readFileSync(path.join(srcDir, 'tools', 'get_session_quiz_plan.ts'), 'utf8')).toContain(
      'const ASKED_HISTORY = 3',
    );
    expect(PLANNER_HISTORY).toBe(3);
  });

  it('does not count an empty fingerprint toward the denominator either', () => {
    const s = repeatStats([attempt({ question: 'real stem' }), attempt({ question: '???' })]);
    expect(s.repeatable).toBe(0);
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

  it('reports both readings, because the data cannot choose between them', () => {
    // migrations/004 says a NULL outcome must be treated as unknown, not as any
    // particular outcome. Keeping those rows counts a grade 0 of unknown
    // provenance as evidence of not knowing; dropping them discards real
    // answers. On the first published history this moved tier 2 from 2.25 to
    // 3.10 -- across the pass threshold -- so a single number would have been a
    // choice presented as a measurement.
    const rows = [
      attempt({ difficulty: 2, grade: 4, outcome: 'answered' }),
      attempt({ difficulty: 2, grade: 0, outcome: null }),
    ];
    const { allGraded, knownOutcome } = tierReadings(rows);

    expect(allGraded.basis).toBe('all-graded');
    expect(allGraded.rows[0]).toMatchObject({ attempts: 2, meanGrade: 2 });
    expect(allGraded.excludedUnknown).toBe(0);

    expect(knownOutcome.basis).toBe('known-outcome');
    expect(knownOutcome.rows[0]).toMatchObject({ attempts: 1, meanGrade: 4 });
    expect(knownOutcome.excludedUnknown).toBe(1);
  });

  it('treats a flat tier as monotonic, which is what the doc comment promises', () => {
    // "falls, or at least does not rise" -- equal means must pass, or the
    // weakest form of the claim is not the one being tested.
    const flat = tierStats([
      attempt({ difficulty: 1, grade: 3 }),
      attempt({ difficulty: 2, grade: 3 }),
    ]);
    expect(flat.monotonic).toBe(true);
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
  it('counts a concept that passed, came back a day later, and passed again', () => {
    const s = gapStats([
      attempt({ concept_id: 7, grade: 4, ts: '2026-09-01 10:00:00' }),
      attempt({ concept_id: 7, grade: 4, ts: '2026-09-03 10:00:00' }),
    ]);
    expect(s).toMatchObject({ pairs: 1, held: 1 });
  });

  it('skips a gap where nothing had been held in the first place', () => {
    // The first published run reported "0 of 1 held" on exactly this shape: a
    // grade 0 nine days before a grade 2. Two failures, not decay -- and the
    // metric is named for what survived.
    const s = gapStats([
      attempt({ concept_id: 7, grade: 0, ts: '2026-09-01 10:00:00' }),
      attempt({ concept_id: 7, grade: 2, ts: '2026-09-10 10:00:00' }),
    ]);
    expect(s).toMatchObject({ pairs: 0, held: 0, skippedNoPriorPass: 1 });
  });

  it('counts a pass that later failed as a gap that did not hold', () => {
    const s = gapStats([
      attempt({ concept_id: 7, grade: 4, ts: '2026-09-01 10:00:00' }),
      attempt({ concept_id: 7, grade: 1, ts: '2026-09-10 10:00:00' }),
    ]);
    expect(s).toMatchObject({ pairs: 1, held: 0 });
  });

  it('pins the pass threshold, which is what "held" means', () => {
    const later = (grade: number) =>
      gapStats([
        attempt({ concept_id: 7, grade: 4, ts: '2026-09-01 10:00:00' }),
        attempt({ concept_id: 7, grade, ts: '2026-09-10 10:00:00' }),
      ]).held;
    expect(later(2)).toBe(0);
    expect(later(3)).toBe(1);
  });

  it('reads the stored timestamp as UTC, which is what SQLite wrote', () => {
    // datetime('now') has no zone marker. Parsing it as local time shifts every
    // gap by the machine's offset, which moves a near-threshold pair across it.
    const s = gapStats([
      attempt({ concept_id: 7, grade: 4, ts: '2026-09-01 00:00:00' }),
      attempt({ concept_id: 7, grade: 4, ts: '2026-09-02 00:00:01' }),
    ]);
    expect(s.pairs).toBe(1);
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

  it('does not let a skipped decline stitch two attempts into one long gap', () => {
    // Filtering declines before pairing made these look consecutive, so a
    // concept the learner was shown three times reported one quiet six-day gap
    // it never had.
    const s = gapStats([
      attempt({ concept_id: 7, grade: 4, ts: '2026-09-01 10:00:00' }),
      attempt({ concept_id: 7, grade: 0, outcome: 'declined', ts: '2026-09-04 10:00:00' }),
      attempt({ concept_id: 7, grade: 4, ts: '2026-09-07 10:00:00' }),
    ]);
    // The surviving pair is decline -> answer, whose earlier member never
    // passed, so nothing is claimed to have survived anything.
    expect(s).toMatchObject({ pairs: 0, skippedNoPriorPass: 1 });
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
