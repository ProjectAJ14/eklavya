import { z } from 'zod';
import { loadConfig } from '../config.js';
import type { DB } from '../db.js';
import { normalizeSlug } from '../slug.js';
import { decayedScore, isKnown } from '../srs.js';
import { resolveSessionId } from '../session.js';
import {
  conceptBySlug,
  gradeConcept,
  hasAskedQuestion,
  isMissed,
  levelStanding,
  logSessionConcept,
  promoteIfEarned,
  syncGate,
  MAX_MCQ_GRADE,
  PASSING_GRADE,
  type AttemptOutcome,
  type QuestionFormat,
} from '../store.js';
import { stripAskHeader } from '../ask.js';
import { CWD_HINT, LIMITS, SESSION_HINT, type ToolDef } from './types.js';

/**
 * What the tutor does with an `explain` block. Non-blocking is the whole
 * contract: the grade and the one-line verdict are already given, the page is
 * written by a background agent, and the session goes back to the work.
 */
export function explainInstruction(
  name: string,
  options: string[] | null,
  attemptId: number,
  notes: string[] | null,
  answer: string | null = null,
  correct: string | null = null,
): string {
  // The tutor relays this in its own words, and a paraphrase kept only the
  // picked and right options. Spelling them out makes the full list the thing
  // it copies.
  const list = options?.length
    ? ` Copy all ${options.length} options into its prompt, in this order, not just the picked and right ones: ${options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(' | ')}.`
    : '';
  // The note under each option is what the learner read in the question; the
  // page shows it too, so the two look alike.
  const noteLine = notes?.length ? ' Hand it the one-line note under each option as well, so the page shows each note under its option.' : '';
  // The panel takes the answer itself, so the agent reading this never saw the
  // pick; without it spelled out the page cannot mark the learner's option.
  const picked = answer ? ` The learner answered: ${answer}.` : '';
  const right = correct ? ` The right answer is: ${correct}.` : '';
  // The attempt id links the page to this row, which is what lets the
  // dashboard offer "Correct your answer" on it.
  const link = ` Tell it to pass --attempt ${attemptId} to eklavya artifacts new.`;
  return `Do not wait for this and do not explain further here. Start the eklavya-explainer agent (eklavya:eklavya-explainer when Eklavya is installed as a plugin) in the background, handing it the concept slug, the question, every option offered, the learner's answer and the right answer, so the page can show the question as it was asked.${list}${picked}${right}${noteLine}${link} It writes an explainer page on ${name} and opens it. Tell the learner in one line that they missed it, what the right answer is, and that a page on it is on its way, then carry on with the task.`;
}

