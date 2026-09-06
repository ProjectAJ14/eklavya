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

/**
 * How many previous questions the *planner* puts in front of the tutor.
 *
 * `get_session_quiz_plan` fills each item's `asked_before` from
 * `recentQuestions(db, concept.id, ASKED_HISTORY)` with ASKED_HISTORY = 3. That
 * is the mechanism that actually prevents a repeat, because it acts while the
 * question is being written.
 *
 * `REPEAT_WINDOW` above is a different thing and a weaker one: `hasAskedQuestion`
 * is consulted by `record_attempt` *after* the question was asked, and it does
 * not reject anything -- it records the attempt and returns `repeat_question:
 * true`. Calling a repeat at distance 4-20 "one the product should have caught"
 * credits a check that never saw it. Both numbers are reported, separately.
 */
export const PLANNER_HISTORY = 3;

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
  /**
   * Repeats the planner had in front of it: the earlier question was among the
   * `PLANNER_HISTORY` most recent on that concept, so `asked_before` carried it
   * while the new question was being written. These are broken promises.
   */
  plannerSaw: number;
  /**
   * Repeats the recorder would have flagged but the planner never showed:
   * further back than `PLANNER_HISTORY`, within `REPEAT_WINDOW`. The attempt is
   * still recorded; `record_attempt` only returns `repeat_question: true`.
   */
  recorderOnly: number;
  /** Older than either window, so outside everything the product inspects. */
  outsideBoth: number;
  /**
   * The most attempts on a single concept sharing one fingerprint, for context.
   * Counted per concept, and not necessarily consecutive.
   */
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
  let plannerSaw = 0;
  let recorderOnly = 0;
  let worstRun = 0;

  for (const list of byConcept.values()) {
    const ordered = [...list].sort((a, b) => a.id - b.id);
    const seen: string[] = [];
    const counts = new Map<string, number>();

    for (const [index, row] of ordered.entries()) {
      const print = questionFingerprint(row.question);
      // An empty fingerprint is not evidence of anything -- it means the stem
      // was blank or punctuation only, which the product also refuses to match.
      // It cannot count as a repeat, so it must not swell the denominator
      // either; that error would run in the flattering direction.
      if (print) {
        if (index > 0) repeatable++;

        // lastIndexOf, not indexOf: what matters is how far back the NEAREST
        // earlier copy was, since that is the one both windows would have held.
        // Taking the oldest copy under-reports repeats the product could see.
        const previous = seen.lastIndexOf(print);
        if (previous >= 0) {
          repeats++;
          const distance = seen.length - previous;
          if (distance <= PLANNER_HISTORY) plannerSaw++;
          else if (distance <= REPEAT_WINDOW) recorderOnly++;
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
    plannerSaw,
    recorderOnly,
    outsideBoth: repeats - plannerSaw - recorderOnly,
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
  /** Which rows this reading kept. */
  basis: 'all-graded' | 'known-outcome';
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
  /**
   * Attempts left out because their outcome predates the `outcome` column.
   *
   * Zero in the `all-graded` reading, which keeps them.
   */
  excludedUnknown: number;
}

/**
 * Both readings, because the data cannot choose between them.
 *
 * `migrations/004_attempt_outcome.sql` states the contract: NULL means
 * "recorded before this column existed", and readers "must treat it as unknown,
 * not as any particular outcome". Keeping those rows counts a grade 0 of unknown
 * provenance as evidence the learner did not know; dropping them throws away
 * real answers. On the first published history the choice moved tier 2 from
 * mean 2.25 to 3.10 -- from below the pass threshold to above it -- and changed
 * which tier scored worst.
 *
 * A single number there would have been a choice presented as a measurement, so
 * both are reported and the result file has to show both.
 */
export function tierReadings(rows: AttemptRow[]): { allGraded: TierStats; knownOutcome: TierStats } {
  return {
    allGraded: tierStats(rows, true),
    knownOutcome: tierStats(rows, false),
  };
}

export function tierStats(rows: AttemptRow[], includeUnknownOutcome = true): TierStats {
  // A decline is recorded as grade 0 and means "not now", not "did not know".
  // Averaging it in would make any tier the developer happened to skip look
  // harder than it is.
  const notDeclined = rows.filter((r) => r.outcome !== 'declined');
  const graded = includeUnknownOutcome ? notDeclined : notDeclined.filter((r) => r.outcome != null);
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

  return {
    basis: includeUnknownOutcome ? 'all-graded' : 'known-outcome',
    rows: out,
    monotonic,
    excludedDeclines: rows.length - notDeclined.length,
    excludedUnknown: notDeclined.length - graded.length,
  };
}

export interface GapStats {
  /** Minimum days between two attempts on one concept for the pair to count. */
  minDays: number;
  /**
   * Gaps where the earlier attempt actually passed, so there was something to
   * survive.
   *
   * The first published run reported "0 of 1 held" on a pair whose earlier
   * attempt was a grade 0 of unknown outcome -- two failures nine days apart,
   * described as a thing that failed to hold. Nothing had been held.
   */
  pairs: number;
  /** Of those, the ones whose later attempt graded 3 or better. */
  held: number;
  /** Gaps skipped because the earlier attempt had not passed either. */
  skippedNoPriorPass: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `ts` is written by SQLite's `datetime('now')`, which is UTC with no zone
 * marker. `Date.parse('2026-09-01 10:00:00')` reads that as local time, so on a
 * machine at UTC+5:30 every timestamp shifts and a gap near the threshold lands
 * on the wrong side of it.
 */
function parseTs(ts: string): number {
  return Date.parse(`${ts.replace(' ', 'T')}Z`);
}

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
  let skippedNoPriorPass = 0;

  for (const list of byConcept.values()) {
    // Ordered over EVERY attempt, declines included. Filtering them out first
    // makes two attempts either side of a skipped one look consecutive, so a
    // concept the learner saw three times reports one long quiet gap it never
    // had. Declines are skipped as the *later* member below instead.
    const ordered = [...list].sort((a, b) => a.id - b.id);

    for (let i = 1; i < ordered.length; i++) {
      const before = ordered[i - 1];
      const after = ordered[i];
      if (!before || !after) continue;
      if (after.outcome === 'declined') continue;

      // `datetime('now')` writes UTC without a zone; treat it as UTC rather than
      // letting Date.parse guess local, which shifts every gap by the offset.
      const gap = parseTs(after.ts) - parseTs(before.ts);
      if (!Number.isFinite(gap) || gap < minDays * DAY_MS) continue;

      if (before.grade < 3) {
        skippedNoPriorPass++;
        continue;
      }
      pairs++;
      if (after.grade >= 3) held++;
    }
  }

  return { minDays, pairs, held, skippedNoPriorPass };
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
