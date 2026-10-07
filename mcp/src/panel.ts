import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import { loadConfig } from './config.js';
import { answerPosition, MCQ_OPTION_COUNT } from './mcq.js';
import { normalizeSlug } from './slug.js';
import { resolveSessionId } from './session.js';
import { stripAskHeader } from './ask.js';
import { conceptBySlug, hasAskedQuestion, projectKey, recentQuestions, ASKED_HISTORY, PASSING_GRADE } from './store.js';
import { recordAttemptCore } from './tools/record_attempt.js';
import { OPEN_PHASES, PANEL_EXPIRY_HOURS, panelPresentation, recordHeartbeat, type HostReport } from './panel-state.js';

/**
 * Pending questions for the quiz side panel.
 *
 * The model writes a question and hands it to `presentQuestion`, which returns
 * at once; a Claude Code mod shows it and sends the learner's answer to
 * `panelAnswer`, which grades it from the key the model wrote and records it
 * through the same code `record_attempt` runs. The row is the once-only guard:
 * the attempt and the row's `answered` phase are written in one transaction, so
 * no retry, crash or double click can record a question twice.
 *
 * Presenting a question writes no attempt, so a pending row never moves mastery.
 */


export interface PresentOption {
  label: string;
  description: string;
  /** 4 for the right option, 2 for a near miss, 1 for one built on a misconception. */
  grade: number;
  correct?: boolean;
}

export interface PresentInput {
  slug: string;
  question: string;
  options: PresentOption[];
  explanation: string;
  difficulty: number;
  session_id?: string;
  cwd?: string;
}

interface Row {
  id: string;
  session_id: string;
  repo: string;
  concept_id: number;
  tier: number;
  stem: string;
  options: string;
  key: string;
  explanation: string;
  phase: string;
  attempt_id: number | null;
  result: string | null;
}

interface StoredOption {
  id: string;
  label: string;
  note: string;
}

interface Key {
  correct_id: string;
  grades: Record<string, number>;
}

/** Open rows past their expiry become `expired`. Called first by every entry point. */
function expireStale(db: DB): void {
  db.prepare(
    `UPDATE panel_questions SET phase = 'expired', updated_at = datetime('now')
      WHERE phase IN ${OPEN_PHASES} AND created_at < datetime('now', ?)`,
  ).run(`-${PANEL_EXPIRY_HOURS} hours`);
}

function openRow(db: DB, sessionId: string, repo: string): Row | undefined {
  return db
    .prepare(`SELECT * FROM panel_questions WHERE session_id = ? AND repo = ? AND phase IN ${OPEN_PHASES}`)
    .get(sessionId, repo) as Row | undefined;
}

/**
 * Stores a question the model has written and returns immediately. Placement of
 * the right option is enforced here, not trusted: the planner computes it, and a
 * model that ignores it would put the answer in the same slot every time.
 */