export const recordAttempt: ToolDef = {
  name: 'record_attempt',
  title: 'Record a quiz attempt',
  description:
    'Grade one answer on the 0-5 SM-2 scale and persist it, returning its attempt_id. Updates mastery, the next review date, the session gate and this project\'s difficulty level. Record every response, including "I don\'t know" (grade 0, outcome dont_know, after you have taught it) and declines (grade 0, outcome declined); dont_know or declined with a grade of 3 or more is rejected with outcome_grade_conflict and nothing is recorded. Pass format "mcq" and the options you offered — question takes the stem alone, which is what the repeat check hashes; the options go in options. With every mcq also pass correct (the right option\'s label, verbatim) and option_notes (the description under each option, same order): they are what lets the learner correct a missed answer after reading its explainer. Multiple choice is capped at grade 4: picking one of four cannot show you know why; omit format only when they typed a real explanation instead of picking. Returns level and level_progress, and level_up on the answer that earns a promotion — say that in one line and move on. Returns explain on a missed answer when explain_on_wrong is on: follow its instruction.',
  inputSchema: {
    session_id: z.string().max(LIMITS.sessionId).optional().describe(SESSION_HINT),
    cwd: z.string().max(LIMITS.cwd).optional().describe(CWD_HINT),
    slug: z.string().max(LIMITS.slug).describe('The concept that was asked about.'),
    question: z
      .string()
      .max(LIMITS.question)
      .describe(
        'The question stem exactly as asked, and only the stem. This text is what stops the same question coming back later, so anything baked in here that moves — shuffled options, a dial in a bracketed line — would make one question look like several.',
      ),
    answer: z
      .string()
      .max(LIMITS.answer)
      .optional()
      .describe(
        'The learner\'s answer verbatim — for multiple choice, the option they picked (or what they typed under "Other"). Omit for a skip.',
      ),
    grade: z
      .number()
      .int()
      .min(0)
      .max(5)
      .describe('0 no answer/skip, 1-2 wrong, 3 correct but laboured, 4 correct, 5 correct and explained the why.'),
    difficulty: z.number().int().min(1).max(5).describe('The tier you actually asked at — use tier_to_ask from the plan.'),
    feedback: z.string().max(LIMITS.feedback).optional().describe('The short explanation you gave back.'),
    format: z
      .literal('mcq')
      .optional()
      .describe(
        'Pass "mcq" — the only shape Eklavya asks in: four options via AskUserQuestion. Say so, because a correct multiple-choice answer is weaker evidence than a correct free one and is capped accordingly. Omit it only when the learner picked "Other" and typed a real explanation, which is free recall and earns an uncapped grade.',
      ),
    options: z
      .array(z.string().max(LIMITS.option))
      .max(LIMITS.options)
      .optional()
      .describe('For mcq: the option labels you offered, in the order shown. Not the stem.'),
    correct: z
      .string()
      .max(LIMITS.option)
      .optional()
      .describe('For mcq: the right option\'s label, exactly as it appears in options. Grades a later correction; never shown to the learner by the server.'),
    option_notes: z
      .array(z.string().max(LIMITS.option))
      .max(LIMITS.options)
      .optional()
      .describe('For mcq: the one-line description shown under each option (AskUserQuestion\'s description), in the same order as options.'),
    outcome: z
      .enum(['answered', 'dont_know', 'declined'])
      .optional()
      .describe(
        'Why the grade is what it is. "answered" they attempted it; "dont_know" they said they did not know and you taught it; "declined" they chose to skip and you dropped it without explaining. Grade 0 covers the last two, so this is the only thing that tells them apart later -- and they are not interchangeable: a declined concept is never offered again, so labelling a blank as a decline removes it from the only route out of a blocked commit gate. If you taught it, it is "dont_know".',
      ),
  },
  handler: (args: RecordAttemptArgs, { db }) => recordAttemptCore(db, args),
};

export interface RecordAttemptArgs {
  session_id?: string;
  cwd?: string;
  slug: string;
  question: string;
  answer?: string;
  grade: number;
  difficulty: number;
  feedback?: string;
  outcome?: AttemptOutcome;
  format?: QuestionFormat;
  options?: string[];
  correct?: string;
  option_notes?: string[];
}

/**
 * Everything `record_attempt` does, as one function. The panel's `panel_answer`
 * calls it too, inside its own transaction, so the grade cap, the outcome
 * conflicts, promotion, the gate and the explain block exist exactly once.
 */
