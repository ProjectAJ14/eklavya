import { z } from 'zod';
import { loadConfig, type Focus } from '../config.js';
import { clampToLevel, decayedScore, isDue, isKnown, nextTierToAsk, type Level } from '../srs.js';
import { answerPosition } from '../mcq.js';
import { askFooter } from '../ask.js';
import { resolveSessionId } from '../session.js';
import {
  attemptedConceptIds,
  domainSiblings,
  gateRetryConcepts,
  gateRow,
  prereqsOf,
  resolveTopic,
  lastAttempt,
  lastAttemptAt,
  levelStanding,
  masteryFor,
  recentQuestions,
  sessionConcepts,
  unmetPrereqs,
  wasEverTaught,
  type AskedQuestion,
  type ConceptRow,
  type QuestionFormat,
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
  /**
   * How to put the question. Server-side rather than left to the tutor, for the
   * same reason `tier_to_ask` is: a shape chosen per question by whoever is
   * writing it is a shape that drifts.
   *
   * Always `mcq` today. A blank prompt mid-task is a bad interface for a quiz
   * nobody asked for -- the honest answer to a free-form question is often
   * silence, not because the learner does not know but because typing a
   * paragraph costs more than the question is worth. Recognition is cheap to
   * answer and still teaches. The next phase adds cued recall and free recall
   * and picks between the three by tier and mastery, which is why this is a
   * field and not a constant the tutor is told once.
   */
  format_to_use: QuestionFormat;
  /**
   * 1-based slot the correct option must occupy. Decided here because a model
   * asked to place it itself puts it first almost every time, and a learner who
   * notices that has stopped answering the question and started reading the
   * layout. See `mcq.ts`.
   */
  answer_position: number;
  /**
   * The line to print under the stem, naming the settings that asked: the focus,
   * the project's level and this question's tier. Absent when `quiet` is set.
   * Display it, never record it -- see `record_attempt`.
   */
  ask_footer?: string;
  /**
   * `learn` focus only: this topic concept also turned up in the session's work,
   * and this is the code where. The topic is still the subject -- the diff is
   * the example that makes it concrete.
   */
  bridge_context?: string;
  reason:
    | 'unmastered'
    | 'due_review'
    | 'domain_review'
    | 'topic'
    | 'gate_retry'
    | 'concept_widening'
    | 'learn_topic';
}

/**
 * What the tutor must do with the questions, stated per focus so the pedagogy
 * cannot drift from the setting. Returned with every plan.
 */
const FRAMING: Record<Focus, string> = {
  project:
    'Ground every question in the diff just written: name the file, the line, the decision. The code is the subject.',
  concept:
    'Ask the transferable version. The diff is the motivation, not the subject: open from what was just written, then ask for the general rule, the class of problem, or where else it applies. A correct answer must be usable on a different codebase. Do not ask for a definition -- that is tier 1 recall, not generalisation.',
  learn:
    'Teach the declared topic, in prerequisite order. Where an item carries bridge_context, the session touched that concept: use that real code as the worked example instead of a hypothetical. Where it does not, teach it on its own terms -- do not force a link to unrelated work.',
};

/**
 * What the project's level permits, stated per level for the same reason
 * `FRAMING` is stated per focus: the tier number alone does not stop a tutor
 * writing a judgement question and labelling it tier 2.
 */
