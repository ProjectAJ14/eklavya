import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import {
  conceptBySlug,
  correctionTarget,
  CorrectionError,
  dueInProject,
  gateRetryConcepts,
  gradeConcept,
  levelCounts,
  logSessionConcept,
  recordRetry,
  syncGate,
} from '../src/store.js';
import { tempDbPath, cleanup } from './helpers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lastAttemptAt } from '../src/store.js';
import { getLearnerProfile } from '../src/tools/get_learner_profile.js';
import { learningCounts } from '../src/memory/recall.js';
import { buildEvents } from '../src/telemetry-send.js';

const SESSION = 'corr-session';
const REPO = '/nonexistent/corrections-repo';
const OPTIONS = ['A cache', 'A lock', 'A queue', 'A log'];
const NOTES = ['keeps reads', 'serialises writers', 'orders work', 'appends history'];

let dbFile = '';
let db: DB;
let conceptId = 0;

const config: EklavyaConfig = {
  ...DEFAULT_CONFIG,
  quiz: { ...DEFAULT_CONFIG.quiz, enforced: true },
};

/** A missed mcq on the concept, with or without its answer key. */
function miss(key: { correct?: string | null; notes?: string[] | null; grade?: number } = {}): number {
  gradeConcept(db, {
    conceptId,
    sessionId: SESSION,
    question: 'What stops two writers clobbering a row?',
    answer: 'A cache',
    grade: key.grade ?? 1,
    difficulty: 2,
    feedback: null,
    outcome: 'answered',
    format: 'mcq',
    options: OPTIONS,
    correct: key.correct === undefined ? 'A lock' : key.correct,
    optionNotes: key.notes === undefined ? NOTES : key.notes,
    repo: REPO,
    level: 'easy',
    now: new Date('2026-10-01T10:00:00Z'),
  });
  return (db.prepare('SELECT max(id) AS id FROM attempts').get() as { id: number }).id;
}

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof CorrectionError ? e.code : `untyped: ${String(e)}`;
  }
  return 'no error';
};

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-corr-home-'));
  process.env.EKLAVYA_HOME = home;
  dbFile = tempDbPath('corrections');
  db = openDb(dbFile);
  conceptId = conceptBySlug(db, 'mutex')?.id ?? 0;
  if (!conceptId) {
    db.prepare(`INSERT INTO concepts (slug, name, domain, tier) VALUES ('mutex', 'Mutex', 'concurrency', 2)`).run();
    conceptId = conceptBySlug(db, 'mutex')!.id;
  }
  logSessionConcept(db, SESSION, conceptId, 'the write path', 'work');
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.EKLAVYA_HOME;
});

describe('recordRetry', () => {
  it('logs every try and writes one correction row on the right one', () => {
    const id = miss();
    const later = new Date('2026-10-01T11:00:00Z');
    expect(recordRetry(db, id, 'A queue', later)).toEqual({ correct: false, tries: 1, corrected: false });
    expect(recordRetry(db, id, 'A lock', later)).toEqual({ correct: true, tries: 2, corrected: true });

    const retries = db.prepare('SELECT picked, correct, ts FROM attempt_retries WHERE attempt_id = ? ORDER BY id').all(id);
    expect(retries).toEqual([
      { picked: 'A queue', correct: 0, ts: '2026-10-01 11:00:00' },
      { picked: 'A lock', correct: 1, ts: '2026-10-01 11:00:00' },
    ]);
    const rows = db.prepare('SELECT * FROM attempts WHERE retry_of = ?').all(id) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      grade: 3,
      format: 'mcq',
      outcome: 'answered',
      answer: 'A lock',
      correct: 'A lock',
      option_notes: JSON.stringify(NOTES),
      options: JSON.stringify(OPTIONS),
      repo: REPO,
      level: 'easy',
      session_id: SESSION,
      difficulty: 2,
    });
    // The original row is history and is never rewritten.
    expect(db.prepare('SELECT grade, retry_of FROM attempts WHERE id = ?').get(id)).toEqual({ grade: 1, retry_of: null });
  });

  it('moves mastery on the right try only', () => {
    const id = miss();
    const before = db.prepare('SELECT reps, score FROM mastery WHERE concept_id = ?').get(conceptId);
    recordRetry(db, id, 'A log', new Date());
    expect(db.prepare('SELECT reps, score FROM mastery WHERE concept_id = ?').get(conceptId)).toEqual(before);
    recordRetry(db, id, 'A lock', new Date());
    const after = db.prepare('SELECT reps FROM mastery WHERE concept_id = ?').get(conceptId) as { reps: number };
    expect(after.reps).toBeGreaterThan((before as { reps: number }).reps);
  });

  it('refuses a second correction, at the store and at the database', () => {
    const id = miss();
    recordRetry(db, id, 'A lock', new Date());
    expect(code(() => recordRetry(db, id, 'A lock', new Date()))).toBe('already_corrected');
    expect(() =>
      db.prepare(`INSERT INTO attempts (concept_id, session_id, question, grade, difficulty, retry_of)
                  VALUES (?, ?, 'q', 3, 2, ?)`).run(conceptId, SESSION, id),
    ).toThrow(/UNIQUE/);
  });

  it('names each refusal', () => {
    const id = miss();
    expect(code(() => recordRetry(db, 999_999, 'A lock', new Date()))).toBe('not_found');
    expect(code(() => recordRetry(db, id, 'a lock', new Date()))).toBe('not_an_option');
    expect(code(() => recordRetry(db, miss({ correct: null }), 'A lock', new Date()))).toBe('not_correctable');
    expect(code(() => recordRetry(db, miss({ grade: 4 }), 'A lock', new Date()))).toBe('not_correctable');
    recordRetry(db, id, 'A lock', new Date());
    const correction = (db.prepare('SELECT id FROM attempts WHERE retry_of = ?').get(id) as { id: number }).id;
    expect(code(() => recordRetry(db, correction, 'A lock', new Date()))).toBe('not_correctable');
    // A refused try writes nothing.
    expect(db.prepare('SELECT count(*) AS n FROM attempt_retries').get()).toEqual({ n: 1 });
  });

  it('treats a row recorded before 019 as not correctable', () => {
    db.prepare(
      `INSERT INTO attempts (concept_id, session_id, question, answer, grade, difficulty, format, options)
       VALUES (?, ?, 'legacy', 'A cache', 1, 2, 'mcq', ?)`,
    ).run(conceptId, SESSION, JSON.stringify(OPTIONS));
    const id = (db.prepare('SELECT max(id) AS id FROM attempts').get() as { id: number }).id;
    expect(code(() => recordRetry(db, id, 'A lock', new Date()))).toBe('not_correctable');
  });
});

