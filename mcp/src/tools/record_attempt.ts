import { z } from 'zod';
import { loadConfig } from '../config.js';
import { normalizeSlug } from '../slug.js';
import { decayedScore, isKnown } from '../srs.js';
import { resolveSessionId } from '../session.js';
import { conceptBySlug, gradeConcept, logSessionConcept, syncGate } from '../store.js';
import { CWD_HINT, SESSION_HINT, type ToolDef } from './types.js';

export const recordAttempt: ToolDef = {
  name: 'record_attempt',
  title: 'Record a quiz attempt',
  description:
    'Grade one answer on the 0-5 SM-2 scale and persist it. Updates mastery, the next review date and the session gate. Record skips too, as grade 0 with feedback "skipped".',
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
    },
    { db },
  ) => {
    const now = new Date();
    const { config } = loadConfig(args.cwd);
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
        now,
      });
    })();

    const gate = syncGate(db, sessionId, config);
    const score = decayedScore(state.score, state.next_review, now);

    return {
      slug: concept.slug,
      new_score: Number(state.score.toFixed(3)),
      next_review: state.next_review,
      interval_days: state.interval_d,
      reps: state.reps,
      ease: Number(state.ease.toFixed(2)),
      known: isKnown({ score, reps: state.reps }),
      gate,
    };
  },
};
