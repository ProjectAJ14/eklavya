import { describe, it, expect } from 'vitest';
import {
  checkQuestion,
  scoreAll,
  longestSharedRun,
  STEM_WORD_LIMIT,
  ANSWER_RUN_LIMIT,
  OPTION_RATIO_LIMIT,
  PARITY_MIN_WORDS,
  LENGTH_MARGIN_WORDS,
  type GeneratedQuestion,
} from '../src/eval/question-checks.js';
import { extractJson } from '../src/eval/extract-json.js';

/** A question that passes everything, to vary one property at a time. */
function good(over: Partial<GeneratedQuestion> = {}): GeneratedQuestion {
  return {
    fixture: 'f1',
    slug: 'httponly-cookies',
    tier_to_ask: 3,
    answer_position: 2,
    stem: 'Why is httpOnly set on the refresh cookie here but not on the access token?',
    options: [
      'It stops the cookie going to another origin',
      'It keeps script out of the long-lived credential',
      'It encrypts the value so an attacker cannot read it',
      'It stops the server reading the cookie',
    ],
    correct: 2,
    ...over,
  };
}

const find = (q: GeneratedQuestion, id: string) => checkQuestion(q).find((c) => c.id === id)!;

describe('question checks', () => {
  it('passes a well-formed question on every check', () => {
    const checks = checkQuestion(good());
    expect(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok))).toBe(true);
  });

  it('always reports what it measured, passing or failing', () => {
    // A report of bare booleans cannot be argued with, which is the wrong
    // property for a number nobody has audited yet.
    for (const c of checkQuestion(good())) expect(c.detail.length).toBeGreaterThan(0);
  });

  describe('answer_at_position', () => {
    it('fails when the model ignored the slot the plan assigned', () => {
      const c = find(good({ correct: 1, answer_position: 3 }), 'answer_at_position');
      expect(c.ok).toBe(false);
      expect(c.detail).toContain('plan said 3');
    });

    it('passes when it obeyed', () => {
      expect(find(good({ correct: 4, answer_position: 4 }), 'answer_at_position').ok).toBe(true);
    });
  });

  describe('stem_length', () => {
    it('fails a stem over the limit', () => {
      const c = find(good({ stem: `${'word '.repeat(26)}?` }), 'stem_length');
      expect(c.ok).toBe(false);
    });

    it('does not count bare punctuation as a word', () => {
      expect(find(good({ stem: 'Why is httpOnly set here ?' }), 'stem_length').detail).toContain('5 words');
    });
  });

  describe('answer_not_in_stem', () => {
    it('fails when the stem carries the answer sentence', () => {
      const q = good({
        stem: 'Does httpOnly keep script out of the long-lived credential, or something else?',
      });
      expect(find(q, 'answer_not_in_stem').ok).toBe(false);
    });

    it('tolerates the subject appearing in both, which it always does', () => {
      // The stem and the answer are about the same thing by construction. Only
      // a shared *sentence* is a leak, which is why this is a run and not an
      // overlap.
      expect(find(good(), 'answer_not_in_stem').ok).toBe(true);
    });

    it('counts the longest consecutive run, not the total overlap', () => {
      expect(longestSharedRun('the cat sat on the mat', 'a dog sat on the rug')).toBe(3);
      expect(longestSharedRun('alpha beta gamma', 'gamma alpha beta')).toBe(2);
      expect(longestSharedRun('nothing alike', 'entirely different')).toBe(0);
      // Case and sentence punctuation are noise.
      expect(longestSharedRun('The cookie, sadly!', 'the cookie sadly')).toBe(3);
    });

    it('keeps an identifier as one word, so naming it twice is not a run', () => {
      // Splitting on _ . / would make `max_questions_per_task` a four-word run
      // against itself, and every question about this repo's own code would
      // flag. The fixtures ARE this repo's code, so that is the common case.
      expect(longestSharedRun('max_questions_per_task', 'max questions per task')).toBe(0);
      expect(longestSharedRun('what does max_questions_per_task cap', 'max_questions_per_task caps it')).toBe(1);
      expect(longestSharedRun('see mcp/src/eval/extract-json.ts', 'mcp/src/eval/extract-json.ts is new')).toBe(1);
    });
  });

  describe('option shape', () => {
    it('fails four options of visibly different length', () => {
      const q = good({
        options: ['Yes', 'It keeps script out of the long-lived credential which matters because of XSS', 'No', 'Maybe'],
        correct: 2,
      });
      expect(find(q, 'option_parity').ok).toBe(false);
    });

    it('fails when the correct option is conspicuously longer, even within the ratio', () => {
      // The leak a learner spots first: pick the most careful-sounding answer.
      const q = good({
        options: ['One two three', 'One two three', 'One two three four five six seven', 'One two three'],
        correct: 3,
      });
      expect(find(q, 'option_parity').ok).toBe(true);
      expect(find(q, 'correct_not_conspicuous').ok).toBe(false);
    });

    it('ignores a margin nobody could see', () => {
      // Calibrated against the first live run: of the three questions it
      // flagged, one was the correct option two words longer than the next --
      // 17 against 15. A check that fires on noise gets its report skipped.
      const q = good({
        options: ['one two three four five', 'one two three four five six', 'one two three four', 'one two three four five'],
        correct: 2,
      });
      expect(find(q, 'correct_not_conspicuous').ok).toBe(true);
    });

    it('allows a longest option that is not the correct one', () => {
      const q = good({
        options: ['One two three', 'One two three', 'One two three four five six seven', 'One two three'],
        correct: 1,
      });
      expect(find(q, 'correct_not_conspicuous').ok).toBe(true);
    });

    it('fails duplicated or empty options', () => {
      expect(find(good({ options: ['a', 'a', 'b', 'c'] }), 'four_options').ok).toBe(false);
      expect(find(good({ options: ['a', '', 'b', 'c'] }), 'four_options').ok).toBe(false);
    });
  });

  describe('positive_form', () => {
    it('fails an inverted stem', () => {
      expect(find(good({ stem: 'Which of these is not prevented by httpOnly?' }), 'positive_form').ok).toBe(false);
      expect(find(good({ stem: 'All of these are true except which one?' }), 'positive_form').ok).toBe(false);
    });

    it('allows a contrastive "not", which is legitimate and common', () => {
      // The default fixture stem is exactly this case: "...here but not on the
      // access token". A check that flagged it would train the reader to
      // ignore the report.
      expect(find(good(), 'positive_form').ok).toBe(true);
    });
  });

  it('fails a stem that letters its own options', () => {
    expect(find(good({ stem: 'Which is right? a) this b) that' }), 'options_not_numbered').ok).toBe(false);
  });

  it('fails a stem that opens with a settings line', () => {
    // Removed from the product in 1.14; this catches a model composing one anyway.
    const q = good({ stem: '[mode: ambient] Why is httpOnly set on the refresh cookie?' });
    expect(find(q, 'no_settings_line').ok).toBe(false);
  });
});

