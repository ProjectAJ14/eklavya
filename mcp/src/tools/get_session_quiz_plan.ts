import { z } from 'zod';
import { loadConfig } from '../config.js';
import { decayedScore, isDue, isKnown, nextTierToAsk } from '../srs.js';
import { resolveSessionId } from '../session.js';
import {
  attemptedConceptIds,
  lastAttempt,
  lastAttemptAt,
  masteryFor,
  recentQuestions,
  sessionConcepts,
  unmetPrereqs,
  type AskedQuestion,
  type ConceptRow,
} from '../store.js';
import { CWD_HINT, SESSION_HINT, type ToolDef } from './types.js';

interface PlanItem {
  slug: string;
  name: string;
  domain: string;
  description: string | null;
  tier_to_ask: number;
  context: string | null;
  last_grade: number | null;
  /** Questions already put to this learner about this concept. Do not repeat them. */
  asked_before: AskedQuestion[];
  /**
   * They blanked on this before and were taught it on the spot. Surfaced beside
   * `asked_before` rather than left inside it, because it changes how the next
   * question opens -- a follow-up to an explanation they have already had, not a
   * first encounter -- and a flag that has to be derived is a flag that gets
   * missed.
   */
  already_taught: boolean;
  /** Prerequisites they have not mastered — ask about these first, or drop a tier. */
  prereqs_unmet: string[];
  reason: 'unmastered' | 'due_review' | 'domain_review' | 'topic';
}

const ASKED_HISTORY = 3;

function minutesSince(iso: string | null, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  // SQLite datetime('now') is UTC without a zone marker; make that explicit.
  const t = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - t) / 60_000;
}

