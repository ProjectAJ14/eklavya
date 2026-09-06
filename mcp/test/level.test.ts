import { describe, it, expect } from 'vitest';
import {
  LEVEL_BANDS,
  LEVELS,
  checkPromotion,
  clampToLevel,
  nextLevel,
  requiredConcepts,
  type Level,
} from '../src/srs.js';
import { stripAskHeader } from '../src/ask.js';
import { statusLine } from '../src/statusline.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';

const config = (patch: Partial<EklavyaConfig> = {}): EklavyaConfig => ({ ...DEFAULT_CONFIG, ...patch });

describe('level bands', () => {
  it('starts everyone somewhere answerable — easy never exceeds tier 2', () => {
    // The load-bearing property of the whole phase: tiers 1-2 are answerable by
    // someone who was only watching the agent work, which is the state Eklavya
    // finds people in. A tier-3 question asks them to defend a choice they did
    // not make, and the honest answer to that is "no idea".
    for (const tier of [1, 2, 3, 4, 5]) {
      expect(clampToLevel(tier, 'easy')).toBeLessThanOrEqual(2);
    }
  });

  it('clamps into the band from both ends', () => {
    expect(clampToLevel(5, 'medium')).toBe(4);
    expect(clampToLevel(1, 'medium')).toBe(2);
    expect(clampToLevel(1, 'hard')).toBe(3);
    expect(clampToLevel(5, 'hard')).toBe(5);
  });

  it('leaves a tier inside the band alone', () => {
    expect(clampToLevel(2, 'easy')).toBe(2);
    expect(clampToLevel(3, 'medium')).toBe(3);
    expect(clampToLevel(4, 'hard')).toBe(4);
  });

  it('overlaps consecutive bands, so promotion is not a cliff', () => {
    for (let i = 0; i < LEVELS.length - 1; i += 1) {
      const lower = LEVEL_BANDS[LEVELS[i]!];
      const upper = LEVEL_BANDS[LEVELS[i + 1]!];
      expect(upper.min).toBeLessThanOrEqual(lower.max);
    }
  });

  it('walks the ladder and stops at the top', () => {
    expect(nextLevel('easy')).toBe('medium');
    expect(nextLevel('medium')).toBe('hard');
    expect(nextLevel('hard')).toBeNull();
  });
});

describe('promotion', () => {
  const counts = (passed: number, answered: number, concepts: number) => ({ passed, answered, concepts });

  it('needs the answers, the accuracy and the spread together', () => {
    const verdict = checkPromotion({
      level: 'easy',
      counts: counts(100, 120, 20),
      after: 100,
      minAccuracy: 0.7,
    });
    expect(verdict.promote).toBe(true);
    expect(verdict.to).toBe('medium');
    expect(verdict.unmet).toEqual([]);
  });

  it('refuses on volume alone — a hundred answers mostly wrong is not readiness', () => {
    const verdict = checkPromotion({
      level: 'easy',
      counts: counts(100, 250, 30),
      after: 100,
      minAccuracy: 0.7,
    });
    expect(verdict.promote).toBe(false);
    expect(verdict.unmet).toContain('accuracy');
    expect(verdict.accuracy).toBeCloseTo(0.4, 5);
  });

  it('refuses when one concept was ground out forty ways', () => {
    const verdict = checkPromotion({
      level: 'easy',
      counts: counts(100, 100, 3),
      after: 100,
      minAccuracy: 0.7,
    });
    expect(verdict.promote).toBe(false);
    expect(verdict.unmet).toEqual(['concepts']);
  });

  it('is one answer short at the boundary and fires on the next', () => {
    const shy = checkPromotion({ level: 'easy', counts: counts(99, 99, 20), after: 100, minAccuracy: 0.7 });
    expect(shy.promote).toBe(false);
    expect(shy.unmet).toEqual(['answers']);

    const done = checkPromotion({ level: 'easy', counts: counts(100, 100, 20), after: 100, minAccuracy: 0.7 });
    expect(done.promote).toBe(true);
  });

  it('never promotes past hard', () => {
    const verdict = checkPromotion({
      level: 'hard',
      counts: counts(500, 500, 90),
      after: 100,
      minAccuracy: 0.7,
    });
    expect(verdict.promote).toBe(false);
    expect(verdict.to).toBeNull();
    expect(verdict.unmet).toContain('max_level');
  });

  it('scales the concept floor to the runway, so a short one is still reachable', () => {
    // A fixed 15 would make `level_up_after: 5` unsatisfiable: fifteen distinct
    // concepts cannot appear among five passing answers, and the promotion would
    // never fire with nothing on screen saying why.
    expect(requiredConcepts(100)).toBe(15);
    expect(requiredConcepts(5)).toBe(2);
    expect(requiredConcepts(1)).toBe(1);

    const verdict = checkPromotion({ level: 'easy', counts: counts(5, 5, 2), after: 5, minAccuracy: 0.7 });
    expect(verdict.promote).toBe(true);
  });

  it('treats no answers at all as zero accuracy rather than a divide by zero', () => {
    const verdict = checkPromotion({ level: 'easy', counts: counts(0, 0, 0), after: 100, minAccuracy: 0.7 });
    expect(verdict.accuracy).toBe(0);
    expect(verdict.promote).toBe(false);
  });
});