describe('scoreAll', () => {
  it('counts each check separately so one failure cannot hide in an average', () => {
    const { summary } = scoreAll([good(), good({ correct: 1, answer_position: 3 })]);
    expect(summary.questions).toBe(2);
    expect(summary.clean).toBe(1);
    expect(summary.byCheck.answer_at_position).toEqual({ passed: 1, failed: 1 });
    expect(summary.byCheck.stem_length).toEqual({ passed: 2, failed: 0 });
  });

  it('reports which slot the answer landed in across the run', () => {
    // The check an LLM judge structurally cannot make: it is a property of the
    // run, not of any question in it. Every question here is individually
    // obedient and the run is still perfectly predictable.
    const { summary } = scoreAll([
      good({ correct: 1, answer_position: 1 }),
      good({ correct: 1, answer_position: 1 }),
      good({ correct: 1, answer_position: 1 }),
    ]);
    expect(summary.slots).toEqual([3, 0, 0, 0]);
    expect(summary.byCheck.answer_at_position).toEqual({ passed: 3, failed: 0 });
  });

  it('counts how often the correct option was longest, which no single check can see', () => {
    // Every question here passes correct_not_conspicuous -- each margin is one
    // word -- and the generator still has a tell, because it is the longest
    // every time. The rate is the only place that shows up.
    const narrow = (correct) =>
      good({
        correct,
        answer_position: correct,
        options: ['one two three four', 'one two three four', 'one two three four', 'one two three four'].map(
          (o, i) => (i === correct - 1 ? `${o} five` : o),
        ),
      });
    const { summary } = scoreAll([narrow(1), narrow(2), narrow(3)]);
    expect(summary.byCheck.correct_not_conspicuous).toEqual({ passed: 3, failed: 0 });
    expect(summary.correctLongest).toBe(3);
  });
});

