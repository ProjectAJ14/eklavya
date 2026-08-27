import type { DB } from './db.js';
import {
  applyGrade,
  checkPromotion,
  decayedScore,
  initialMastery,
  isKnown,
  type Level,
  type LevelCounts,
  type MasteryState,
  type PromotionBlocker,
  nextLevel,
  requiredConcepts,
  SCORE_WINDOW,
  START_LEVEL,
} from './srs.js';
import type { EklavyaConfig } from './config.js';
import { stripAskFooter } from './ask.js';

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
    outcome: AttemptOutcome | null;
    format: QuestionFormat | null;
    options: string[] | null;
    repo: string | null;
    level: Level | null;
  },
): void {
  db.prepare(
    `INSERT INTO attempts
       (concept_id, session_id, question, answer, grade, difficulty, feedback, outcome, format,
        options, repo, level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    a.conceptId,
    a.sessionId,
    a.question,
    a.answer,
    a.grade,
    a.difficulty,
    a.feedback,
    a.outcome,
    a.format,
    // Stored beside the stem, never inside it: `question` is what gets
    // fingerprinted, and options that move would defeat the repeat check.
    a.options ? JSON.stringify(a.options) : null,
    // The project this was earned in, and the band it was asked at. Progress
    // toward the next level is counted from these two (migration 008).
    a.repo,
    a.level,
  );
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
    outcome: AttemptOutcome | null;
    format: QuestionFormat | null;
    options: string[] | null;
    repo: string | null;
    level: Level | null;
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

/**
 * `work` is a concept the implementer logged as part of the task; `review` is
 * one the tutor pulled in from elsewhere. Only `work` can satisfy the gate --
 * see migration 005.
 */
export type ConceptOrigin = 'work' | 'review';

export function logSessionConcept(
  db: DB,
  sessionId: string,
  conceptId: number,
  context: string | null,
  origin: ConceptOrigin = 'work',
): void {
  db.prepare(
    `INSERT INTO session_concepts (session_id, concept_id, context, origin)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, concept_id) DO UPDATE SET
       context = COALESCE(excluded.context, session_concepts.context),
       -- Work wins and never degrades: a concept quizzed as review debt and
       -- then genuinely touched by the task is part of the task.
       origin = CASE
                  WHEN excluded.origin = 'work' THEN 'work'
                  ELSE COALESCE(session_concepts.origin, excluded.origin)
                END`,
  ).run(sessionId, conceptId, context, origin);
}

/**
 * `origin: 'work'` restricts this to what the task actually touched, excluding
 * concepts a quiz pulled in as review debt. The gate's bar must be computed from
 * that subset: `passedCount` only counts 'work', so letting review rows raise
 * `required` would raise a bar that nothing the learner does can clear.
 */
export function sessionConcepts(
  db: DB,
  sessionId: string,
  origin?: ConceptOrigin,
): SessionConceptRow[] {
  return db
    .prepare(
      `SELECT c.*, sc.context, sc.ts AS logged_at
       FROM session_concepts sc JOIN concepts c ON c.id = sc.concept_id
       WHERE sc.session_id = ?
         ${origin ? `AND COALESCE(sc.origin, 'work') = ?` : ''}
       ORDER BY sc.ts ASC, c.tier ASC, c.slug ASC`,
    )
    .all(...(origin ? [sessionId, origin] : [sessionId])) as SessionConceptRow[];
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
      // `answered` counts everything -- quizzing on review debt is not free.
      // `passedCount` counts only 'work', because `required` is derived from the
      // concepts the work touched and the two ends have to measure the same
      // thing. Without this, `concept` focus widening to domain siblings, or
      // `learn` focus selecting from an unrelated topic, would let a gate whose
      // bar was set by today's diff be cleared without a single question about
      // today's diff. NULL is pre-migration and reads as 'work' (migration 005).
      `SELECT
         count(DISTINCT a.concept_id) AS answered,
         count(DISTINCT CASE
                          WHEN a.grade >= ? AND COALESCE(sc.origin, 'work') = 'work'
                          THEN a.concept_id
                        END) AS passedCount
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

/**
 * Why a grade is what it is. `answered` and `declined` both describe a closed
 * door; `dont_know` is the one that asks to be taught, and the only one that
 * makes a later question a follow-up rather than a cold re-ask. NULL is an
 * attempt recorded before the column existed - unknown, not a value.
 */
export type AttemptOutcome = 'answered' | 'dont_know' | 'declined';

/** How the question was put. See migration 006. */
export type QuestionFormat = 'mcq' | 'fill_blank' | 'open';

/**
 * The best grade a multiple-choice answer can earn.
 *
 * Grade 5 on the SM-2 scale means "correct, and explained why". Picking the
 * right option out of four cannot demonstrate that -- and one in four is a coin,
 * so even a clean 4 is generous. Capping here rather than trusting the tutor to
 * remember keeps recognition from inflating mastery, which is the one thing that
 * would make the whole record untrustworthy.
 *
 * 4 still reaches `known` (0.8 >= MASTERY_THRESHOLD), so this limits how fast
 * mastery is claimed, not whether it can be.
 */
export const MAX_MCQ_GRADE = 4;

export interface AskedQuestion {
  question: string;
  tier: number;
  grade: number;
  outcome: AttemptOutcome | null;
  /** How it was put. NULL for attempts recorded before formats existed. */
  format: QuestionFormat | null;
  /**
   * True when the learner blanked and was taught the answer there and then. The
   * next question about this concept must build on that explanation instead of
   * asking as though the topic had never come up.
   */
  taught: boolean;
}

/** The last few questions actually asked about a concept, newest first. */
export function recentQuestions(db: DB, conceptId: number, limit = 3): AskedQuestion[] {
  const rows = db
    .prepare(
      `SELECT question, difficulty AS tier, grade, outcome, format FROM attempts
        WHERE concept_id = ? AND question <> ''
        ORDER BY id DESC LIMIT ?`,
    )
    .all(conceptId, limit) as Omit<AskedQuestion, 'taught'>[];
  return rows.map((r) => ({ ...r, taught: r.outcome === 'dont_know' }));
}

/**
 * Loose match: whitespace and punctuation differences are still the same question.
 *
 * The ask footer is stripped before hashing. It is presentation -- the dials that
 * asked -- and it changes when the level or the focus changes, so leaving it in
 * would make one question fingerprint as several and quietly undo "never the same
 * question twice".
 */
export function questionFingerprint(question: string): string {
  return stripAskFooter(question).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function hasAskedQuestion(db: DB, conceptId: number, question: string): boolean {
  const target = questionFingerprint(question);
  if (!target) return false;
  const rows = db
    .prepare('SELECT question FROM attempts WHERE concept_id = ? ORDER BY id DESC LIMIT 20')
    .all(conceptId) as { question: string }[];
  return rows.some((r) => questionFingerprint(r.question) === target);
}

/**
 * Has this concept ever been blanked on and taught?
 *
 * Deliberately not derived from `recentQuestions`, which is windowed: once a few
 * newer attempts pile up, the `dont_know` row falls out of that window and the
 * flag flips back to false. The concepts that accumulate attempts fastest are
 * the unmastered ones that keep resurfacing -- exactly the ones most likely to
 * have been blanked on -- so deriving it there loses the flag precisely where it
 * matters most, and the next question opens cold on a topic already explained.
 */
export function wasEverTaught(db: DB, conceptId: number): boolean {
  const row = db
    .prepare(`SELECT 1 FROM attempts WHERE concept_id = ? AND outcome = 'dont_know' LIMIT 1`)
    .get(conceptId);
  return row !== undefined;
}

/**
 * Concepts this session attempted but did not pass, minus the ones the learner
 * declined.
 *
 * This is the way out of an otherwise unreachable gate. A blank grades 0, and a
 * concept with any attempt is filtered from the session plan, so a session
 * answered entirely with "I don't know" leaves `required` permanently unmet: the
 * planner returns nothing, and the commit gate denies forever. Offering those
 * concepts again -- once everything else is exhausted, a tier lower, and with
 * `asked_before` forcing a different question -- turns the deadlock into a
 * second lap over material that has now been taught.
 *
 * Declines are excluded on purpose, judged on the *latest* attempt so someone
 * who declined and later engaged is not held to the earlier answer. "Leave me
 * alone" is a choice, and enforced mode holding the gate against it is the
 * enforcement working, not a deadlock.
 */
export function gateRetryConcepts(db: DB, sessionId: string): SessionConceptRow[] {
  return db
    .prepare(
      // Carries `context` so a retry question stays grounded in the same code
      // the first one was about -- the concept was taught, not the file.
      `SELECT c.*, sc.context, sc.ts AS logged_at FROM concepts c
         JOIN session_concepts sc ON sc.concept_id = c.id AND sc.session_id = ?
         JOIN (
           SELECT a.concept_id,
                  max(a.grade) AS best_grade,
                  (SELECT x.outcome FROM attempts x
                    WHERE x.session_id = a.session_id AND x.concept_id = a.concept_id
                    ORDER BY x.id DESC LIMIT 1) AS last_outcome
             FROM attempts a
            WHERE a.session_id = ?
            GROUP BY a.concept_id
         ) t ON t.concept_id = c.id
        WHERE t.best_grade < ?
          AND (t.last_outcome IS NULL OR t.last_outcome <> 'declined')
        ORDER BY sc.ts ASC`,
    )
    .all(sessionId, sessionId, PASSING_GRADE) as SessionConceptRow[];
}

/**
 * Concepts in the same domains as the session's work, for `concept` focus.
 *
 * `project` focus asks about the diff; `concept` focus asks about the ideas the
 * diff is an instance of, which means reaching past what the task happened to
 * touch. Prerequisites of touched concepts come too: they are the part of "the
 * general version" a learner is most likely to be missing.
 */
export function domainSiblings(db: DB, domains: string[], exclude: Set<number>): ConceptRow[] {
  if (domains.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT c.* FROM concepts c
        WHERE c.domain IN (${domains.map(() => '?').join(',')})
        ORDER BY c.tier ASC, c.slug ASC`,
    )
    .all(...domains) as ConceptRow[];
  return rows.filter((c) => !exclude.has(c.id));
}

/** Prerequisites of the given concepts, nearest first. Used to widen `concept` focus. */
export function prereqsOf(db: DB, conceptIds: number[]): ConceptRow[] {
  if (conceptIds.length === 0) return [];
  return db
    .prepare(
      `SELECT DISTINCT c.* FROM concepts c
         JOIN edges e ON e.from_concept = c.id
        WHERE e.relation = 'prerequisite_of'
          AND e.to_concept IN (${conceptIds.map(() => '?').join(',')})
        ORDER BY c.tier ASC, c.slug ASC`,
    )
    .all(...conceptIds) as ConceptRow[];
}

export interface TopicMatch {
  /** A domain the topic named outright, if any. */
  domain: string | null;
  /** Concepts the topic matched by slug or name. */
  slugs: string[];
}

/**
 * Resolve a free-text topic ("caching", "web auth") onto the graph, for `learn`
 * focus.
 *
 * Tried in order of confidence: an exact domain, then a domain whose name the
 * topic contains or is contained by, then concepts matching on slug or name.
 * Returning both a domain and slugs lets the caller prefer the domain when the
 * topic names one and fall back to loose concept matches when it does not.
 *
 * An empty result is meaningful and must not be papered over -- it means the
 * graph has nothing on this topic yet, and the honest answer is to say so and
 * offer to teach from first principles rather than to invent questions.
 */
export function resolveTopic(db: DB, topic: string): TopicMatch {
  const needle = topic.trim().toLowerCase();
  if (!needle) return { domain: null, slugs: [] };
  const slugged = needle.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  const domains = (
    db.prepare('SELECT DISTINCT domain FROM concepts').all() as { domain: string }[]
  ).map((r) => r.domain);

  const exact = domains.find((d) => d.toLowerCase() === needle || d.toLowerCase() === slugged);
  const loose =
    exact ??
    domains.find((d) => {
      const l = d.toLowerCase();
      return l.includes(slugged) || slugged.includes(l);
    });

  const rows = db
    .prepare(
      `SELECT slug FROM concepts
        WHERE slug LIKE ? OR lower(name) LIKE ?
        ORDER BY tier ASC, slug ASC
        LIMIT 40`,
    )
    .all(`%${slugged}%`, `%${needle}%`) as { slug: string }[];

  return { domain: loose ?? null, slugs: rows.map((r) => r.slug) };
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

// ---------------------------------------------------------------------------
// Difficulty levels (phase-9)
//
// The level is per project and earned. `srs.ts` holds the rules; this holds the
// two facts they are computed from -- which band the project is on, and what has
// been answered since it got there.
// ---------------------------------------------------------------------------

/**
 * The bucket for work outside any git repository.
 *
 * A scratch directory still deserves a level, but keying on `cwd` would mint a
 * row per temp folder and mean nobody ever accumulates a hundred answers
 * anywhere.
 */
export const GLOBAL_PROJECT = '*';

export function projectKey(repoRoot: string | null | undefined): string {
  return repoRoot && repoRoot.trim() ? repoRoot : GLOBAL_PROJECT;
}

export interface ProjectLevelRow {
  repo: string;
  level: Level;
  promoted_at: string | null;
  updated_at: string;
}

export function projectLevelRow(db: DB, repo: string): ProjectLevelRow | undefined {
  return db.prepare('SELECT * FROM project_levels WHERE repo = ?').get(repo) as
    | ProjectLevelRow
    | undefined;
}

/**
 * Counts the evidence at one level in one project.
 *
 * Derived, never stored. A counter column would drift from the attempt rows that
 * justify it, and it would freeze `level_up_after` at whatever it was when each
 * attempt landed -- so lowering the threshold would not release the learners
 * already past it, which is the one change most likely to be made after watching
 * a real learner.
 *
 * `since` is the level's `promoted_at`: answers from the previous band are spent.
 * Declines are excluded from both halves of the accuracy fraction -- skipping a
 * question honestly must never cost a level, or the level becomes a reason to
 * guess.
 */
export function levelCounts(db: DB, repo: string, level: Level, since: string | null): LevelCounts {
  const row = db
    .prepare(
      `SELECT
         COALESCE(sum(CASE WHEN grade >= ? THEN 1 ELSE 0 END), 0) AS passed,
         count(*) AS answered,
         count(DISTINCT CASE WHEN grade >= ? THEN concept_id END) AS concepts
       FROM attempts
       WHERE repo = ? AND level = ?
         AND COALESCE(outcome, 'answered') <> 'declined'
         AND (? IS NULL OR ts >= ?)`,
    )
    .get(PASSING_GRADE, PASSING_GRADE, repo, level, since, since) as LevelCounts;
  return { passed: row.passed, answered: row.answered, concepts: row.concepts };
}

export interface LevelStanding {
  repo: string;
  level: Level;
  /** Pinned by config, so no promotion will ever fire. */
  pinned: boolean;
  /** When this level was entered; null for a project still on the starting band. */
  entered_at: string | null;
  next: Level | null;
  counts: LevelCounts;
  accuracy: number;
  needed: { answers: number; accuracy: number; concepts: number };
  /** Which conditions are not met yet — say the bar out loud rather than hint at it. */
  unmet: PromotionBlocker[];
}

/** Everything a caller needs to ask at the right band and report the runway. */
export function levelStanding(
  db: DB,
  config: EklavyaConfig,
  repoRoot: string | null | undefined,
): LevelStanding {
  const repo = projectKey(repoRoot);
  const pinned = config.difficulty !== 'auto';
  const row = projectLevelRow(db, repo);
  // A pin wins outright, and does not disturb the earned row underneath it: drop
  // the pin later and the project is back where its evidence left it.
  const level: Level = pinned ? (config.difficulty as Level) : (row?.level ?? START_LEVEL);
  const entered_at = pinned ? null : (row?.promoted_at ?? null);

  const counts = levelCounts(db, repo, level, entered_at);
  const verdict = checkPromotion({
    level,
    counts,
    after: config.level_up_after,
    minAccuracy: config.level_up_accuracy,
  });

  return {
    repo,
    level,
    pinned,
    entered_at,
    next: nextLevel(level),
    counts,
    accuracy: verdict.accuracy,
    needed: {
      answers: config.level_up_after,
      accuracy: config.level_up_accuracy,
      concepts: requiredConcepts(config.level_up_after),
    },
    unmet: verdict.unmet,
  };
}

/**
 * Promotes the project if this attempt has just earned it. Call inside the same
 * transaction as the grade, or a crash between the two loses the evidence.
 *
 * `datetime('now')` rather than a JS timestamp, deliberately: `attempts.ts`
 * defaults to SQLite's own format, and `promoted_at` is compared against it as a
 * string. An ISO timestamp with a `T` in it would sort wrong against
 * `2026-08-27 09:31:00` and silently count the previous band's answers.
 */
export function promoteIfEarned(
  db: DB,
  config: EklavyaConfig,
  repoRoot: string | null | undefined,
): { from: Level; to: Level; counts: LevelCounts } | null {
  // A pinned level is a decision, not a stage: no progression, and no row written.
  if (config.difficulty !== 'auto') return null;

  const standing = levelStanding(db, config, repoRoot);
  const verdict = checkPromotion({
    level: standing.level,
    counts: standing.counts,
    after: config.level_up_after,
    minAccuracy: config.level_up_accuracy,
  });
  if (!verdict.promote || !verdict.to) return null;

  db.prepare(
    `INSERT INTO project_levels (repo, level, promoted_at, updated_at)
     VALUES (?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(repo) DO UPDATE SET
       level = excluded.level,
       promoted_at = excluded.promoted_at,
       updated_at = excluded.updated_at`,
  ).run(standing.repo, verdict.to);

  return { from: standing.level, to: verdict.to, counts: standing.counts };
}