describe('correctionTarget', () => {
  it('reports the question, notes, tries and when it was corrected', () => {
    const id = miss();
    expect(correctionTarget(db, id)).toMatchObject({
      id,
      concept: 'mutex',
      question: 'What stops two writers clobbering a row?',
      options: OPTIONS,
      option_notes: NOTES,
      correct: 'A lock',
      correctable: true,
      tries: 0,
      corrected_at: null,
    });
    recordRetry(db, id, 'A log', new Date());
    recordRetry(db, id, 'A lock', new Date());
    const t = correctionTarget(db, id)!;
    expect(t.tries).toBe(2);
    expect(t.corrected_at).toEqual(expect.any(String));
  });

  it('reads malformed stored options as absent instead of throwing', () => {
    const id = miss();
    db.prepare(`UPDATE attempts SET options = '{not json', option_notes = '[1,2]' WHERE id = ?`).run(id);
    expect(correctionTarget(db, id)).toMatchObject({ options: null, option_notes: null, correctable: false });
  });

  it('is null for an unknown attempt and uncorrectable without a key', () => {
    expect(correctionTarget(db, 424242)).toBeNull();
    const t = correctionTarget(db, miss({ correct: null, notes: null }))!;
    expect(t).toMatchObject({ correctable: false, option_notes: null, correct: null });
  });
});

describe('a correction is not recall', () => {
  it('does not clear the session gate', () => {
    const id = miss();
    syncGate(db, SESSION, config, { requiredHint: 1, repo: REPO });
    const before = syncGate(db, SESSION, config, { repo: REPO });
    recordRetry(db, id, 'A lock', new Date());
    const after = syncGate(db, SESSION, config, { repo: REPO });
    expect(after.passed_count).toBe(before.passed_count);
    expect(after.passed).toBe(false);
  });

  it('keeps the concept on the gate retry list', () => {
    const id = miss();
    recordRetry(db, id, 'A lock', new Date());
    expect(gateRetryConcepts(db, SESSION).map((c) => c.slug)).toEqual(['mutex']);
  });

  it('does not count toward level progress', () => {
    const id = miss();
    const before = levelCounts(db, REPO, 'easy', null);
    recordRetry(db, id, 'A lock', new Date());
    expect(levelCounts(db, REPO, 'easy', null)).toEqual(before);
  });

  it('keeps the concept owed in the review backlog', () => {
    const id = miss();
    recordRetry(db, id, 'A lock', new Date('2026-10-01T11:00:00Z'));
    // Far enough out that the pass's own review date has come round.
    expect(dueInProject(db, REPO, new Date('2027-06-01T00:00:00Z')).map((c) => c.slug)).toEqual(['mutex']);
  });
});

describe('every other reader of "the latest answer" agrees', () => {
  const later = new Date('2027-06-01T00:00:00Z');

  it('the learner profile still lists the concept as owed', () => {
    const id = miss();
    // Profiles read the real clock, so the pass is dated far enough back that
    // its own review date has come round too: only the latest grade decides.
    recordRetry(db, id, 'A lock', new Date('2025-01-01T00:00:00Z'));
    const profile = getLearnerProfile.handler({}, { db }) as { due_for_review: { slug: string }[] };
    expect(profile.due_for_review.map((d) => d.slug)).toContain('mutex');
  });

  it('the banner counts it as due', () => {
    const id = miss();
    recordRetry(db, id, 'A lock', new Date('2026-10-01T11:00:00Z'));
    expect(learningCounts(db, REPO, later).due).toBe(1);
  });

  it('the session clock and the usage ping do not see it as a question', () => {
    const id = miss();
    const asked = lastAttemptAt(db, SESSION);
    db.prepare(`UPDATE attempts SET ts = '2026-10-01 10:00:00' WHERE id = ?`).run(id);
    recordRetry(db, id, 'A lock', new Date());
    expect(lastAttemptAt(db, SESSION)).toBe('2026-10-01 10:00:00');
    expect(asked).toEqual(expect.any(String));
    const learning = buildEvents(db, Date.parse('2026-10-03T00:00:00Z'), { sent_at: '2026-09-01T00:00:00.000Z' })
      .find((e) => e.name === 'learning')!.params as Record<string, number>;
    expect(learning).toMatchObject({ questions_new: 1, answered_new: 1, passed_new: 0, mcq_new: 1, questions_total: 1 });
  });
});
