import type { DB } from './db.js';
import { applyGrade, initialMastery, type MasteryState, SCORE_WINDOW } from './srs.js';
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
}

/**
 * Recomputes and persists the gate for a session. `requiredHint` raises the bar
 * (never lowers it) when new unmastered concepts show up mid-session.
 */
export function syncGate(
  db: DB,
  sessionId: string,
  config: EklavyaConfig,
  requiredHint?: number,
): GateStatus {
  const existing = gateRow(db, sessionId);
  const { answered, passedCount } = countAnswered(db, sessionId);

  const required = Math.max(existing?.required ?? 0, requiredHint ?? 0);
  const needed = Math.ceil(required * config.pass_threshold);
  const passed = required === 0 ? true : passedCount >= needed;

  db.prepare(
    `INSERT INTO gates (session_id, mode, required, answered, passed, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       mode = excluded.mode, required = excluded.required,
       answered = excluded.answered, passed = excluded.passed,
       updated_at = excluded.updated_at`,
  ).run(sessionId, config.mode, required, answered, passed ? 1 : 0);

  return { mode: config.mode, required, answered, passed, pass_threshold: config.pass_threshold };
}
