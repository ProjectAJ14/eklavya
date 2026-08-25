/**
 * SM-2 spaced repetition, mastery scoring and difficulty escalation (PRD §7).
 *
 * Everything here is pure: no database, no clock. `now` is always a parameter so
 * the whole scheduling model is testable without freezing time.
 */

export const MIN_EASE = 1.3;
export const DEFAULT_EASE = 2.5;
export const MASTERY_THRESHOLD = 0.7;
export const MIN_REPS_FOR_KNOWN = 2;

/** Read-time decay (PRD §7): how fast an ignored concept loses credibility, and its floor. */
export const DECAY_PER_WEEK = 0.05;
export const DECAY_FLOOR = 0.3;

/** Score smoothing (phase-1 decision G2). */
export const SCORE_WINDOW = 5;
export const SCORE_ALPHA = 0.6;

export const MS_PER_DAY = 86_400_000;

export interface MasteryState {
  score: number;
  ease: number;
  interval_d: number;
  reps: number;
  last_seen: string | null;
  next_review: string | null;
}

export function initialMastery(): MasteryState {
  return { score: 0, ease: DEFAULT_EASE, interval_d: 0, reps: 0, last_seen: null, next_review: null };
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Recency-weighted mean of the last few grades, normalized to 0..1.
 * A single attempt scores exactly `grade / 5`; older attempts fade at `SCORE_ALPHA`.
 * Alpha is above 0.5 deliberately: at exactly 0.5 the weighting is symmetric, so a
 * learner who is improving would score the same as one who is falling apart.
 */
export function scoreFromGrades(grades: number[]): number {
  const recent = grades.slice(-SCORE_WINDOW);
  if (recent.length === 0) return 0;

  let score = clamp(recent[0]!, 0, 5) / 5;
  for (let i = 1; i < recent.length; i += 1) {
    score = SCORE_ALPHA * (clamp(recent[i]!, 0, 5) / 5) + (1 - SCORE_ALPHA) * score;
  }
  return Number(score.toFixed(6));
}

/**
 * Standard SM-2 ease adjustment. Applied on every grade, not only on passes:
 * getting a concept wrong should make it come back harder, which is the whole
 * point of tracking ease separately from the interval.
 */
export function nextEase(ease: number, grade: number): number {
  const q = clamp(grade, 0, 5);
  const adjusted = ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  return Number(Math.max(MIN_EASE, adjusted).toFixed(6));
}

export interface ApplyGradeInput {
  state: MasteryState;
  grade: number;
  /** Every grade for this concept in chronological order, including the new one. */
  grades: number[];
  now: Date;
}

/** Applies one graded attempt, returning the new mastery state. */
export function applyGrade({ state, grade, grades, now }: ApplyGradeInput): MasteryState {
  const q = clamp(Math.round(grade), 0, 5);
  const ease = nextEase(state.ease, q);

  let reps: number;
  let interval: number;

  if (q >= 3) {
    reps = state.reps + 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.round(state.interval_d * ease);
  } else {
    // A failed recall restarts the ladder — the learner sees it again tomorrow.
    reps = 0;
    interval = 1;
  }

  return {
    score: scoreFromGrades(grades),
    ease,
    interval_d: interval,
    reps,
    last_seen: now.toISOString(),
    next_review: new Date(now.getTime() + interval * MS_PER_DAY).toISOString(),
  };
}

/**
 * Soft decay for concepts whose review date is long past. Computed at read time
 * and never persisted (PRD §7), so an ignored concept resurfaces without its
 * history being rewritten.
 */
export function decayedScore(score: number, nextReview: string | null, now: Date): number {
  if (!nextReview) return score;

  const overdueMs = now.getTime() - Date.parse(nextReview);
  if (!Number.isFinite(overdueMs) || overdueMs <= 0) return score;

  const weeks = Math.floor(overdueMs / (7 * MS_PER_DAY));
  if (weeks <= 0) return score;

  const decayed = score - DECAY_PER_WEEK * weeks;
  // The floor must never *raise* a score that was already below it.
  return Number((decayed < DECAY_FLOOR ? Math.min(score, DECAY_FLOOR) : decayed).toFixed(6));
}

export function isKnown(state: Pick<MasteryState, 'score' | 'reps'>): boolean {
  return state.score >= MASTERY_THRESHOLD && state.reps >= MIN_REPS_FOR_KNOWN;
}

export function isDue(nextReview: string | null, now: Date): boolean {
  if (!nextReview) return false;
  const t = Date.parse(nextReview);
  return Number.isFinite(t) && t <= now.getTime();
}

/**
 * Difficulty escalation (phase-1 decision G3). Tier belongs to the *question*,
 * not the concept: a fundamentals concept gets asked at tier 4 of someone who
 * keeps nailing it, which is how "never ask the same question twice" is honored
 * without running out of concepts.
 */
export function nextTierToAsk(input: {
  conceptTier: number;
  lastDifficulty?: number | null;
  lastGrade?: number | null;
  score?: number;
}): number {
  const { conceptTier, lastDifficulty, lastGrade, score = 0 } = input;

  if (lastDifficulty == null || lastGrade == null) {
    return clamp(Math.round(conceptTier), 1, 5);
  }

  if (lastGrade >= 4 && score >= MASTERY_THRESHOLD) return clamp(lastDifficulty + 1, 1, 5);
  if (lastGrade <= 2) return clamp(lastDifficulty - 1, 1, 5);
  return clamp(lastDifficulty, 1, 5);
}

/** Median tier of what the learner already knows (phase-1 decision G4). */
export function suggestedTier(knownTiers: number[]): number {
  if (knownTiers.length === 0) return 1;
  const sorted = [...knownTiers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return clamp(Math.round(median), 1, 5);
}
