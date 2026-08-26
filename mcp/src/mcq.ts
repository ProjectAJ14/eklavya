/**
 * Where the correct option goes in a multiple-choice question.
 *
 * This is decided server-side, for the same reason `tier_to_ask` and
 * `format_to_use` are: left to the model, it is not decided at all. An LLM asked
 * to "vary the position" reliably puts the right answer first — it writes the
 * answer it is thinking of, then invents distractors after it — so learners
 * discover within a handful of questions that A is always correct and stop
 * reading the options. The quiz keeps working and stops measuring anything.
 *
 * Deterministic rather than random: the same question asked twice in a session
 * must not move under the learner, tests need a fixed answer, and a plan is
 * rebuilt on every call. Varying by attempt count is what makes a re-ask of the
 * same concept land somewhere new.
 */

/** FNV-1a, 32-bit. Small, dependency-free, and well spread over short strings. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const MCQ_OPTION_COUNT = 4;

/**
 * 1-based position for the correct option. `askedCount` is how many questions
 * this learner has already been asked about the concept, so a concept that comes
 * back for review does not come back in the same shape.
 */
export function answerPosition(slug: string, askedCount = 0, optionCount = MCQ_OPTION_COUNT): number {
  return (hash(`${slug}:${askedCount}`) % optionCount) + 1;
}
