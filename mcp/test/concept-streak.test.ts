import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { conceptBySlug, gradeConcept, masteryFor, writeMastery } from '../src/store.js';
import { isKnown, KNOWN_SQL, MS_PER_DAY } from '../src/srs.js';

/**
 * Mastery is a streak across days, read in two places that must agree: `isKnown`
 * (the planner, the profile, the dashboard) and `KNOWN_SQL` (the counts in
 * `doctor` and the usage ping). Driven through `gradeConcept`, the one writer,
 * with the clock passed in so days can pass.
 */
let dbFile: string;
let db: DB;
const DAY1 = new Date('2026-03-01T10:00:00.000Z');

beforeEach(() => {
  dbFile = tempDbPath('streak');
  db = openDb(dbFile);
});
afterEach(() => {
  db.close();
  cleanup(dbFile);
});

function grade(slug: string, g: number, difficulty: number, now: Date, retryOf?: number) {
  return gradeConcept(db, {
    conceptId: conceptBySlug(db, slug)!.id,
    sessionId: 's',
    question: `q ${Math.random()}`,
    answer: 'a',
    grade: g,
    difficulty,
    feedback: null,
    now,
    retryOf,
  } as any);
}
const day = (n: number) => new Date(DAY1.getTime() + n * MS_PER_DAY);
const known = (slug: string) => isKnown(masteryFor(db, conceptBySlug(db, slug)!.id));

describe('the streak, written by gradeConcept', () => {
  it('is not mastered by four passes in one sitting', () => {
    for (let i = 0; i < 4; i += 1) grade('csrf', 4, 2, new Date(DAY1.getTime() + i * 60_000));
    const m = masteryFor(db, conceptBySlug(db, 'csrf')!.id);
    expect(m).toMatchObject({ reps: 4, passed_days: 1, top_passed_tier: 2 });
    expect(known('csrf')).toBe(false);
  });

  it('is mastered by four passes over two days, one above recall', () => {
    grade('csrf', 4, 1, day(0));
    grade('csrf', 4, 1, day(0));
    grade('csrf', 4, 2, day(2));
    grade('csrf', 4, 2, day(2));
    expect(known('csrf')).toBe(true);
  });

  it('is not mastered when every pass was recall', () => {
    for (const d of [0, 0, 2, 2]) grade('csrf', 4, 1, day(d));
    expect(masteryFor(db, conceptBySlug(db, 'csrf')!.id)).toMatchObject({ reps: 4, passed_days: 2, top_passed_tier: 1 });
    expect(known('csrf')).toBe(false);
  });

  it('loses the streak, its days and its tier to one failed answer', () => {
    for (const d of [0, 0, 2, 2]) grade('csrf', 4, 2, day(d));
    expect(known('csrf')).toBe(true);
    grade('csrf', 1, 2, day(3));
    expect(masteryFor(db, conceptBySlug(db, 'csrf')!.id)).toMatchObject({ reps: 0, passed_days: 0, top_passed_tier: 0 });
    expect(known('csrf')).toBe(false);
  });

  it('counts a correction as a pass and a day, but never as a higher tier', () => {
    const missed = grade('csrf', 1, 2, day(0));
    grade('csrf', 3, 5, day(0), missed.attemptId);
    expect(masteryFor(db, conceptBySlug(db, 'csrf')!.id)).toMatchObject({ reps: 1, passed_days: 1, top_passed_tier: 0 });
  });
});

describe('KNOWN_SQL agrees with isKnown', () => {
  it('on every combination around each threshold', () => {
    const concepts = db.prepare('SELECT id FROM concepts LIMIT 400').all() as { id: number }[];
    const cases: { score: number; reps: number; passed_days: number; top_passed_tier: number }[] = [];
    for (const score of [0.69, 0.7, 0.95])
      for (const reps of [3, 4])
        for (const passed_days of [1, 2])
          for (const top_passed_tier of [1, 2]) cases.push({ score, reps, passed_days, top_passed_tier });
    expect(concepts.length).toBeGreaterThanOrEqual(cases.length);

    cases.forEach((c, i) =>
      writeMastery(db, concepts[i]!.id, { ...c, ease: 2.5, interval_d: 6, last_seen: null, next_review: null }),
    );
    const viaSql = (db.prepare(`SELECT count(*) AS n FROM mastery WHERE ${KNOWN_SQL}`).get() as { n: number }).n;
    expect(viaSql).toBe(cases.filter((c) => isKnown(c)).length);
    expect(viaSql).toBe(2); // score 0.7 and 0.95, each with 4 reps, 2 days and tier 2
  });
});
