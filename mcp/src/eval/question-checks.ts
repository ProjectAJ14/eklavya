/**
 * The deterministic half of the question-quality eval.
 *
 * Eklavya's claim is that the developer learns, and until now nothing measured
 * it: the suite next door tests SM-2 arithmetic, plan sizing, gate maths and
 * migrations -- the machinery -- while the product is a question, and whether a
 * question is any good was checked by nobody.
 *
 * These are the checks that need no model. That matters more than it sounds:
 * an LLM judge is soft, costs money, disagrees with itself between runs, and is
 * biased toward output from its own family. Everything that can be settled by
 * counting is settled here instead, for free and reproducibly, and the judge is
 * left with only the three questions that genuinely need reading comprehension
 * (see `eval/README.md`).
 *
 * Pure, like `srs.ts`: no database, no clock, no file reads. A check returns
 * what it found, never a fix.
 */

/** One generated question, paired with the plan item it was generated from. */
export interface GeneratedQuestion {
  /** The fixture it came from, for reporting. */
  fixture: string;
  /** The concept the plan chose. */
  slug: string;
  /** The tier the plan asked for. */
  tier_to_ask: number;
  /** The slot, 1-4, the plan told the model to put the answer in. */
  answer_position: number;
  stem: string;
  /** Exactly four option labels, in the order they were shown. */
  options: string[];
  /** Which of those four the model says is correct, 1-4. */
  correct: number;
}

export interface Check {
  id: string;
  ok: boolean;
  /** What was found, always -- a passing check still says what it measured. */
  detail: string;
}

/** Words, for length checks. Punctuation-only tokens do not count. */
function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

function normalized(text: string): string[] {
  return words(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' '));
}

/**
 * The longest run of consecutive words the two strings share.
 *
 * Used for "the answer is not restated in the stem". A bag-of-words overlap
 * would fire on every question, because a stem is *supposed* to share its
 * subject with the answer -- "httpOnly" appears in both by design. A shared
 * four-word run is a different thing: that is the sentence, not the subject.
 */
export function longestSharedRun(a: string, b: string): number {
  const x = normalized(a);
  const y = normalized(b);
  if (x.length === 0 || y.length === 0) return 0;

  // Classic LCS-of-substrings table. Both inputs are one sentence, so the
  // quadratic cost is a few thousand operations.
  let best = 0;
  const prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= y.length; j++) {
      const above = prev[j] ?? 0;
      const run = x[i - 1] === y[j - 1] ? diagonal + 1 : 0;
      diagonal = above;
      prev[j] = run;
      if (run > best) best = run;
    }
  }
  return best;
}

/** Stems this long stop being read and start being pattern-matched. */
export const STEM_WORD_LIMIT = 25;

/** A shared run this long means the stem contains the answer's sentence. */
export const ANSWER_RUN_LIMIT = 4;

/**
 * Ratio between the longest and shortest option. Four options of visibly
 * different length leak the answer through shape alone, whichever one is
 * correct.
 */
export const OPTION_RATIO_LIMIT = 2.5;

/**
 * How many words longer the correct option may be than the next-longest before
 * the length itself is a hint. Below this it is noise; a reader does not count
 * words, they see a shape.
 */
export const LENGTH_MARGIN_WORDS = 3;

/**
 * Negation that makes a stem a reading test.
 *
 * Deliberately narrow. A plain "not" is often legitimate and contrastive --
 * "why is this set on the refresh cookie but not on the access token" is a good
 * stem -- so flagging every "not" would flag good questions and train whoever
 * reads the report to ignore it. These three forms are the ones that turn the
 * question itself inside out.
 */
const NEGATED_STEM = [
  /\bwhich\b[^?]*\bis\s+not\b/i,
  /\bwhich\b[^?]*\bdoes\s+not\b/i,
  /\bexcept\b/i,
];

/** The tool renders the labels; a stem that numbers them is showing them twice. */
const NUMBERED_IN_STEM = /(^|\s)(?:[a-d]\)|\(?[1-4][).]\s)/im;