export function presentQuestion(db: DB, args: PresentInput) {
  const { config, repoRoot } = loadConfig(args.cwd);
  const sessionId = resolveSessionId(db, args.session_id, args.cwd);
  const repo = projectKey(repoRoot);
  // Off is inert.
  if (!config.quiz.panel) {
    return { error: 'panel_disabled', detail: 'The side panel is off. Ask with AskUserQuestion, as the plan says.' };
  }
  expireStale(db);
  const slug = normalizeSlug(args.slug);
  const concept = conceptBySlug(db, slug);
  if (!concept) {
    return {
      error: 'unknown_concept',
      slug,
      detail: 'No concept with that slug. Call upsert_concepts or log_session_concepts first.',
    };
  }

  const open = openRow(db, sessionId, repo);
  if (open) {
    return {
      error: 'question_open',
      question_id: open.id,
      detail: 'A question is already waiting in the panel for this session. Do not present another; carry on with the task.',
    };
  }

  // A mod that is not reporting in is no place to leave a question: it would sit
  // unseen and block this session's next one for a day. The learner gets the
  // question card instead, which is what `presentation` in the plan said. After
  // the open-row check, so a question already waiting is named as such.
  if (panelPresentation(db, config, sessionId) !== 'panel') {
    return { error: 'panel_unavailable', detail: 'No side panel is showing questions in this session. Ask with AskUserQuestion instead.' };
  }

  const labels = args.options.map((o) => o.label.trim().toLowerCase());
  const correctAt = args.options.flatMap((o, i) => (o.correct ? [i] : []));
  const badGrade = args.options.some((o) => (o.correct ? o.grade !== 4 : o.grade !== 1 && o.grade !== 2));
  if (
    args.options.length !== MCQ_OPTION_COUNT ||
    new Set(labels).size !== labels.length ||
    correctAt.length !== 1 ||
    badGrade
  ) {
    return {
      error: 'invalid_options',
      detail: `Give exactly ${MCQ_OPTION_COUNT} options with different labels, exactly one with correct: true and grade 4; every other option grade 2 (right shape, wrong in the way that matters) or 1 (built on a misconception). Nothing was stored.`,
    };
  }

  const expected = answerPosition(concept.slug, recentQuestions(db, concept.id, ASKED_HISTORY).length);
  if (correctAt[0]! + 1 !== expected) {
    return {
      error: 'wrong_answer_position',
      expected,
      detail: `Put the correct option in slot ${expected} (1-${MCQ_OPTION_COUNT}), as the plan's answer_position says. Nothing was stored.`,
    };
  }

  const stem = stripAskHeader(args.question);
  const repeat = hasAskedQuestion(db, concept.id, stem);
  const options: StoredOption[] = args.options.map((o, i) => ({ id: `o${i + 1}`, label: o.label, note: o.description }));
  const key: Key = {
    correct_id: `o${correctAt[0]! + 1}`,
    grades: Object.fromEntries(args.options.map((o, i) => [`o${i + 1}`, o.grade])),
  };
  const id = randomUUID();
  db.prepare(
    `INSERT INTO panel_questions (id, session_id, repo, concept_id, tier, stem, options, key, explanation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sessionId, repo, concept.id, args.difficulty, stem, JSON.stringify(options), JSON.stringify(key), args.explanation);

  return {
    question_id: id,
    status: 'presented',
    ...(repeat ? { repeat_question: true } : {}),
    next: 'The panel shows it and records the answer. Do not wait, do not ask anything else, and do not call record_attempt; carry on with the task.',
  };
}

export interface SyncInput {
  session_id: string;
  cwd: string;
  host: HostReport;
  placed?: { question_id: string; ok: boolean; reason?: string };
}

/**
 * What the mod asks on every lifecycle event: is a question waiting here? The
 * reply never carries the key, the grades or the explanation, so nothing the
 * mod holds can reveal the answer before it is given.
 */
export function panelSync(db: DB, args: SyncInput) {
  const { config, repoRoot } = loadConfig(args.cwd);
  // Off is inert: no heartbeat, no row read, nothing for the mod to show.
  if (!config.quiz.panel) return { disabled: true };
  const repo = projectKey(repoRoot);
  expireStale(db);
  recordHeartbeat(db, args.session_id, args.host, args.placed?.ok);
  const row = openRow(db, args.session_id, repo);
  if (!row) return { none: true };

  // The mod reports whether the host could seat the pane. An invisible question
  // is never counted as shown: it waits as `unplaced` until a later open works.
  const placed = args.placed;
  let phase = row.phase;
  if (placed && placed.question_id === row.id) {
    const next = placed.ok ? (phase === 'unplaced' ? 'pending' : phase) : phase === 'pending' ? 'unplaced' : phase;
    if (next !== phase) {
      db.prepare("UPDATE panel_questions SET phase = ?, updated_at = datetime('now') WHERE id = ?").run(next, row.id);
      phase = next;
    }
  }

  const concept = db.prepare('SELECT name FROM concepts WHERE id = ?').get(row.concept_id) as { name: string };
  return {
    question_id: row.id,
    repo: row.repo,
    stem: row.stem,
    options: JSON.parse(row.options) as StoredOption[],
    phase,
    concept_name: concept.name,
    tier: row.tier,
  };
}

export interface AnswerInput {
  question_id: string;
  session_id: string;
  repo: string;
  /** The session's working directory: where this project's settings are read from. */
  cwd: string;
  kind: 'choice' | 'text' | 'skip';
  option_id?: string;
  text?: string;
  /** For `text`: the grader's verdict, validated here. */
  grade?: number;
  outcome?: 'answered' | 'dont_know';
  feedback?: string;
}

/**
 * Grades and records one answer, exactly once. A second call for the same
 * question returns the stored reply and writes nothing.
 */
export function panelAnswer(db: DB, args: AnswerInput) {
  return db.transaction(() => {
    expireStale(db);
    const row = db.prepare('SELECT * FROM panel_questions WHERE id = ?').get(args.question_id) as Row | undefined;
    if (!row) return { error: 'unknown_question' };
    // Another session, another project, or a question that timed out.
    if (
      row.session_id !== args.session_id ||
      row.repo !== args.repo ||
      projectKey(loadConfig(args.cwd).repoRoot) !== row.repo ||
      row.phase === 'expired'
    ) {
      return { error: 'stale_question' };
    }
    if (row.result) return JSON.parse(row.result) as Record<string, unknown>;

    const options = JSON.parse(row.options) as StoredOption[];
    const key = JSON.parse(row.key) as Key;
    const picked = options.find((o) => o.id === args.option_id);
    const typed = (args.text ?? '').trim();
    if (
      (args.kind === 'choice' && !picked) ||
      (args.kind === 'text' &&
        (!typed || !Number.isInteger(args.grade) || args.grade! < 0 || args.grade! > 5 ||
          (args.outcome !== 'answered' && args.outcome !== 'dont_know') ||
          (args.outcome === 'dont_know' && args.grade !== 0)))
    ) {
      return { error: 'invalid_answer', detail: 'Nothing was recorded.' };
    }

    // The table the handoff fixes: a pick takes the grade the model wrote beside
    // it, typed words take the grader's, a skip is a decline.
    const correctLabel = options.find((o) => o.id === key.correct_id)!.label;
    const grade = args.kind === 'choice' ? key.grades[picked!.id]! : args.kind === 'text' ? args.grade! : 0;
    const concept = db.prepare('SELECT slug FROM concepts WHERE id = ?').get(row.concept_id) as { slug: string };
    const recorded = recordAttemptCore(db, {
      session_id: row.session_id,
      cwd: args.cwd,
      slug: concept.slug,
      question: row.stem,
      answer: args.kind === 'choice' ? picked!.label : args.kind === 'text' ? typed : undefined,
      grade,
      difficulty: row.tier,
      feedback: args.kind === 'choice' ? row.explanation : args.kind === 'text' ? args.feedback : undefined,
      outcome: args.kind === 'skip' ? 'declined' : args.kind === 'text' ? args.outcome : 'answered',
      // Free recall carries no format, so it is not capped at 4.
      format: args.kind === 'text' ? undefined : 'mcq',
      options: options.map((o) => o.label),
      correct: correctLabel,
      option_notes: options.map((o) => o.note),
    }) as Record<string, any>;
    if ('error' in recorded) return recorded;

    const phase = args.kind === 'skip' ? 'skipped' : 'answered';
    const isRight = args.kind === 'choice' ? picked!.id === key.correct_id : args.outcome === 'answered' && grade >= PASSING_GRADE;
    const result = {
      phase,
      attempt_id: recorded.attempt_id as number,
      ...(args.kind === 'skip'
        ? {}
        : {
            correct: isRight,
            ...(isRight ? {} : { correct_label: correctLabel }),
            explanation: args.kind === 'text' && args.feedback ? args.feedback : row.explanation,
          }),
      ...(recorded.level_up ? { level_up: { from: recorded.level_up.from, to: recorded.level_up.to } } : {}),
      ...(recorded.explain ? { explain: recorded.explain } : {}),
    };
    // Same transaction as the attempt: both land or neither does.
    db.prepare(
      "UPDATE panel_questions SET phase = ?, attempt_id = ?, result = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(phase, result.attempt_id, JSON.stringify(result), row.id);
    return result;
  }).immediate();
}
