import { describe, it, expect } from 'vitest';
import {
  scoreExtraction,
  checkExtractionShape,
  summarizeExtraction,
  MIN_CONCEPTS,
  MAX_CONCEPTS,
} from '../src/eval/extraction-score.js';
import { FUZZY_MATCH_THRESHOLD } from '../src/slug.js';

const LABELS = ['wal-journal-mode', 'busy-timeout-versus-retry', 'idempotency-and-safe-retries'];
const c = (slug: string, context = 'openDb sets journal_mode') => ({ slug, context });

describe('scoreExtraction', () => {
  it('credits an exact hit', () => {
    const r = scoreExtraction('f', LABELS, [c('wal-journal-mode')]);
    expect(r.matched).toEqual(['wal-journal-mode']);
    expect(r.recall).toBeCloseTo(1 / 3);
    expect(r.precision).toBe(1);
  });

  it('credits a near miss exactly as the server would', () => {
    // The point of importing findFuzzyMatch rather than writing a comparison:
    // a model that logs a qualifier-suffixed slug is resolved to the canonical
    // one by log_session_concepts, so the eval must credit it too.
    const r = scoreExtraction('f', LABELS, [c('wal-journal-mode-basics')]);
    expect(r.matched).toEqual(['wal-journal-mode']);
    expect(r.unlabelled).toEqual([]);
  });

  it('credits a pure token reordering, which is what threshold 1.0 catches', () => {
    expect(FUZZY_MATCH_THRESHOLD).toBe(0.8);
    const r = scoreExtraction('f', ['jwt-structure'], [c('structure-jwt')]);
    expect(r.matched).toEqual(['jwt-structure']);
  });

  it('does not credit one label twice for two ways of saying it', () => {
    // Otherwise recall is inflatable by logging the same concept repeatedly.
    const r = scoreExtraction('f', LABELS, [c('wal-journal-mode'), c('wal-journal-mode-basics')]);
    expect(r.matched).toEqual(['wal-journal-mode']);
    expect(r.recall).toBeCloseTo(1 / 3);
    // The duplicate still costs precision, because it was a slot spent saying
    // nothing new.
    expect(r.precision).toBe(0.5);
  });

  it('reports what was missed', () => {
    const r = scoreExtraction('f', LABELS, [c('wal-journal-mode')]);
    expect(r.missed).toEqual(['busy-timeout-versus-retry', 'idempotency-and-safe-retries']);
  });

  it('calls an unmatched slug unlabelled, not wrong', () => {
    // The labels are one person's reading of the diff. An unmatched slug is
    // either a false positive or a concept the labeller did not think of, and
    // only a judge can tell those apart -- so the name has to leave that open.
    const r = scoreExtraction('f', LABELS, [c('sqlite-page-cache')]);
    expect(r.unlabelled).toEqual(['sqlite-page-cache']);
    expect(r.matched).toEqual([]);
    expect(r.precision).toBe(0);
  });

  it('normalizes before matching, so casing and spaces are not a new concept', () => {
    const r = scoreExtraction('f', LABELS, [c('WAL Journal Mode')]);
    expect(r.matched).toEqual(['wal-journal-mode']);
  });

  it('scores an empty extraction as zero rather than dividing by nothing', () => {
    const r = scoreExtraction('f', LABELS, []);
    expect(r).toMatchObject({ precision: 0, recall: 0, f1: 0 });
    expect(r.missed).toEqual(LABELS);
  });
});

describe('checkExtractionShape', () => {
  const diff = 'db.pragma("journal_mode = WAL");\nexport function retryOnBusy(fn) { ... }';

  it('passes a well-formed extraction', () => {
    const checks = checkExtractionShape(
      [
        c('wal-journal-mode', 'openDb sets journal_mode to WAL'),
        c('busy-timeout-versus-retry', 'retryOnBusy wraps the write'),
        c('idempotency-and-safe-retries', 'retryOnBusy is safe because the transaction rolled back'),
      ],
      diff,
    );
    expect(checks.every((x) => x.ok), JSON.stringify(checks.filter((x) => !x.ok))).toBe(true);
  });

  it('flags too few and too many concepts', () => {
    const one = Array.from({ length: MIN_CONCEPTS - 1 }, () => c('wal-journal-mode', 'journal_mode'));
    const many = Array.from({ length: MAX_CONCEPTS + 1 }, () => c('wal-journal-mode', 'journal_mode'));
    const count = (list: ReturnType<typeof c>[]) =>
      checkExtractionShape(list, diff).find((x) => x.id === 'count_in_range')!.ok;
    expect(count(one)).toBe(false);
    expect(count(many)).toBe(false);
  });

  it('flags a concept logged without a context line', () => {
    const checks = checkExtractionShape([{ slug: 'wal-journal-mode', context: '   ' }], diff);
    expect(checks.find((x) => x.id === 'every_concept_has_context')!.ok).toBe(false);
  });

  it('flags a context line that grounds nothing', () => {
    // The skill's own example of useless context is "used cookies": it reads
    // fine, produces a question, and grounds it in nothing. Nothing downstream
    // notices, which is why it is checked here.
    const checks = checkExtractionShape([c('wal-journal-mode', 'used a database')], diff);
    expect(checks.find((x) => x.id === 'context_names_the_code')!.ok).toBe(false);
  });

  it('accepts a context line naming a real identifier from the diff', () => {
    const checks = checkExtractionShape([c('busy-timeout-versus-retry', 'retryOnBusy covers it')], diff);
    expect(checks.find((x) => x.id === 'context_names_the_code')!.ok).toBe(true);
  });

  it('flags a slug that cannot survive normalization', () => {
    const checks = checkExtractionShape([{ slug: '???', context: 'journal_mode' }], diff);
    expect(checks.find((x) => x.id === 'slugs_valid')!.ok).toBe(false);
  });
});

describe('summarizeExtraction', () => {
  it('pools across fixtures rather than averaging per-fixture rates', () => {
    // Averaging rates would weight a two-label fixture the same as an
    // eight-label one.
    const s = summarizeExtraction([
      scoreExtraction('a', ['x', 'y'], [c('x')]),
      scoreExtraction('b', ['p', 'q', 'r'], [c('p'), c('q'), c('zzz-unrelated')]),
    ]);
    expect(s).toMatchObject({ fixtures: 2, labels: 5, extracted: 4, matched: 3, unlabelled: 1 });
    expect(s.precision).toBe(0.75);
    expect(s.recall).toBeCloseTo(0.6);
  });
});
