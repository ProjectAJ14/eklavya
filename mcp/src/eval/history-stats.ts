/**
 * What a real answer history says about the promises the product makes.
 *
 * The question-quality eval next door measures questions before anyone answers
 * them. This measures what happened after: it reads an actual `knowledge.db`
 * and asks whether the claims hold on it.
 *
 * Three, in the order they matter:
 *
 * 1. **The repeat rate.** *Never the same question twice* is the promise the
 *    whole tool rests on, and it is the one claim measurable today with no new
 *    harness. If it is not kept, nothing else here is worth reading.
 * 2. **Tier calibration.** Tiers 1-5 are supposed to be a difficulty ladder. If
 *    grades do not fall as tiers rise, the ladder is decoration.
 * 3. **Whether anything survives a gap.** Not retention -- that needs a study
 *    with people in it -- but the weakest honest version: when a concept came
 *    back days later, did the answer hold.
 *
 * Pure, like `srs.ts`: rows in, numbers out, no database handle and no clock
 * beyond what the rows carry. Aggregates only, and deliberately so -- nothing
 * here returns question or answer text, because the output is written to a file
 * that gets committed and the repo rule is that a learner's data never is.
 */
import { questionFingerprint } from '../store.js';

export interface AttemptRow {
  id: number;
  concept_id: number;
  question: string;
  grade: number;
  /** The tier the question was asked at. Column is named `difficulty`. */
  difficulty: number;
  outcome: string | null;
  ts: string;
}

/**
 * How far back the product itself looks for a repeat.
 *
 * `hasAskedQuestion` in `store.ts` fingerprints the last 20 attempts on a
 * concept and no further. That is a deliberate bound, not an oversight -- but it
 * means a repeat older than the window is a *design limit* rather than a broken
 * promise, and reporting the two as one number would be dishonest in whichever
 * direction happened to flatter.
 */
export const REPEAT_WINDOW = 20;

export interface RepeatStats {
  attempts: number;
  concepts: number;
  /**
   * Attempts that had any earlier attempt on the same concept, and so were the
   * only ones that *could* have repeated.
   *
   * The honest denominator. Dividing repeats by all attempts flatters the
   * number badly on a young history: a run of 62 attempts spread over 56
   * concepts has only six chances to break the promise, and reporting "0 of 62"
   * claims 62 opportunities that never existed.
   */
  repeatable: number;
  /** Attempts whose stem had already been asked on that concept. */
  repeats: number;
  /** Of those, the ones the product's own check should have caught. */
  withinWindow: number;
  /** Of those, the ones older than the window it looks at. */
  outsideWindow: number;
  /** Highest number of attempts sharing one fingerprint, for context. */
  worstRun: number;
}

export function repeatStats(rows: AttemptRow[]): RepeatStats {
  const byConcept = new Map<number, AttemptRow[]>();
  for (const row of rows) {
    const list = byConcept.get(row.concept_id);
    if (list) list.push(row);
    else byConcept.set(row.concept_id, [row]);
  }

  let repeats = 0;
  let repeatable = 0;
  let withinWindow = 0;
  let worstRun = 0;

  for (const list of byConcept.values()) {
    const ordered = [...list].sort((a, b) => a.id - b.id);
    const seen: string[] = [];
    const counts = new Map<string, number>();

    for (const [index, row] of ordered.entries()) {
      if (index > 0) repeatable++;
      const print = questionFingerprint(row.question);
      // An empty fingerprint is not evidence of anything -- it means the stem
      // was blank or punctuation only, which the product also refuses to match.
      if (print) {
        const previous = seen.lastIndexOf(print);
        if (previous >= 0) {
          repeats++;
          // Distance in attempts on this concept, which is the same span
          // `hasAskedQuestion` was looking at when the repeat was allowed.
          if (seen.length - previous <= REPEAT_WINDOW) withinWindow++;
        }
        const n = (counts.get(print) ?? 0) + 1;
        counts.set(print, n);
        if (n > worstRun) worstRun = n;
      }
      seen.push(print);
    }
  }

  return {
    attempts: rows.length,
    concepts: byConcept.size,
    repeatable,
    repeats,
    withinWindow,
    outsideWindow: repeats - withinWindow,
    worstRun,
  };
}

