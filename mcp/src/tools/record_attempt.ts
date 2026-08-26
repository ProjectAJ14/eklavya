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
  type AttemptOutcome,
} from '../store.js';
import { CWD_HINT, SESSION_HINT, type ToolDef } from './types.js';

export const recordAttempt: ToolDef = {
  name: 'record_attempt',
  title: 'Record a quiz attempt',
  description:
    'Grade one answer on the 0-5 SM-2 scale and persist it. Updates mastery, the next review date and the session gate. Record every response, including "I don\'t know" (grade 0, outcome dont_know, after you have taught it) and declines (grade 0, outcome declined).',
  inputSchema: {
    session_id: z.string().optional().describe(SESSION_HINT),
    cwd: z.string().optional().describe(CWD_HINT),
    slug: z.string().describe('The concept that was asked about.'),
    question: z.string().describe('The question exactly as asked.'),
    answer: z.string().optional().describe('The learner\'s answer verbatim. Omit for a skip.'),
    grade: z
      .number()
      .int()
      .min(0)
      .max(5)
      .describe('0 no answer/skip, 1-2 wrong, 3 correct but laboured, 4 correct, 5 correct and explained the why.'),
    difficulty: z.number().int().min(1).max(5).describe('The tier you actually asked at — use tier_to_ask from the plan.'),
    feedback: z.string().optional().describe('The short explanation you gave back.'),
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

    const state = db.transaction(() => {
      // An attempt on a concept the session never logged still counts toward the
      // gate, so quizzing on review debt is not free.
      logSessionConcept(db, sessionId, concept.id, null);
      return gradeConcept(db, {
        conceptId: concept.id,
        sessionId,
        question: args.question,
        answer: args.answer ?? null,
        grade: args.grade,
        difficulty: args.difficulty,
        feedback: args.feedback ?? null,
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
