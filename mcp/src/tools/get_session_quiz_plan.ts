import { z } from 'zod';
import { loadConfig } from '../config.js';
import { decayedScore, isDue, isKnown, nextTierToAsk } from '../srs.js';
import { resolveSessionId } from '../session.js';
import { lastAttempt, lastAttemptAt, masteryFor, sessionConcepts, type ConceptRow } from '../store.js';
import { CWD_HINT, SESSION_HINT, type ToolDef } from './types.js';

interface PlanItem {
  slug: string;
  name: string;
  domain: string;
  tier_to_ask: number;
  context: string | null;
  last_grade: number | null;
  reason: 'unmastered' | 'due_review' | 'domain_review';
}

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
    'What to quiz on right now and at what difficulty tier, chosen from this session\'s concepts and whatever is due for review. Returns questions_needed: 0 when there is nothing worth asking.',
  inputSchema: {
    session_id: z.string().optional().describe(SESSION_HINT),
    cwd: z.string().optional().describe(CWD_HINT),
    max: z.number().int().min(1).max(10).optional().describe('Cap on questions. Defaults to the configured max_questions_per_task.'),
  },
  handler: (args: { session_id?: string; cwd?: string; max?: number }, { db }) => {
    const now = new Date();
    const { config } = loadConfig(args.cwd);
    const sessionId = resolveSessionId(db, args.session_id);
    const max = args.max ?? config.max_questions_per_task;

    if (config.mode === 'off') {
      return { session_id: sessionId, questions_needed: 0, concepts: [], reason: 'mode_off' };
    }

    // Cooldown keeps ambient mode from nagging. It must never apply in enforced
    // mode, or a cooldown could make a commit gate unpassable (decision G5).
    if (config.mode === 'ambient') {
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

    const add = (
      concept: ConceptRow,
      context: string | null,
      reason: PlanItem['reason'],
    ): void => {
      if (seen.has(concept.slug) || picked.length >= max) return;
      const m = masteryFor(db, concept.id);
      const score = decayedScore(m.score, m.next_review, now);
      const last = lastAttempt(db, concept.id);

      seen.add(concept.slug);
      picked.push({
        slug: concept.slug,
        name: concept.name,
        domain: concept.domain,
        tier_to_ask: nextTierToAsk({
          conceptTier: concept.tier,
          lastDifficulty: last?.difficulty ?? null,
          lastGrade: last?.grade ?? null,
          score,
        }),
        context,
        last_grade: last?.grade ?? null,
        reason,
      });
    };

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

    return {
      session_id: sessionId,
      questions_needed: picked.length,
      concepts: picked,
    };
  },
};