export const getSessionQuizPlan: ToolDef = {
  name: 'get_session_quiz_plan',
  title: 'Get session quiz plan',
  description:
    'What to quiz on right now and at what difficulty tier, chosen from this session\'s concepts and whatever is due for review. Pass a domain to plan a topic quiz instead. Every item carries asked_before (questions this learner has already been asked — never repeat one), already_taught (they blanked and you explained it, so the next question is a follow-up) and prereqs_unmet. Returns questions_needed: 0 when there is nothing worth asking.',
  inputSchema: {
    session_id: z.string().optional().describe(SESSION_HINT),
    cwd: z.string().optional().describe(CWD_HINT),
    max: z.number().int().min(1).max(10).optional().describe('Cap on questions. Defaults to the configured max_questions_per_task.'),
    domain: z
      .string()
      .optional()
      .describe('Plan a topic quiz on this domain instead of this session\'s work, e.g. "web-auth". Prerequisites are ordered first.'),
    slugs: z
      .array(z.string())
      .optional()
      .describe('Plan around these specific concepts. Use when the developer named a concept rather than a domain.'),
    ignore_cooldown: z
      .boolean()
      .optional()
      .describe('Set true when the developer asked to be quizzed. The cadence limit exists to stop nagging, not to refuse a request.'),
  },
  handler: (
    args: {
      session_id?: string;
      cwd?: string;
      max?: number;
      domain?: string;
      slugs?: string[];
      ignore_cooldown?: boolean;
    },
    { db },
  ) => {
    const now = new Date();
    const { config } = loadConfig(args.cwd);
    const sessionId = resolveSessionId(db, args.session_id);
    const max = args.max ?? config.max_questions_per_task;
    const topicMode = Boolean(args.domain || (args.slugs && args.slugs.length > 0));

    if (config.mode === 'off') {
      return { session_id: sessionId, questions_needed: 0, concepts: [], reason: 'mode_off' };
    }

    // Cooldown keeps ambient mode from nagging. It must never apply in enforced
    // mode, or a cooldown could make a commit gate unpassable (decision G5), and
    // it must never override an explicit request (`ignore_cooldown`).
    if (config.mode === 'ambient' && !args.ignore_cooldown) {
      const since = minutesSince(lastAttemptAt(db, sessionId), now);
      if (since < config.min_minutes_between_quizzes) {
        return {
          session_id: sessionId,
          questions_needed: 0,
          concepts: [],
          reason: 'cooldown',
          minutes_remaining: Math.ceil(config.min_minutes_between_quizzes - since),
        };
      }
    }

    const picked: PlanItem[] = [];
    const seen = new Set<string>();
    const domains = new Set<string>();
    // Concepts already answered in this session have had their turn. Re-offering
    // them is how a learner gets asked the same thing twice in five minutes.
    const alreadyAsked = attemptedConceptIds(db, sessionId);
    let skippedAsked = 0;

    const add = (
      concept: ConceptRow,
      context: string | null,
      reason: PlanItem['reason'],
    ): void => {
      if (seen.has(concept.slug) || picked.length >= max) return;
      if (alreadyAsked.has(concept.id)) {
        seen.add(concept.slug);
        skippedAsked += 1;
        return;
      }

      const m = masteryFor(db, concept.id);
      const score = decayedScore(m.score, m.next_review, now);
      const last = lastAttempt(db, concept.id);
      const asked = recentQuestions(db, concept.id, ASKED_HISTORY);

      seen.add(concept.slug);
      picked.push({
        slug: concept.slug,
        name: concept.name,
        domain: concept.domain,
        description: concept.description,
        tier_to_ask: nextTierToAsk({
          conceptTier: concept.tier,
          lastDifficulty: last?.difficulty ?? null,
          lastGrade: last?.grade ?? null,
          score,
        }),
        context,
        last_grade: last?.grade ?? null,
        asked_before: asked,
        already_taught: asked.some((a) => a.taught),
        prereqs_unmet: unmetPrereqs(db, concept.id, now),
        reason,
      });
    };

    if (topicMode) {
      // Topic quizzes go through the same engine as session quizzes, so a named
      // topic gets the same tier escalation and the same repeat protection.
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (args.domain) {
        clauses.push('c.domain = ?');
        params.push(args.domain);
      }
      if (args.slugs && args.slugs.length > 0) {
        clauses.push(`c.slug IN (${args.slugs.map(() => '?').join(',')})`);
        params.push(...args.slugs);
      }

      const rows = db
        .prepare(
          `SELECT c.* FROM concepts c
             LEFT JOIN mastery m ON m.concept_id = c.id
            WHERE (${clauses.join(' OR ')})
            ORDER BY c.tier ASC, c.slug ASC`,
        )
        .all(...params) as ConceptRow[];

      // Weakest and due-for-review first, prerequisites before dependents; a
      // concept they have mastered is only worth asking when review says so.
      const candidates = rows
        .map((c) => {
          const m = masteryFor(db, c.id);
          const score = decayedScore(m.score, m.next_review, now);
          return { c, score, known: isKnown({ score, reps: m.reps }), due: isDue(m.next_review, now) };
        })
        .filter((r) => !r.known || r.due)
        .sort((a, b) => {
          if (a.due !== b.due) return a.due ? -1 : 1;
          if (a.score !== b.score) return a.score - b.score;
          return a.c.tier - b.c.tier;
        });

      for (const cand of candidates) add(cand.c, null, 'topic');
    } else {
      const touched = sessionConcepts(db, sessionId);
      for (const c of touched) domains.add(c.domain);

      // (a) concepts this session touched that the learner has not mastered
      for (const c of touched) {
        const m = masteryFor(db, c.id);
        const score = decayedScore(m.score, m.next_review, now);
        if (!isKnown({ score, reps: m.reps })) add(c, c.context, 'unmastered');
      }

      // (b) concepts this session touched that are due for review
      for (const c of touched) {
        const m = masteryFor(db, c.id);
        if (isDue(m.next_review, now)) add(c, c.context, 'due_review');
      }

      // (c) anything else due in the same domains, so review debt gets paid down
      if (picked.length < max && domains.size > 0) {
        const placeholders = [...domains].map(() => '?').join(',');
        const rows = db
          .prepare(
            `SELECT c.* FROM concepts c
             JOIN mastery m ON m.concept_id = c.id
             WHERE c.domain IN (${placeholders}) AND m.next_review IS NOT NULL AND m.next_review <= ?
             ORDER BY m.next_review ASC`,
          )
          .all(...domains, now.toISOString()) as ConceptRow[];
        for (const c of rows) add(c, null, 'domain_review');
      }
    }

    // Foundations before what rests on them, so a quiz never leads with a
    // question the learner has no way to answer.
    picked.sort((a, b) => {
      if (a.prereqs_unmet.length !== b.prereqs_unmet.length) {
        return a.prereqs_unmet.length - b.prereqs_unmet.length;
      }
      return a.tier_to_ask - b.tier_to_ask;
    });

    if (picked.length === 0) {
      // Distinguish "nothing left to ask" from "nothing to ask about" — they
      // need different things said to the developer.
      return skippedAsked > 0
        ? {
            session_id: sessionId,
            questions_needed: 0,
            concepts: [],
            reason: 'already_covered',
            detail: `${skippedAsked} concept(s) were already asked about in this session.`,
          }
        : {
            session_id: sessionId,
            questions_needed: 0,
            concepts: [],
            reason: topicMode ? 'no_candidates' : 'nothing_logged',
          };
    }

    return {
      session_id: sessionId,
      questions_needed: picked.length,
      concepts: picked,
    };
  },
};
