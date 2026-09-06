/**
 * The deterministic half of the question-quality eval.
 *
 * Eklavya's claim is that the developer learns, and until now nothing measured
 * it: the 426 tests next door cover SM-2 arithmetic, plan sizing, gate maths and
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

/**
 * Lowercased words, with identifiers kept whole.
 *
 * `_`, `-`, `.` and `/` stay inside a token on purpose. Splitting on them turns
 * `max_questions_per_task` into four words and `mcp/src/eval/question-checks.ts`
 * into six, so a stem and an answer that merely name the same identifier -- the
 * ordinary way to write these questions -- would share a four-word run and trip
 * `answer_not_in_stem` on its own. The fixtures here are this repo's own code,
 * so that is the common case, not the corner one.
 */
function normalized(text: string): string[] {
  return words(text.toLowerCase().replace(/[^\p{L}\p{N}_\-./]+/gu, ' '));
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
 * Below this many words in the longest option, the ratio says nothing: four
 * answers like `O(1)` / `O(n log n)` sit at 3.0 and are perfectly matched to a
 * reader. Shape is a tell in sentences, not in tokens.
 */
export const PARITY_MIN_WORDS = 6;

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
  // "Which of these is not / will not / can't / is never ..."
  /\bwhich\b(?:\s+of\s+(?:these|the\s+following))?\s+\w*\s*\b(?:is|are|does|do|will|would|can|could)(?:n't|\s+not|\s+never)\b/i,
  // "... except which of these", but not the ordinary prose "except a corrupt file"
  /\bexcept\b\s+(?:for\s+)?(?:which|one|these|the\s+following)\b/i,
  /\b(?:is|are)\s+(?:not|never)\s+true\b/i,
  /\b(?:incorrect|least\s+likely)\b/i,
  /\bnone\s+of\s+(?:these|the\s+above)\b/i,
];

/**
 * The tool renders the labels; a stem that numbers them is showing them twice.
 *
 * Two markers, not one. A single `b)` is `retry(db, b)` and a single `3.` is
 * "the plan asked for tier 3. Why..." -- both ordinary, and both were flagged by
 * the first version of this. An actual enumeration always has at least two.
 */
const OPTION_MARKER = /(^|\s)(?:[a-d]\)|\(?[1-4][).]\s)/gim;

function numberedOptions(stem: string): boolean {
  return (stem.match(OPTION_MARKER) ?? []).length >= 2;
}

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

  // Indexed into `q.options`, never `labels`. `labels` drops empty options, so
  // one blank before the answer shifts every later index by one -- and the
  // conspicuousness check below then compared the correct option against
  // itself and always passed, on exactly the malformed question it should have
  // been loudest about.
  const inRange = Number.isInteger(q.correct) && q.correct >= 1 && q.correct <= q.options.length;
  push(
    'correct_in_range',
    inRange,
    inRange ? `correct = ${q.correct}` : `correct = ${JSON.stringify(q.correct)}, options = ${q.options.length}`,
  );
  const correct = inRange ? (q.options[q.correct - 1] ?? '') : '';
  const run = longestSharedRun(q.stem, correct);
  push(
    'answer_not_in_stem',
    run < ANSWER_RUN_LIMIT,
    `longest run shared with the correct option: ${run} word(s)`,
  );

  const lengths = q.options.map((o) => words(o).length);
  const longest = Math.max(...lengths, 0);
  const shortest = Math.min(...lengths, Infinity);
  const ratio = shortest > 0 ? longest / shortest : Infinity;
  const shortEnoughToNotMatter = longest <= PARITY_MIN_WORDS;
  push(
    'option_parity',
    shortEnoughToNotMatter || ratio <= OPTION_RATIO_LIMIT,
    shortEnoughToNotMatter
      ? `all four options are ${longest} words or fewer, so shape carries nothing`
      : `longest/shortest = ${ratio.toFixed(2)} (limit ${OPTION_RATIO_LIMIT})`,
  );

  // Separate from parity on purpose. Four options can sit inside the ratio and
  // the correct one still stand out, which is the tell a learner notices first:
  // pick the most careful-sounding answer without reading it.
  //
  // The margin is why this is not simply "is it the longest". The first live
  // run flagged all three of its questions, and one of the three was the
  // correct option beating the next by two words -- 17 against 15, which nobody
  // can see. The other two were four-word margins and still flag today. A check
  // that fires on noise is a check whose report gets skipped. Being the longest
  // at all is still worth counting, but as a rate across the run
  // (`correctLongest` below), not as a verdict on one question.
  const correctLength = words(correct).length;
  const others = q.options.filter((_, i) => i !== q.correct - 1).map((o) => words(o).length);
  const runnerUp = Math.max(...others, 0);
  const margin = correctLength - runnerUp;
  push(
    'correct_not_conspicuous',
    margin < LENGTH_MARGIN_WORDS,
    `correct option is ${correctLength} words against a next-longest ${runnerUp} (margin ${margin}, limit ${LENGTH_MARGIN_WORDS})`,
  );

  const negated = NEGATED_STEM.find((re) => re.test(q.stem));
  push('positive_form', !negated, negated ? `stem is negated: ${negated}` : 'stem asks the positive form');

  const numbered = numberedOptions(q.stem);
  push(
    'options_not_numbered',
    !numbered,
    numbered ? 'stem enumerates the options itself' : 'stem does not letter or number the options',
  );

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
