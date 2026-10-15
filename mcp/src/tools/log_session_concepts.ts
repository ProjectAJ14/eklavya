import { z } from 'zod';
import { loadConfig } from '../config.js';
import { normalizeSlug, isValidSlug, findFuzzyMatch } from '../slug.js';
import { cleanTags, findCandidates, growConcept, MAX_NAME_WORDS, wordCount, type Candidate } from '../concepts.js';
import { decayedScore, isKnown, streakOf } from '../srs.js';
import { resolveSessionId } from '../session.js';
import {
  allConceptSlugs,
  conceptBySlug,
  insertConcept,
  logSessionConcept,
  masteryFor,
  newConceptsThisSession,
  sessionConcepts,
  syncGate,
} from '../store.js';
import { withSurfaceNote } from '../surface.js';
import { CWD_HINT, LIMITS, SESSION_HINT, type ToolDef } from './types.js';

const DEFAULT_DOMAIN = 'general';
const DEFAULT_TIER = 2;

export const logSessionConcepts: ToolDef = {
  name: 'log_session_concepts',
  title: 'Log session concepts',
  // Evaluated once, when this module is imported, so the surface is read from
  // the environment the server was started in. That is the right moment: the
  // host sets `CLAUDE_CODE_ENTRYPOINT` before spawning us and a session cannot
  // change surface halfway through.
  description: withSurfaceNote(
    `Record the concepts the current task genuinely exercises, each with a one-line context pointing at the real code you wrote. Call this while implementing, batched, 3-8 concepts per task. A concept is a short name (1-${MAX_NAME_WORDS} words), a description and tags: reuse one the learner already has before minting. An unknown slug that resembles existing concepts is not created: the response lists them in needs_decision, so call again with a candidate's slug, or the same slug with new: true when none is the same idea. Pass a description or tags for a concept you met again and it deepens. When the response carries next_action, do what it says before quizzing.`,
    ' ',
  ),
  inputSchema: {
    session_id: z.string().max(LIMITS.sessionId).optional().describe(SESSION_HINT),
    cwd: z.string().max(LIMITS.cwd).optional().describe(CWD_HINT),
    concepts: z
      .array(
        z.object({
          slug: z.string().max(LIMITS.slug).describe('kebab-case, e.g. "httponly-cookies"'),
          name: z
            .string()
            .max(LIMITS.name)
            .refine((n) => wordCount(n) <= MAX_NAME_WORDS, `a concept name is 1-${MAX_NAME_WORDS} words; put the detail in description`)
            .optional(),
          domain: z.string().max(LIMITS.domain).optional(),
          tier: z.number().int().min(1).max(5).optional(),
          description: z.string().max(LIMITS.conceptDescription).optional().describe('What the concept is, in a sentence or two. On an existing concept it deepens the description.'),
          tags: z.array(z.string().max(LIMITS.tag)).max(LIMITS.tags).optional().describe('1-3 word labels, e.g. ["flutter", "animation"]. Reuse tags you have seen.'),
          new: z.boolean().optional().describe('Set when needs_decision listed candidates and none is the same idea.'),
          context: z.string().max(LIMITS.context).optional().describe('One line naming the actual code, e.g. "set httpOnly on the refresh cookie in auth.ts".'),
        }),
      )
      .min(1)
      .max(LIMITS.concepts),
  },
  handler: (
    args: {
      session_id?: string;
      cwd?: string;
      concepts: {
        slug: string;
        name?: string;
        domain?: string;
        tier?: number;
        description?: string;
        tags?: string[];
        new?: boolean;
        context?: string;
      }[];
    },
    { db },
  ) => {
    const now = new Date();
    const { config, repoRoot } = loadConfig(args.cwd);
    const sessionId = resolveSessionId(db, args.session_id, args.cwd);

    const created: string[] = [];
    const matched: { requested: string; resolved: string }[] = [];
    const needsDecision: { requested: string; candidates: Candidate[] }[] = [];
    const logged: string[] = [];
    let capped = 0;

    const apply = db.transaction(() => {
      let budget = Math.max(0, config.max_new_concepts_per_session - newConceptsThisSession(db, sessionId));

      for (const input of args.concepts) {
        const slug = normalizeSlug(input.slug);
        // The same check upsert_concepts makes, so the two ways a concept gets
        // minted cannot disagree about what a slug is.
        if (!isValidSlug(slug)) continue;

        let concept = conceptBySlug(db, slug);

        if (!concept) {
          const near = findFuzzyMatch(slug, allConceptSlugs(db));
          if (near) {
            concept = conceptBySlug(db, near.slug);
            if (concept) matched.push({ requested: slug, resolved: concept.slug });
          }
        }

        if (!concept && !input.new) {
          // Not minted yet: the model decides whether one of these is the same
          // idea. Skipping the check is `new: true`, an explicit claim.
          const candidates = findCandidates(db, { slug, name: input.name, tags: input.tags, domain: input.domain });
          if (candidates.length > 0) {
            needsDecision.push({ requested: slug, candidates });
            continue;
          }
        }

        if (!concept) {
          if (budget <= 0) {
            capped += 1;
            continue;
          }
          const tags = cleanTags([input.domain ?? '', ...(input.tags ?? [])]);
          concept = insertConcept(db, {
            slug,
            name: input.name ?? slug.replace(/-/g, ' '),
            domain: input.domain ?? tags[0] ?? DEFAULT_DOMAIN,
            description: input.description ?? null,
            tags,
            tier: input.tier ?? DEFAULT_TIER,
            source: 'llm',
          });
          created.push(concept.slug);
          budget -= 1;
        } else {
          growConcept(db, concept, { description: input.description, tags: input.tags });
        }

        logSessionConcept(db, sessionId, concept.id, input.context ?? null, 'work');
        logged.push(concept.slug);
      }

      // The gate's bar rises with the work: how many touched concepts are still
      // unmastered, capped at the configured questions per task.
      // 'work' only: `passedCount` counts nothing else, so a review-debt concept
      // raising the bar would raise it past anything the learner could clear.
      const unmastered = sessionConcepts(db, sessionId, 'work').filter((c) => {
        const m = masteryFor(db, c.id);
        return !isKnown({ score: decayedScore(m.score, m.next_review, now), ...streakOf(m) });
      }).length;

      // Inside the transaction, not after it: `registerTools` retries the whole
      // handler on SQLITE_BUSY, and a retry after the concepts had committed
      // found them already there and answered `created: []` -- dropping the
      // next_action that tells the tutor to give them a domain and edges.
      return syncGate(db, sessionId, config, {
        requiredHint: Math.min(unmastered, config.max_questions_per_task),
        repo: repoRoot,
      });
    });
    const gate = apply();

    // Said in the response, not only in the tutor skill. A bare concept is
    // tier 2, domain "general", no edges -- and `prereqs_unmet` is computed from
    // edges, so a concept with none can never be reported as unfair to ask
    // about, however far out of its depth the learner is. The skill says to fix
    // that, but it is model-invoked and may never load; the same gap is why the
    // concept-logging directive had to move into the SessionStart banner. This
    // lands in context whatever loaded.
    const decide =
      needsDecision.length > 0
        ? `Call log_session_concepts again for ${needsDecision.map((n) => n.requested).join(', ')}: use a candidate's slug when it is the same idea, or repeat the slug with new: true when none is. Nothing was logged for them yet.`
        : undefined;
    const followUp =
      created.length > 0
        ? `Call upsert_concepts for ${created.join(', ')} — each was created at tier 2 with no edges. Give each an honest tier and at least one prerequisite_of edge, or prereqs_unmet stays empty and the fairness check silently passes.`
        : undefined;
    const nextAction = [decide, followUp].filter(Boolean).join(' ') || undefined;

    return {
      session_id: sessionId,
      logged,
      created,
      matched,
      needs_decision: needsDecision,
      capped,
      gate,
      ...(nextAction ? { next_action: nextAction } : {}),
    };
  },
};
