import { z } from 'zod';
import { loadConfig } from '../config.js';
import { normalizeSlug } from '../slug.js';
import { decayedScore, isKnown } from '../srs.js';
import { resolveSessionId } from '../session.js';
import {
  conceptBySlug,
  gradeConcept,
  hasAskedQuestion,
  logSessionConcept,
  syncGate,
  MAX_MCQ_GRADE,
  type AttemptOutcome,
  type QuestionFormat,
} from '../store.js';
import { CWD_HINT, SESSION_HINT, type ToolDef } from './types.js';

export const recordAttempt: ToolDef = {
  name: 'record_attempt',
  title: 'Record a quiz attempt',
  description:
    'Grade one answer on the 0-5 SM-2 scale and persist it. Updates mastery, the next review date and the session gate. Record every response, including "I don\'t know" (grade 0, outcome dont_know, after you have taught it) and declines (grade 0, outcome declined). Pass format and, for multiple choice, the options you offered — put only the stem in question, never the options, or the repeat check breaks. Multiple choice is capped at grade 4: picking one of four cannot show you know why.',
  inputSchema: {
    session_id: z.string().optional().describe(SESSION_HINT),
    cwd: z.string().optional().describe(CWD_HINT),
    slug: z.string().describe('The concept that was asked about.'),
    question: z
      .string()
      .describe(
        'The question stem exactly as asked — WITHOUT the options. This text is what stops the same question coming back later, so options baked in here would make every reshuffle look like a new question.',
      ),
    answer: z
      .string()
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
    feedback: z.string().optional().describe('The short explanation you gave back.'),
    format: z
      .enum(['mcq', 'fill_blank', 'open'])
      .optional()
      .describe(
        'How you put the question. "mcq" is the default shape — four options via AskUserQuestion. Say so, because a correct multiple-choice answer is weaker evidence than a correct free one and is graded accordingly.',
      ),
    options: z
      .array(z.string())
      .optional()
      .describe('For mcq: the option labels you offered, in the order shown. Not the stem.'),
    outcome: z
      .enum(['answered', 'dont_know', 'declined'])
      .optional()
      .describe(
        'Why the grade is what it is. "answered" they attempted it; "dont_know" they said they did not know and you taught it; "declined" they chose to skip. Grade 0 covers the last two, so this is the only thing that tells them apart later.',
      ),
  },
  handler: (
    args: {
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
    },
    { db },
  ) => {
    const now = new Date();
    const { config, repoRoot } = loadConfig(args.cwd);
    const sessionId = resolveSessionId(db, args.session_id);

    const slug = normalizeSlug(args.slug);
    const concept = conceptBySlug(db, slug);
    if (!concept) {
      return {
        error: 'unknown_concept',
        slug,
        detail: 'No concept with that slug. Call upsert_concepts or log_session_concepts first.',
      };
    }

    // Checked before the write, or the question we are recording matches itself.
    const repeatQuestion = hasAskedQuestion(db, concept.id, args.question);

    // Enforced here rather than trusted to the tutor. Grade 5 means "explained
    // why", which choosing among four options cannot demonstrate; one in four is
    // a coin. Capping is visible in the response so a tutor that keeps awarding
    // 5s for multiple choice finds out.
    const capped = args.format === 'mcq' && args.grade > MAX_MCQ_GRADE;
    const grade = capped ? MAX_MCQ_GRADE : args.grade;

    const state = db.transaction(() => {
      // An attempt on a concept the session never logged still counts toward
      // `answered`, so quizzing on review debt is not free -- but it lands as
      // 'review', so it cannot satisfy a bar that the session's actual work set.
      // If the task did touch this concept, log_session_concepts has already
      // marked it 'work' and that wins.
      logSessionConcept(db, sessionId, concept.id, null, 'review');
      return gradeConcept(db, {
        conceptId: concept.id,
        sessionId,
        question: args.question,
        answer: args.answer ?? null,
        grade,
        difficulty: args.difficulty,
        feedback: args.feedback ?? null,
        format: args.format ?? null,
        options: args.options ?? null,
        // Left NULL rather than guessed when the tutor does not say. An absent
        // answer is a fair hint that nothing was attempted, but it cannot tell
        // "teach me" from "leave it" -- and inventing the difference here would
        // put a value in the column that nobody observed.
        outcome: args.outcome ?? null,
        now,
      });
    })();

    const gate = syncGate(db, sessionId, config, { repo: repoRoot });
    const score = decayedScore(state.score, state.next_review, now);

    return {
      slug: concept.slug,
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
      // PRD goal 2. Recorded either way — refusing the write would lose a real
      // answer — but the tutor is told, so the next question can be a new one.
      repeat_question: repeatQuestion,
      gate,
    };
  },
};
