import type { DB } from './db.js';
import {
  applyGrade,
  decayedScore,
  initialMastery,
  isKnown,
  type MasteryState,
  SCORE_WINDOW,
} from './srs.js';
import type { EklavyaConfig } from './config.js';

export interface ConceptRow {
  id: number;
  slug: string;
  name: string;
  domain: string;
  description: string | null;
  tier: number;
  source: string;
}

export interface SessionConceptRow extends ConceptRow {
  context: string | null;
  logged_at: string;
}

export function conceptBySlug(db: DB, slug: string): ConceptRow | undefined {
  return db.prepare('SELECT * FROM concepts WHERE slug = ?').get(slug) as ConceptRow | undefined;
}

export function allConceptSlugs(db: DB): { id: number; slug: string; domain: string }[] {
  return db.prepare('SELECT id, slug, domain FROM concepts').all() as {
    id: number;
    slug: string;
    domain: string;
  }[];
}

export function insertConcept(
  db: DB,
  c: { slug: string; name: string; domain: string; description?: string | null; tier: number; source?: string },
): ConceptRow {
  db.prepare(
    `INSERT INTO concepts (slug, name, domain, description, tier, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(c.slug, c.name, c.domain, c.description ?? null, c.tier, c.source ?? 'llm');
  return conceptBySlug(db, c.slug)!;
}

export function masteryFor(db: DB, conceptId: number): MasteryState {
  const row = db.prepare('SELECT * FROM mastery WHERE concept_id = ?').get(conceptId) as
    | (MasteryState & { concept_id: number })
    | undefined;
  if (!row) return initialMastery();
  return {
    score: row.score,
    ease: row.ease,
    interval_d: row.interval_d,
    reps: row.reps,
    last_seen: row.last_seen,
    next_review: row.next_review,
  };
}

export function writeMastery(db: DB, conceptId: number, state: MasteryState): void {
  db.prepare(
    `INSERT INTO mastery (concept_id, score, ease, interval_d, reps, last_seen, next_review)
     VALUES (@id, @score, @ease, @interval_d, @reps, @last_seen, @next_review)
     ON CONFLICT(concept_id) DO UPDATE SET
       score = excluded.score, ease = excluded.ease, interval_d = excluded.interval_d,
       reps = excluded.reps, last_seen = excluded.last_seen, next_review = excluded.next_review`,
  ).run({ id: conceptId, ...state });
}

/** Chronological grades, oldest first, windowed to what the score actually uses. */
export function gradesFor(db: DB, conceptId: number, limit = SCORE_WINDOW): number[] {
  const rows = db
    .prepare('SELECT grade FROM attempts WHERE concept_id = ? ORDER BY id DESC LIMIT ?')
    .all(conceptId, limit) as { grade: number }[];
  return rows.map((r) => r.grade).reverse();
}

export function lastAttempt(
  db: DB,
  conceptId: number,
): { grade: number; difficulty: number; ts: string } | undefined {
  return db
    .prepare('SELECT grade, difficulty, ts FROM attempts WHERE concept_id = ? ORDER BY id DESC LIMIT 1')
    .get(conceptId) as { grade: number; difficulty: number; ts: string } | undefined;
}

export function recordAttemptRow(
  db: DB,
  a: {
    conceptId: number;
    sessionId: string;
    question: string;
    answer: string | null;
    grade: number;
    difficulty: number;
    feedback: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO attempts (concept_id, session_id, question, answer, grade, difficulty, feedback)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(a.conceptId, a.sessionId, a.question, a.answer, a.grade, a.difficulty, a.feedback);
}

/** Applies one grade end to end: attempt row, then recomputed SM-2 state. */
export function gradeConcept(
  db: DB,
  input: {
    conceptId: number;
    sessionId: string;
    question: string;
    answer: string | null;
    grade: number;
    difficulty: number;
    feedback: string | null;
    now: Date;
  },
): MasteryState {
  const before = masteryFor(db, input.conceptId);
  recordAttemptRow(db, input);
  const grades = gradesFor(db, input.conceptId);
  const after = applyGrade({ state: before, grade: input.grade, grades, now: input.now });
  writeMastery(db, input.conceptId, after);
  return after;
}

export function logSessionConcept(
  db: DB,
  sessionId: string,
  conceptId: number,
  context: string | null,
): void {
  db.prepare(
    `INSERT INTO session_concepts (session_id, concept_id, context)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id, concept_id) DO UPDATE SET
       context = COALESCE(excluded.context, session_concepts.context)`,
  ).run(sessionId, conceptId, context);
}

export function sessionConcepts(db: DB, sessionId: string): SessionConceptRow[] {
  return db
    .prepare(
      `SELECT c.*, sc.context, sc.ts AS logged_at
       FROM session_concepts sc JOIN concepts c ON c.id = sc.concept_id
       WHERE sc.session_id = ?
       ORDER BY sc.ts ASC, c.tier ASC, c.slug ASC`,
    )
    .all(sessionId) as SessionConceptRow[];
}

export function newConceptsThisSession(db: DB, sessionId: string): number {
  return (
    db
      .prepare(
        `SELECT count(*) n FROM session_concepts sc
         JOIN concepts c ON c.id = sc.concept_id
         WHERE sc.session_id = ? AND c.source = 'llm'`,
      )
      .get(sessionId) as { n: number }
  ).n;
}

export function lastAttemptAt(db: DB, sessionId: string): string | null {
  const row = db
    .prepare('SELECT ts FROM attempts WHERE session_id = ? ORDER BY id DESC LIMIT 1')
    .get(sessionId) as { ts: string } | undefined;
  return row?.ts ?? null;
}

// ---------------------------------------------------------------------------
// Gates
//
// `required` is frozen when the gate opens and only ever grows, so a learner
// cannot shrink their own obligation by mastering concepts mid-quiz. `passed`
// counts only concepts actually answered at grade >= 3: a skip (grade 0) counts
// as answered but never as passing, or the gate is theater (PRD §15).
// ---------------------------------------------------------------------------

export interface GateRow {
  session_id: string;
  mode: string;
  required: number;
  answered: number;
  passed: number;
  updated_at: string;
  repo: string | null;
}

export const PASSING_GRADE = 3;

export function gateRow(db: DB, sessionId: string): GateRow | undefined {
  return db.prepare('SELECT * FROM gates WHERE session_id = ?').get(sessionId) as GateRow | undefined;
}

function countAnswered(db: DB, sessionId: string): { answered: number; passedCount: number } {
  const row = db
    .prepare(
      `SELECT
         count(DISTINCT a.concept_id) AS answered,
         count(DISTINCT CASE WHEN a.grade >= ? THEN a.concept_id END) AS passedCount
       FROM attempts a
       JOIN session_concepts sc
         ON sc.concept_id = a.concept_id AND sc.session_id = a.session_id
       WHERE a.session_id = ?`,
    )
    .get(PASSING_GRADE, sessionId) as { answered: number; passedCount: number };
  return row;
}

export interface GateStatus {
  mode: string;
  required: number;
  answered: number;
  passed: boolean;
  pass_threshold: number;
  repo?: string | null;
}

/**
 * Recomputes and persists the gate for a session. `requiredHint` raises the bar
 * (never lowers it) when new unmastered concepts show up mid-session.
 */
export function syncGate(
  db: DB,
  sessionId: string,
  config: EklavyaConfig,
  opts: { requiredHint?: number; repo?: string | null } = {},
): GateStatus {
  const existing = gateRow(db, sessionId);
  const { answered, passedCount } = countAnswered(db, sessionId);

  const required = Math.max(existing?.required ?? 0, opts.requiredHint ?? 0);
  // Keep a repo once known: a later call from a different cwd must not blank it,
  // or the git pre-commit hook loses the row it enforces against.
  const repo = opts.repo ?? existing?.repo ?? null;
  const needed = Math.ceil(required * config.pass_threshold);
  const passed = required === 0 ? true : passedCount >= needed;

  db.prepare(
    `INSERT INTO gates (session_id, mode, required, answered, passed, updated_at, repo)
     VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(session_id) DO UPDATE SET
       mode = excluded.mode, required = excluded.required,
       answered = excluded.answered, passed = excluded.passed,
       updated_at = excluded.updated_at, repo = excluded.repo`,
  ).run(sessionId, config.mode, required, answered, passed ? 1 : 0, repo);

  return { mode: config.mode, required, answered, passed, pass_threshold: config.pass_threshold, repo };
}

// ---------------------------------------------------------------------------
// Question history
//
// PRD goal 2 is "never ask the same question twice". `attempts.question` was
// being written and never read, which left the promise resting entirely on the
// model's memory of a conversation it does not have. These are what make it real.
// ---------------------------------------------------------------------------

export interface AskedQuestion {
  question: string;
  tier: number;
  grade: number;
}

/** The last few questions actually asked about a concept, newest first. */
export function recentQuestions(db: DB, conceptId: number, limit = 3): AskedQuestion[] {
  return db
    .prepare(
      `SELECT question, difficulty AS tier, grade FROM attempts
        WHERE concept_id = ? AND question <> ''
        ORDER BY id DESC LIMIT ?`,
    )
    .all(conceptId, limit) as AskedQuestion[];
}

/** Loose match: whitespace and punctuation differences are still the same question. */
export function questionFingerprint(question: string): string {
  return question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function hasAskedQuestion(db: DB, conceptId: number, question: string): boolean {
  const target = questionFingerprint(question);
  if (!target) return false;
  const rows = db
    .prepare('SELECT question FROM attempts WHERE concept_id = ? ORDER BY id DESC LIMIT 20')
    .all(conceptId) as { question: string }[];
  return rows.some((r) => questionFingerprint(r.question) === target);
}

/** Concepts already asked about in this session — they have had their turn. */
export function attemptedConceptIds(db: DB, sessionId: string): Set<number> {
  const rows = db
    .prepare('SELECT DISTINCT concept_id FROM attempts WHERE session_id = ?')
    .all(sessionId) as { concept_id: number }[];
  return new Set(rows.map((r) => r.concept_id));
}

/**
 * Prerequisites of a concept the learner has not mastered yet. A tier-3
 * judgement question about a concept whose foundations are missing is not a hard
 * question, it is an unfair one — the tutor needs to see this before asking.
 */
export function unmetPrereqs(db: DB, conceptId: number, now: Date): string[] {
  const rows = db
    .prepare(
      `SELECT c.slug, m.score, m.reps, m.next_review
         FROM edges e
         JOIN concepts c ON c.id = e.from_concept
         LEFT JOIN mastery m ON m.concept_id = c.id
        WHERE e.to_concept = ? AND e.relation = 'prerequisite_of'
        ORDER BY c.tier ASC, c.slug ASC`,
    )
    .all(conceptId) as { slug: string; score: number | null; reps: number | null; next_review: string | null }[];

  return rows
    .filter((r) => !isKnown({ score: decayedScore(r.score ?? 0, r.next_review, now), reps: r.reps ?? 0 }))
    .map((r) => r.slug);
}