describe('the status-bar dials', () => {
  const plain = (patch = {}, level: Level = 'easy', pinned = false) =>
    statusLine({ config: config(patch), level, pinned, color: false });

  it('shows all four dials, unlabelled — a bar you learn once, not a line you decode', () => {
    expect(plain({ focus: 'concept' })).toBe('[EKLAVYA ambient · concept · interleaved · easy]');
  });

  it('carries the topic in learn focus, so a question about caching says so', () => {
    // Parenthesised rather than `learn: caching`: a colon in a bar reads as a
    // key, and the topic has no key of its own here.
    expect(plain({ focus: 'learn', focus_topic: 'caching' }, 'medium')).toBe(
      '[EKLAVYA ambient · learn (caching) · interleaved · medium]',
    );
  });

  it('says when the level is pinned — otherwise questions just stop getting harder', () => {
    expect(plain({}, 'hard', true)).toBe('[EKLAVYA ambient · concept · interleaved · hard (pinned)]');
  });

  it('includes cadence, which the old question-line deliberately left out', () => {
    // The old argument was that the question's arrival already said when
    // Eklavya asks. A bar is on screen before any question arrives, so the
    // dial has to name itself.
    expect(plain({ cadence: 'end' })).toBe('[EKLAVYA ambient · concept · end · easy]');
  });

  it('paints enforced amber and everything else verdigris, with the word still there', () => {
    // Colour is a redundant cue, never the only one: strip the ANSI and the
    // mode is still spelled out.
    const enforced = statusLine({ config: config({ mode: 'enforced' }), level: 'easy', pinned: false });
    expect(enforced).toContain('[38;5;172m');
    expect(enforced).toContain('enforced');

    const ambient = statusLine({ config: config(), level: 'easy', pinned: false });
    expect(ambient).toContain('[38;5;116m');
  });

  it('emits no escape codes when colour is off, for a bar that renders literally', () => {
    expect(plain()).not.toContain('\u001b');
  });

  it('says nothing at all when Eklavya is dormant or quiet', () => {
    // A bar that always says something is a bar you stop reading.
    expect(plain({ mode: 'off' })).toBeNull();
    expect(plain({ quiet: true })).toBeNull();
  });
});

describe('stripping the settings line back off', () => {
  const stem = 'Why is httpOnly set on the refresh cookie here but not on the access token?';

  it('removes every shape Eklavya ever composed, above the stem or below it', () => {
    const levels: Level[] = ['easy', 'medium', 'hard'];
    const lines = [
      ...levels.map((l) => `[mode: ambient · focus: concept · level: ${l} · tier: 2 mechanism]`),
      '[mode: ambient · focus: project · level: easy · tier: 1 recall]',
      '[mode: ambient · focus: learn (http caching) · level: medium · tier: 3 judgement]',
      '[mode: ambient · focus: concept · level: hard (pinned) · tier: 5 design]',
      '[mode: enforced (gated) · focus: concept · level: easy · tier: 1 recall]',
      '[mode: ambient · focus: concept · level: easy · tier: 2 mechanism · question: 2 of 3]',
      // Written by older versions -- unlabelled, below the stem, without the
      // brackets. Those rows are still in the database and must keep their
      // fingerprint, or every one of them looks like a brand-new question.
      '[ambient · concept · easy · tier 2 mechanism]',
      '[ambient · learn: http caching · medium · tier 3 judgement]',
      '[ambient · concept · easy · tier 2 mechanism · q 2/3]',
      'ambient · concept · easy · tier 2 mechanism',
      'concept · easy · tier 2',
      'concept · easy · tier 2 · gated',
    ];
    for (const line of lines) {
      expect(stripAskHeader(`${line}\n\n${stem}`)).toBe(stem);
      expect(stripAskHeader(`${stem}\n\n${line}`)).toBe(stem);
    }
  });

  it('leaves a stem with no settings line untouched', () => {
    expect(stripAskHeader(stem)).toBe(stem);
    expect(stripAskHeader(`${stem}\n\nAnd what breaks if it is missing?`)).toBe(
      `${stem}\n\nAnd what breaks if it is missing?`,
    );
  });

  it('takes one line, never a middle one', () => {
    const buried = `${stem}\n\n[mode: ambient · focus: concept · level: easy · tier: 2 mechanism]\n\nAnd why?`;
    expect(stripAskHeader(buried)).toBe(buried);
  });

  it('strips the line from both ends at once, in case the tutor pastes both', () => {
    const line = '[mode: ambient · focus: concept · level: easy · tier: 2 mechanism]';
    expect(stripAskHeader(`${line}\n\n${stem}\n\n${line}`)).toBe(stem);
  });
});