export interface TierRow {
  tier: number;
  attempts: number;
  meanGrade: number;
  /** Share grading 3 or better. */
  passRate: number;
}

export interface TierStats {
  rows: TierRow[];
  /**
   * Whether mean grade falls, or at least does not rise, as the tier rises.
   *
   * The weakest form of the claim on purpose. With a few dozen attempts,
   * "strictly decreasing" would fail on noise and tell nobody anything.
   */
  monotonic: boolean;
  /** Attempts left out because a decline says nothing about knowing. */
  excludedDeclines: number;
}

export function tierStats(rows: AttemptRow[]): TierStats {
  // A decline is recorded as grade 0 and means "not now", not "did not know".
  // Averaging it in would make any tier the developer happened to skip look
  // harder than it is.
  const graded = rows.filter((r) => r.outcome !== 'declined');
  const byTier = new Map<number, AttemptRow[]>();
  for (const row of graded) {
    const list = byTier.get(row.difficulty);
    if (list) list.push(row);
    else byTier.set(row.difficulty, [row]);
  }

  const out: TierRow[] = [...byTier.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tier, list]) => ({
      tier,
      attempts: list.length,
      meanGrade: list.reduce((n, r) => n + r.grade, 0) / list.length,
      passRate: list.filter((r) => r.grade >= 3).length / list.length,
    }));

  let monotonic = true;
  for (let i = 1; i < out.length; i++) {
    if ((out[i]?.meanGrade ?? 0) > (out[i - 1]?.meanGrade ?? 0)) monotonic = false;
  }

  return { rows: out, monotonic, excludedDeclines: rows.length - graded.length };
}

export interface GapStats {
  /** Minimum days between two attempts on one concept for the pair to count. */
  minDays: number;
  pairs: number;
  /** Pairs whose later attempt graded 3 or better. */
  held: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Consecutive attempts on the same concept separated by at least `minDays`.
 *
 * Consecutive, not all-pairs: counting every combination would weight a concept
 * asked five times far above one asked twice, and the question being asked is
 * "did it hold across a gap", once per gap.
 */
export function gapStats(rows: AttemptRow[], minDays = 1): GapStats {
  const byConcept = new Map<number, AttemptRow[]>();
  for (const row of rows) {
    const list = byConcept.get(row.concept_id);
    if (list) list.push(row);
    else byConcept.set(row.concept_id, [row]);
  }

  let pairs = 0;
  let held = 0;

  for (const list of byConcept.values()) {
    const ordered = [...list]
      .filter((r) => r.outcome !== 'declined')
      .sort((a, b) => a.id - b.id);

    for (let i = 1; i < ordered.length; i++) {
      const before = ordered[i - 1];
      const after = ordered[i];
      if (!before || !after) continue;
      const gap = Date.parse(after.ts.replace(' ', 'T')) - Date.parse(before.ts.replace(' ', 'T'));
      if (!Number.isFinite(gap) || gap < minDays * DAY_MS) continue;
      pairs++;
      if (after.grade >= 3) held++;
    }
  }

  return { minDays, pairs, held };
}

export interface OutcomeStats {
  answered: number;
  dontKnow: number;
  declined: number;
  /** Rows written before `outcome` existed, so genuinely unknown. */
  unrecorded: number;
}

export function outcomeStats(rows: AttemptRow[]): OutcomeStats {
  const count = (o: string) => rows.filter((r) => r.outcome === o).length;
  return {
    answered: count('answered'),
    dontKnow: count('dont_know'),
    declined: count('declined'),
    unrecorded: rows.filter((r) => r.outcome == null).length,
  };
}