describe('extractJson', () => {
  it('reads the object a model was asked for', () => {
    expect(extractJson('{"stem":"why","correct":2}')).toEqual({ stem: 'why', correct: 2 });
  });

  it('skips the narration a model puts in front of it', () => {
    const reply = 'Here is the question you asked for:\n\n{"stem":"why","correct":2}\n';
    expect(extractJson(reply)).toEqual({ stem: 'why', correct: 2 });
  });

  it('takes the last object, not an example in the preamble', () => {
    expect(extractJson('For example {"stem":"x"} — but here is mine: {"stem":"real"}')).toEqual({
      stem: 'real',
    });
  });

  it('terminates on a reply that opens with a brace and never parses', () => {
    // The bug this file exists for. `lastIndexOf('{', -1)` clamps to 0 and
    // returns 0, so the obvious backwards walk spins forever -- on input the
    // prompt explicitly asks for ("reply with a single JSON object").
    const start = Date.now();
    expect(extractJson('{ not json at all')).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('treats a brace inside a string as a character, not as depth', () => {
    // A question about code is full of braces. Counting them as structure is
    // what made the first version hang.
    const reply = '{"stem":"what does the { opener do","options":["a","b","c","d"],"correct":1}';
    expect(extractJson(reply)).toEqual({
      stem: 'what does the { opener do',
      options: ['a', 'b', 'c', 'd'],
      correct: 1,
    });
  });

  it('handles an escaped quote before a brace', () => {
    expect(extractJson('{"stem":"a \\" then { brace","correct":3}')).toEqual({
      stem: 'a " then { brace',
      correct: 3,
    });
  });

  it('returns null when there is no object at all', () => {
    expect(extractJson('I could not write a question.')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
});

describe('the thresholds themselves', () => {
  // Every constant below was free to move without a test noticing: an earlier
  // version of this suite stayed green with LENGTH_MARGIN_WORDS set to 2, which
  // is the exact value the live run showed was too low. A threshold nothing
  // pins is a threshold that drifts back.
  const stem = (n: number) => `${'word '.repeat(n - 1)}why?`;

  it('pins STEM_WORD_LIMIT at the boundary', () => {
    expect(STEM_WORD_LIMIT).toBe(25);
    expect(find(good({ stem: stem(25) }), 'stem_length').ok).toBe(true);
    expect(find(good({ stem: stem(26) }), 'stem_length').ok).toBe(false);
  });

  it('pins ANSWER_RUN_LIMIT at the boundary', () => {
    expect(ANSWER_RUN_LIMIT).toBe(4);
    const shared = (n: number) =>
      good({
        stem: `alpha bravo charlie delta echo ${'x '.repeat(0)}`.split(' ').slice(0, n).join(' '),
        options: ['a', 'b', 'alpha bravo charlie delta echo', 'd'],
        correct: 3,
      });
    expect(find(shared(3), 'answer_not_in_stem').ok).toBe(true);
    expect(find(shared(4), 'answer_not_in_stem').ok).toBe(false);
  });

  it('pins LENGTH_MARGIN_WORDS at the boundary the live run calibrated', () => {
    expect(LENGTH_MARGIN_WORDS).toBe(3);
    const margin = (n: number) =>
      good({
        correct: 2,
        answer_position: 2,
        options: [
          'one two three four five',
          `one two three four five ${'more '.repeat(n).trim()}`,
          'one two three four five',
          'one two three four five',
        ],
      });
    // Two words is the margin the first run produced on 17 against 15. It must
    // not fire; three must.
    expect(find(margin(2), 'correct_not_conspicuous').ok).toBe(true);
    expect(find(margin(3), 'correct_not_conspicuous').ok).toBe(false);
  });

  it('pins OPTION_RATIO_LIMIT and the floor below which shape says nothing', () => {
    expect(OPTION_RATIO_LIMIT).toBe(2.5);
    expect(PARITY_MIN_WORDS).toBe(6);
    // Seven words against two is 3.5 -- over the ratio, and long enough to see.
    const wide = good({
      options: ['one two', 'one two three four five six seven', 'one two', 'one two'],
      correct: 1,
      answer_position: 1,
    });
    expect(find(wide, 'option_parity').ok).toBe(false);
    // Four short options can sit anywhere on the ratio and still look identical.
    const short = good({ options: ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'], correct: 1, answer_position: 1 });
    expect(find(short, 'option_parity').ok).toBe(true);
  });
});

describe('checks that fired on ordinary questions', () => {
  // Each of these was a false positive found by reviewing the first run's
  // output against real stems. A check that flags good questions is a check
  // whose report gets skipped, which is worse than not having it.
  const clean = (stem: string, over = {}) => checkQuestion(good({ stem, ...over })).filter((c) => !c.ok);

  it('allows a stem naming a tier or a slot number', () => {
    expect(clean('The plan asked for tier 3. Why does the server pick the slot?')).toEqual([]);
  });

  it('allows a stem quoting code with a single-letter argument', () => {
    expect(clean('What does retry(db, b) return when the lock is held?')).toEqual([]);
  });

  it('allows a contrastive "is not" that is not an inverted question', () => {
    expect(clean('Which flag is set on the refresh cookie but is not set on the access token?')).toEqual([]);
  });

  it('allows "except" used as ordinary prose', () => {
    expect(clean('Why does openDb swallow every error except a corrupt-file error?')).toEqual([]);
  });

  it('still catches the inverted forms it used to miss', () => {
    for (const s of [
      'Which of these will not happen when the writer holds the lock?',
      "Which of these isn't persisted across connections?",
      'Which of these is never true of WAL mode?',
      'Which statement about WAL is incorrect?',
    ]) {
      expect(clean(s).map((c) => c.id), s).toContain('positive_form');
    }
  });

  it('catches an enumeration but not a single stray marker', () => {
    expect(clean('Which is right? a) this b) that').map((c) => c.id)).toContain('options_not_numbered');
  });
});

describe('malformed questions', () => {
  it('flags an out-of-range or missing correct index instead of scoring against nothing', () => {
    // NaN used to pass eight of nine checks: the length checks compared against
    // an empty string and reported a comfortable margin.
    const checks = checkQuestion(good({ correct: Number.NaN }));
    expect(checks.find((c) => c.id === 'correct_in_range')!.ok).toBe(false);
  });

  it('does not let an empty option shift the index the length checks read', () => {
    // `labels` drops empty options; `q.options` does not. Indexing the correct
    // option into the filtered array compared it against itself and passed, on
    // exactly the malformed question it should have been loudest about.
    const q = good({
      correct: 4,
      answer_position: 4,
      options: ['   ', 'one two three four', 'one two three four', 'one two three four five six seven'],
    });
    expect(find(q, 'four_options').ok).toBe(false);
    expect(find(q, 'correct_not_conspicuous').ok).toBe(false);
  });
});