export function recordAttemptCore(db: DB, args: RecordAttemptArgs) {
  const now = new Date();
  const { config, repoRoot } = loadConfig(args.cwd);
  const sessionId = resolveSessionId(db, args.session_id, args.cwd);

  // A skip that claims a pass. "declined" and "dont_know" both say nothing was
  // answered, and a grade of 3 or more says it was answered correctly; one of
  // the two is wrong and nothing here can tell which. Rejected before any
  // write rather than corrected: keeping the grade would grant mastery and
  // clear a gate on a question nobody answered, and keeping the outcome would
  // throw away a grade that may have been real.
  if ((args.outcome === 'declined' || args.outcome === 'dont_know') && args.grade >= PASSING_GRADE) {
    return {
      error: 'outcome_grade_conflict',
      outcome: args.outcome,
      grade: args.grade,
      detail: `Outcome "${args.outcome}" means nothing was answered, so its grade is 0; a grade of ${PASSING_GRADE} or more means a correct answer, whose outcome is "answered". Nothing was recorded. Call again with whichever pair is true.`,
    };
  }

  const slug = normalizeSlug(args.slug);
  const concept = conceptBySlug(db, slug);
  if (!concept) {
    return {
      error: 'unknown_concept',
      slug,
      detail: 'No concept with that slug. Call upsert_concepts or log_session_concepts first.',
    };
  }

  // The settings line is presentation. Stripped rather than rejected, because the
  // tutor pasting back the block it displayed is the likely mistake and losing
  // a real answer over it would be the wrong trade.
  const question = stripAskHeader(args.question);

  // Which band this answer was earned at, read before the write so a promotion
  // triggered by this very attempt cannot relabel it.
  const standing = levelStanding(db, config, repoRoot);

  // Checked before the write, or the question we are recording matches itself.
  const repeatQuestion = hasAskedQuestion(db, concept.id, question);

  // Enforced here rather than trusted to the tutor. Grade 5 means "explained
  // why", which choosing among four options cannot demonstrate; one in four is
  // a coin. Capping is visible in the response so a tutor that keeps awarding
  // 5s for multiple choice finds out.
  // A decline you explained is a contradiction, and the likelier reading is a
  // mislabelled blank: the rule for a decline is to drop it immediately, so
  // there is nothing to write feedback about. Reported rather than corrected
  // -- rewriting a stated outcome would be guessing at what happened -- but
  // reported loudly, because silence here is what let 11 of 16 declines in a
  // real history carry an explanation with nobody noticing.
  const outcomeConflict =
    args.outcome === 'declined' && typeof args.feedback === 'string' && args.feedback.trim().length > 0;

  // A key that does not line up with the options cannot grade a correction,
  // so it is stored as NULL -- but the answer is real, and losing it would be
  // the worse trade, so the attempt is recorded and the tutor told.
  const options = args.options ?? null;
  const correctOk = args.correct === undefined || (options?.includes(args.correct) ?? false);
  const correct = correctOk ? (args.correct ?? null) : null;
  const notesOk = args.option_notes === undefined || args.option_notes.length === (options?.length ?? 0);
  const optionNotes = notesOk ? (args.option_notes ?? null) : null;

  const capped = args.format === 'mcq' && args.grade > MAX_MCQ_GRADE;
  const grade = capped ? MAX_MCQ_GRADE : args.grade;

  const graded = db.transaction(() => {
    // An attempt on a concept the session never logged still counts toward
    // `answered`, so quizzing on review debt is not free -- but it lands as
    // 'review', so it cannot satisfy a bar that the session's actual work set.
    // If the task did touch this concept, log_session_concepts has already
    // marked it 'work' and that wins.
    logSessionConcept(db, sessionId, concept.id, null, 'review');
    const next = gradeConcept(db, {
      conceptId: concept.id,
      sessionId,
      question,
      answer: args.answer ?? null,
      grade,
      difficulty: args.difficulty,
      feedback: args.feedback ?? null,
      format: args.format ?? null,
      options,
      correct,
      optionNotes,
      // Left NULL rather than guessed when the tutor does not say. An absent
      // answer is a fair hint that nothing was attempted, but it cannot tell
      // "teach me" from "leave it" -- and inventing the difference here would
      // put a value in the column that nobody observed.
      outcome: args.outcome ?? null,
      repo: standing.repo,
      level: standing.level,
      now,
    });

    // In the same transaction as the grade: a promotion is a fact about
    // attempt rows, and a crash between the two would leave a level claiming
    // evidence that was rolled back.
    const promotion = promoteIfEarned(db, config, repoRoot);

    // The gate too. `registerTools` retries the whole handler on SQLITE_BUSY,
    // which is only safe when every write here rolls back together: with the
    // gate written after the commit, a lock on it retried a grade that had
    // already landed, and one answer became two attempt rows and a rung of
    // the SM-2 ladder the learner never climbed.
    const gate = syncGate(db, sessionId, config, { repo: repoRoot });
    return { state: next, promotion, gate };
  })();

  const state = graded.state;
  const gate = graded.gate;

  // A missed answer, when the developer asked for pages on those. Decided
  // here rather than left to a line in the tutor skill: the model follows a
  // field it was handed far more reliably than a rule it has to remember, and
  // the instruction is composed once, where the config is visible. A decline
  // and a bare skip get nothing -- they asked to move on.
  const missed = isMissed(grade, args.outcome ?? null);
  const explain = config.explain_on_wrong && missed
    ? {
        concept: concept.slug,
        name: concept.name,
        question,
        options,
        option_notes: optionNotes,
        answer: args.answer ?? null,
        correct,
        attempt_id: state.attemptId,
        instruction: explainInstruction(concept.name, options, state.attemptId, optionNotes, args.answer ?? null, correct),
      }
    : null;
  const after = levelStanding(db, config, repoRoot);
  const score = decayedScore(state.score, state.next_review, now);

  return {
    slug: concept.slug,
    attempt_id: state.attemptId,
    recorded_grade: grade,
    // Silence here would let the tutor keep miscalibrating; say what was
    // changed and why.
    ...(capped
      ? {
          grade_capped: true,
          detail: `Multiple choice is capped at ${MAX_MCQ_GRADE}: recognising the right option does not show you can explain it. Recorded ${grade} instead of ${args.grade}.`,
        }
      : {}),
    new_score: Number(state.score.toFixed(3)),
    next_review: state.next_review,
    interval_days: state.interval_d,
    reps: state.reps,
    ease: Number(state.ease.toFixed(2)),
    known: isKnown({ score, reps: state.reps }),
    // Never the same question twice. Recorded either way — refusing the
    // write would lose a real answer — but the tutor is told, so the next
    // question can be a new one.
    repeat_question: repeatQuestion,
    ...(explain ? { explain } : {}),
    ...(correctOk
      ? {}
      : {
          correct_mismatch:
            'correct was not one of the options, so this answer cannot be corrected later. Pass the right option\'s label verbatim, exactly as it appears in options.',
        }),
    ...(notesOk
      ? {}
      : {
          option_notes_mismatch:
            'option_notes needs one note per option, in the same order as options. They were not stored.',
        }),
    ...(outcomeConflict
      ? {
          outcome_conflict:
            'You passed outcome "declined" and also feedback. A decline is dropped without explanation, so if you taught this concept it was a blank: record outcome "dont_know". It matters — a declined concept is never offered again, and in enforced mode that is the only way out of a blocked commit.',
        }
      : {}),
    gate,
    level: after.level,
    // The runway, said in numbers. A level nobody can see the progress toward
    // is a level that feels identical in week one and week ten.
    level_progress: {
      passed: after.counts.passed,
      needed: after.needed.answers,
      answered: after.counts.answered,
      accuracy: after.accuracy,
      min_accuracy: after.needed.accuracy,
      concepts: after.counts.concepts,
      needed_concepts: after.needed.concepts,
      next: after.next,
      ...(after.pinned ? { pinned: true } : {}),
      ...(after.unmet.length > 0 ? { unmet: after.unmet } : {}),
    },
    ...(graded.promotion
      ? {
          level_up: {
            from: graded.promotion.from,
            to: graded.promotion.to,
            passed: graded.promotion.counts.passed,
            accuracy: Number(
              (graded.promotion.counts.passed / Math.max(1, graded.promotion.counts.answered)).toFixed(3),
            ),
            detail: `Say this in one line and go back to the task: they have cleared ${graded.promotion.from} on this project, and questions now come from the ${graded.promotion.to} band.`,
          },
        }
      : {}),
  };
}