export function checkQuestion(q: GeneratedQuestion): Check[] {
  const checks: Check[] = [];
  const push = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

  const labels = q.options.map((o) => o.trim()).filter((o) => o.length > 0);
  const unique = new Set(labels.map((o) => o.toLowerCase()));
  push(
    'four_options',
    labels.length === 4 && unique.size === 4,
    `${labels.length} non-empty option(s), ${unique.size} distinct`,
  );

  // The obedience check, and the reason the whole harness drives the real
  // planner rather than inventing plan items: `answer_position` is assigned
  // server-side by a hash so the answer cannot cluster, and that only works if
  // the model actually puts it there.
  const obeyed = q.correct === q.answer_position;
  push(
    'answer_at_position',
    obeyed,
    obeyed
      ? `correct option at ${q.answer_position}, as asked`
      : `plan said ${q.answer_position}, model used ${q.correct}`,
  );

  const stemWords = words(q.stem).length;
  push('stem_length', stemWords <= STEM_WORD_LIMIT, `${stemWords} words (limit ${STEM_WORD_LIMIT})`);

  const correct = q.options[q.correct - 1] ?? '';
  const run = longestSharedRun(q.stem, correct);
  push(
    'answer_not_in_stem',
    run < ANSWER_RUN_LIMIT,
    `longest run shared with the correct option: ${run} word(s)`,
  );

  const lengths = labels.map((o) => words(o).length);
  const longest = Math.max(...lengths, 0);
  const shortest = Math.min(...lengths, Infinity);
  const ratio = shortest > 0 ? longest / shortest : Infinity;
  push(
    'option_parity',
    ratio <= OPTION_RATIO_LIMIT,
    `longest/shortest = ${ratio.toFixed(2)} (limit ${OPTION_RATIO_LIMIT})`,
  );

  // Separate from parity on purpose. Four options can sit inside the ratio and
  // the correct one still stand out, which is the tell a learner notices first:
  // pick the most careful-sounding answer without reading it.
  //
  // The margin is why this is not simply "is it the longest". The first live
  // run flagged all three questions, and all three were the correct option
  // beating the next by two words -- 17 against 15, which nobody can see. A
  // check that fires on noise is a check whose report gets skipped. Being the
  // longest at all is still worth counting, but as a rate across the run
  // (`correctLongest` below), not as a verdict on one question.
  const correctLength = words(correct).length;
  const others = labels.filter((_, i) => i !== q.correct - 1).map((o) => words(o).length);
  const runnerUp = Math.max(...others, 0);
  const margin = correctLength - runnerUp;
  push(
    'correct_not_conspicuous',
    margin < LENGTH_MARGIN_WORDS,
    `correct option is ${correctLength} words against a next-longest ${runnerUp} (margin ${margin}, limit ${LENGTH_MARGIN_WORDS})`,
  );

  const negated = NEGATED_STEM.find((re) => re.test(q.stem));
  push('positive_form', !negated, negated ? `stem is negated: ${negated}` : 'stem asks the positive form');

  push('options_not_numbered', !NUMBERED_IN_STEM.test(q.stem), 'stem does not letter or number the options');

  // 1.14 removed the settings line from the stem. A stem that opens with a
  // bracketed readout is the model composing one anyway, and it would change
  // the fingerprint the repeat check depends on.
  push('no_settings_line', !q.stem.trimStart().startsWith('['), 'stem opens with the question');

  return checks;
}

export interface Scored {
  question: GeneratedQuestion;
  checks: Check[];
  passed: boolean;
}

export interface Summary {
  questions: number;
  /** Questions with every deterministic check passing. */
  clean: number;
  /** Per-check pass counts, so one bad check does not hide behind an average. */
  byCheck: Record<string, { passed: number; failed: number }>;
  /**
   * How often the correct option landed in each slot, 1-4.
   *
   * The check the judge structurally cannot do, because it is a property of the
   * run rather than of any one question. Even at 100% obedience this is worth
   * printing: if the plan's own hash were skewed, every individual question
   * would look obedient and the run would still be predictable.
   */
  slots: [number, number, number, number];
  /**
   * How often the correct option was the single longest of the four.
   *
   * A rate, not a verdict: any one question being longest by a word is
   * nothing, and a run where it happens far more than a quarter of the time is
   * a generator with a tell. Like `slots`, this is a property of the run and so
   * invisible to a judge reading one question at a time.
   */
  correctLongest: number;
}

export function scoreAll(questions: GeneratedQuestion[]): { scored: Scored[]; summary: Summary } {
  const scored = questions.map((question) => {
    const checks = checkQuestion(question);
    return { question, checks, passed: checks.every((c) => c.ok) };
  });

  const byCheck: Summary['byCheck'] = {};
  for (const { checks } of scored) {
    for (const c of checks) {
      const row = (byCheck[c.id] ??= { passed: 0, failed: 0 });
      if (c.ok) row.passed++;
      else row.failed++;
    }
  }

  const slots: [number, number, number, number] = [0, 0, 0, 0];
  let correctLongest = 0;
  for (const { question } of scored) {
    const i = question.correct - 1;
    if (i === 0 || i === 1 || i === 2 || i === 3) slots[i] += 1;

    const lengths = question.options.map((o) => words(o).length);
    const mine = lengths[i] ?? 0;
    if (mine === Math.max(...lengths, 0) && lengths.filter((l) => l === mine).length === 1) correctLongest++;
  }

  return {
    scored,
    summary: {
      questions: scored.length,
      clean: scored.filter((s) => s.passed).length,
      byCheck,
      slots,
      correctLongest,
    },
  };
}
