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
import { askFooter, stripAskFooter } from '../src/ask.js';
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

describe('the ask footer', () => {
  it('names the focus, the level and the tier', () => {
    expect(askFooter({ config: config({ focus: 'concept' }), level: 'easy', pinned: false, tier: 2 })).toBe(
      'concept · easy · tier 2',
    );
  });

  it('carries the topic in learn focus, so a question about caching says so', () => {
    expect(
      askFooter({
        config: config({ focus: 'learn', focus_topic: 'caching' }),
        level: 'medium',
        pinned: false,
        tier: 3,
      }),
    ).toBe('learn: caching · medium · tier 3');
  });

  it('says when the level is pinned — otherwise questions just stop getting harder', () => {
    expect(askFooter({ config: config(), level: 'hard', pinned: true, tier: 5 })).toBe(
      'concept · hard (pinned) · tier 5',
    );
  });

  it('warns only when there is something to warn about', () => {
    expect(askFooter({ config: config({ mode: 'enforced' }), level: 'easy', pinned: false, tier: 1 })).toBe(
      'concept · easy · tier 1 · gated',
    );
    // Ambient has no consequence attached, and cadence is never in the footer:
    // the question's arrival already said when Eklavya asks.
    expect(askFooter({ config: config({ mode: 'ambient', cadence: 'end' }), level: 'easy', pinned: false, tier: 1 })).toBe(
      'concept · easy · tier 1',
    );
  });

  it('is absent under quiet', () => {
    expect(askFooter({ config: config({ quiet: true }), level: 'easy', pinned: false, tier: 1 })).toBeNull();
  });
});

describe('stripping the footer back off', () => {
  const stem = 'Why is httpOnly set on the refresh cookie here but not on the access token?';

  it('removes every shape the composer can produce', () => {
    const levels: Level[] = ['easy', 'medium', 'hard'];
    const footers = [
      ...levels.map((l) => `concept · ${l} · tier 2`),
      'project · easy · tier 1',
      'learn: http caching · medium · tier 3',
      'concept · hard (pinned) · tier 5',
      'concept · easy · tier 2 · gated',
    ];
    for (const footer of footers) {
      expect(stripAskFooter(`${stem}\n\n${footer}`)).toBe(stem);
    }
  });

  it('leaves a stem with no footer untouched', () => {
    expect(stripAskFooter(stem)).toBe(stem);
    expect(stripAskFooter(`${stem}\n\nAnd what breaks if it is missing?`)).toBe(
      `${stem}\n\nAnd what breaks if it is missing?`,
    );
  });

  it('only ever takes the last line', () => {
    const multi = `concept · easy · tier 2\n\n${stem}`;
    expect(stripAskFooter(multi)).toBe(multi);
  });
});
