import { describe, it, expect } from 'vitest';
import {
  checkQuestion,
  scoreAll,
  longestSharedRun,
  type GeneratedQuestion,
} from '../src/eval/question-checks.js';

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
      // Case and punctuation are noise here.
      expect(longestSharedRun('Set-Cookie, httpOnly!', 'set cookie httponly')).toBe(3);
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
      // Calibrated against the first live run, which flagged all three of its
      // questions for a correct option two words longer than the next -- 17
      // against 15. A check that fires on noise gets its report skipped.
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