const LEVEL_FRAMING: Record<Level, string> = {
  easy:
    'Level easy (tiers 1-2). Ask what a thing is and what the machine does with it. No judgement questions, no failure modes, no design. They have been watching the agent work, and every question must be answerable from that -- this is the runway that makes the habit stick, not a warm-up to hurry through.',
  medium:
    'Level medium (tiers 2-4). Mechanism, then why this choice rather than the obvious alternative, then what breaks it. Definitions are spent at this level.',
  hard:
    'Level hard (tiers 3-5). Judgement, failure modes and design: when is this the wrong approach entirely, and how would they notice in production. A definition question is a wasted question here.',
};

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
    'What to quiz on right now and at what difficulty tier, chosen from this session\'s concepts and whatever is due for review. Pass a domain to plan a topic quiz instead. Every item carries asked_before (questions this learner has already been asked — never repeat one), already_taught (they blanked and you explained it, so the next question is a follow-up) and prereqs_unmet. In enforced mode, once everything else is exhausted and the gate is still unpassed, it re-offers concepts that were blanked on and taught, a tier lower, with reason "gate_retry". Honours the configured focus: "project" plans from the diff, "concept" widens to prerequisites and domain siblings, "learn" plans from focus_topic and marks overlaps with the session\'s work as bridge_context. Every plan carries focus and framing — follow framing, it is what the setting means. Each item carries format_to_use, currently always "mcq": ask it with AskUserQuestion as four options, never as a blank prompt. Each item also carries answer_position (1-4) — put the correct option in exactly that slot, or the right answer ends up first every time and the learner stops reading the options. Every tier is clamped to this project\'s difficulty level (easy 1-2, medium 2-4, hard 3-5), which is earned per project and returned as level with level_framing — obey it: a tier-4 question at level easy is the failure this exists to prevent. Each item carries ask_footer, the line naming the settings that asked; print it under the stem, and never pass it back in record_attempt. Returns questions_needed: 0 when there is nothing worth asking.',
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
    focus: z
      .enum(['project', 'concept', 'learn'])
      .optional()
      .describe('Override the configured focus for this one plan. Omit to use the config.'),
  },
  handler: (
    args: {
      session_id?: string;
      cwd?: string;
      max?: number;
      domain?: string;
      slugs?: string[];
      ignore_cooldown?: boolean;
      focus?: Focus;
    },
    { db },
  ) => {
    const now = new Date();
    const { config, repoRoot } = loadConfig(args.cwd);
    const sessionId = resolveSessionId(db, args.session_id);
    const max = args.max ?? config.max_questions_per_task;
    const focus: Focus = args.focus ?? config.focus;
    // The band this project is on. Every tier below is clamped into it, so a
    // learner three sessions in cannot be handed a tier-4 question by an
    // escalation rule that only knows about one concept at a time.
    const standing = levelStanding(db, config, repoRoot);

    // `learn` focus turns the configured topic into the same domain/slug
    // selection an explicit topic quiz uses, so it goes through one engine with
    // one set of tier and repeat rules. An explicit domain or slugs still win:
    // the developer naming a topic outranks a standing setting.
    let effDomain = args.domain;
    let effSlugs = args.slugs;
    let topicUnresolved = false;
    const explicitTopic = Boolean(args.domain || (args.slugs && args.slugs.length > 0));

    if (!explicitTopic && focus === 'learn') {
      if (!config.focus_topic) {
        return {
          session_id: sessionId,
          questions_needed: 0,
          concepts: [],
          focus,
          reason: 'no_topic',
          detail: 'Focus is "learn" but no focus_topic is set. Ask what they want to learn, then set_config focus_topic.',
        };
      }
      const match = resolveTopic(db, config.focus_topic);
      if (match.domain) effDomain = match.domain;
      else if (match.slugs.length > 0) effSlugs = match.slugs;
      else topicUnresolved = true;
    }

    const topicMode = Boolean(effDomain || (effSlugs && effSlugs.length > 0));

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

    // The graph has nothing on this topic yet. Saying so is the useful answer;
    // inventing questions about concepts that do not exist is not.
    if (topicUnresolved) {
      return {
        session_id: sessionId,
        questions_needed: 0,
        concepts: [],
        focus,
        topic: config.focus_topic,
        reason: 'topic_unknown',
        detail: `Nothing in the graph matches "${config.focus_topic}". Offer the closest domain from get_concept_graph, or teach from first principles and upsert_concepts as you go.`,
      };
    }

    const picked: PlanItem[] = [];
    const seen = new Set<string>();
    // Where the session's own work touched a concept. In `learn` focus this is
    // what turns an abstract topic question into one about code they just saw.
    const sessionContext = new Map<string, string>();
    for (const c of sessionConcepts(db, sessionId)) {
      if (c.context) sessionContext.set(c.slug, c.context);
    }
    const domains = new Set<string>();
    // Concepts already answered in this session have had their turn. Re-offering
    // them is how a learner gets asked the same thing twice in five minutes.
    const alreadyAsked = attemptedConceptIds(db, sessionId);
    let skippedAsked = 0;

    const add = (
      concept: ConceptRow,
      context: string | null,
      reason: PlanItem['reason'],
      // The gate-retry pass is the one caller allowed past the already-asked
      // filter, and it drops a tier because it is re-opening a concept the
      // learner has just been taught rather than testing a fresh one.
      opts: { retry?: boolean } = {},
    ): void => {
      if (seen.has(concept.slug) || picked.length >= max) return;
      if (!opts.retry && alreadyAsked.has(concept.id)) {
        seen.add(concept.slug);
        skippedAsked += 1;
        return;
      }

      const m = masteryFor(db, concept.id);
      const score = decayedScore(m.score, m.next_review, now);
      const last = lastAttempt(db, concept.id);
      const asked = recentQuestions(db, concept.id, ASKED_HISTORY);

      const tier = clampToLevel(
        nextTierToAsk({
          conceptTier: concept.tier,
          lastDifficulty: last?.difficulty ?? null,
          lastGrade: last?.grade ?? null,
          score,
        }),
        standing.level,
      );
      // A retry drops a tier because the concept has just been taught rather than
      // tested -- but never below the band, or `easy` would ask tier 0.
      const tierToAsk = opts.retry ? clampToLevel(tier - 1, standing.level) : tier;
      const footer = askFooter({
        config,
        level: standing.level,
        pinned: standing.pinned,
        tier: tierToAsk,
      });

      seen.add(concept.slug);
      picked.push({
        slug: concept.slug,
        name: concept.name,
        domain: concept.domain,
        description: concept.description,
        tier_to_ask: tierToAsk,
        context,
        ...(footer ? { ask_footer: footer } : {}),
        // Only in `learn` focus, and only when the topic concept really did turn
        // up in this session's work. Absent means "teach it on its own terms",
        // which is different from "no context available".
        ...(focus === 'learn' && sessionContext.has(concept.slug)
          ? { bridge_context: sessionContext.get(concept.slug)! }
          : {}),
        last_grade: last?.grade ?? null,
        asked_before: asked,
        already_taught: wasEverTaught(db, concept.id),
        prereqs_unmet: unmetPrereqs(db, concept.id, now),
        format_to_use: 'mcq',
        answer_position: answerPosition(concept.slug, asked.length),
        reason,
      });
    };

    if (topicMode) {
      // Topic quizzes go through the same engine as session quizzes, so a named
      // topic gets the same tier escalation and the same repeat protection.
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (effDomain) {
        clauses.push('c.domain = ?');
        params.push(effDomain);
      }
      if (effSlugs && effSlugs.length > 0) {
        clauses.push(`c.slug IN (${effSlugs.map(() => '?').join(',')})`);
        params.push(...effSlugs);
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

      // `learn_topic` and `topic` run the same selection; they differ only in
      // why the topic was chosen, which is what the tutor needs in order to
      // frame the question.
      const topicReason = !explicitTopic && focus === 'learn' ? 'learn_topic' : 'topic';
      for (const cand of candidates) {
        add(cand.c, sessionContext.get(cand.c.slug) ?? null, topicReason);
      }
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

      // `concept` focus: reach past what the task happened to touch. The ideas
      // the diff is an instance of live in its prerequisites and its domain
      // siblings, and asking only about what the diff contains is how a quiz
      // stays stuck at "what does this line do".
      //
      // Deliberately before (c): a prerequisite of today's work is more use than
      // an unrelated concept that happens to be due.
      if (focus === 'concept' && picked.length < max) {
        const touchedIds = touched.map((c) => c.id);
        const exclude = new Set(touchedIds);

        for (const c of prereqsOf(db, touchedIds)) {
          const m = masteryFor(db, c.id);
          if (!isKnown({ score: decayedScore(m.score, m.next_review, now), reps: m.reps })) {
            // Null context on purpose. In concept focus the diff is the
            // motivation, not the subject, and handing over a line of code
            // invites exactly the grounded-in-the-file question this focus
            // exists to avoid.
            add(c, null, 'concept_widening');
          }
        }

        for (const c of domainSiblings(db, [...domains], exclude)) {
          if (picked.length >= max) break;
          const m = masteryFor(db, c.id);
          if (!isKnown({ score: decayedScore(m.score, m.next_review, now), reps: m.reps })) {
            add(c, null, 'concept_widening');
          }
        }
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

    // Enforced mode only, and only once everything else is exhausted: a session
    // answered entirely with "I don't know" grades every concept 0, and a graded
    // concept is filtered from the plan above -- so `required` can never be met,
    // the planner returns nothing, and pre-tool-gate.sh denies the commit while
    // telling the developer to run a quiz that has nothing left to ask. That is
    // a dead end with no route out inside the session.
    //
    // Ambient mode is deliberately left alone. It has no gate to deadlock, and
    // re-offering a concept there would be the nagging the cooldown exists to
    // prevent.
    if (!topicMode && picked.length === 0 && config.mode === 'enforced') {
      const gate = gateRow(db, sessionId);
      if (gate && gate.required > 0 && !gate.passed) {
        // `seen` carries two meanings: "already picked" and "considered and
        // rejected". Only the second is in it here -- nothing was picked, or we
        // would not be in this branch -- so clearing it drops exactly the
        // rejections the retry pass exists to reconsider, and cannot lose a pick.
        seen.clear();
        for (const c of gateRetryConcepts(db, sessionId)) {
          add(c, c.context, 'gate_retry', { retry: true });
        }
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

    // Numbered after the sort, so `q 2/3` is the order they will actually be
    // asked in. Only when there is more than one -- `q 1/1` is noise.
    if (picked.length > 1) {
      picked.forEach((item, i) => {
        const numbered = askFooter({
          config,
          level: standing.level,
          pinned: standing.pinned,
          tier: item.tier_to_ask,
          position: { index: i + 1, total: picked.length },
        });
        if (numbered) item.ask_footer = numbered;
      });
    }

    if (picked.length === 0) {
      // Distinguish "nothing left to ask" from "nothing to ask about" — they
      // need different things said to the developer.
      return skippedAsked > 0
        ? {
            session_id: sessionId,
            questions_needed: 0,
            concepts: [],
            focus,
            reason: 'already_covered',
            detail: `${skippedAsked} concept(s) were already asked about in this session.`,
          }
        : {
            session_id: sessionId,
            questions_needed: 0,
            concepts: [],
            focus,
            reason: topicMode ? 'no_candidates' : 'nothing_logged',
          };
    }

    return {
      session_id: sessionId,
      questions_needed: picked.length,
      focus,
      // Stated with every plan so the pedagogy cannot drift from the setting:
      // the tutor should not have to remember what `concept` implies.
      framing: FRAMING[focus],
      ...(focus === 'learn' && config.focus_topic ? { topic: config.focus_topic } : {}),
      level: standing.level,
      level_framing: LEVEL_FRAMING[standing.level],
      level_progress: {
        passed: standing.counts.passed,
        needed: standing.needed.answers,
        concepts: standing.counts.concepts,
        needed_concepts: standing.needed.concepts,
        accuracy: standing.accuracy,
        min_accuracy: standing.needed.accuracy,
        next: standing.next,
        ...(standing.pinned ? { pinned: true } : {}),
      },
      concepts: picked,
    };
  },
};
