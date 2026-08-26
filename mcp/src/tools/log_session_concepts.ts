import { z } from 'zod';
import { loadConfig } from '../config.js';
import { normalizeSlug, findFuzzyMatch } from '../slug.js';
import { decayedScore, isKnown } from '../srs.js';
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
import { CWD_HINT, SESSION_HINT, type ToolDef } from './types.js';

const DEFAULT_DOMAIN = 'general';
const DEFAULT_TIER = 2;

export const logSessionConcepts: ToolDef = {
  name: 'log_session_concepts',
  title: 'Log session concepts',
  description:
    'Record the concepts the current task genuinely exercises, each with a one-line context pointing at the real code you wrote. Call this while implementing, batched, 3-8 concepts per task. Unknown slugs are created automatically, but bare — when the response carries next_action, do what it says before quizzing.',
  inputSchema: {
    session_id: z.string().optional().describe(SESSION_HINT),
    cwd: z.string().optional().describe(CWD_HINT),
    concepts: z
      .array(
        z.object({
          slug: z.string().describe('kebab-case, e.g. "httponly-cookies"'),
          name: z.string().optional(),
          domain: z.string().optional(),
          tier: z.number().int().min(1).max(5).optional(),
          context: z.string().optional().describe('One line naming the actual code, e.g. "set httpOnly on the refresh cookie in auth.ts".'),
        }),
      )
      .min(1),
  },
  handler: (
    args: {
      session_id?: string;
      cwd?: string;
      concepts: { slug: string; name?: string; domain?: string; tier?: number; context?: string }[];
    },
    { db },
  ) => {
    const now = new Date();
    const { config, repoRoot } = loadConfig(args.cwd);
    const sessionId = resolveSessionId(db, args.session_id);

    const created: string[] = [];
    const matched: { requested: string; resolved: string }[] = [];
    const logged: string[] = [];
    let capped = 0;

    const apply = db.transaction(() => {
      let budget = Math.max(0, config.max_new_concepts_per_session - newConceptsThisSession(db, sessionId));

      for (const input of args.concepts) {
        const slug = normalizeSlug(input.slug);
        if (!slug) continue;

        let concept = conceptBySlug(db, slug);

        if (!concept) {
          const near = findFuzzyMatch(slug, allConceptSlugs(db));
          if (near) {
            concept = conceptBySlug(db, near.slug);
            if (concept) matched.push({ requested: slug, resolved: concept.slug });
          }
        }

        if (!concept) {
          if (budget <= 0) {
            capped += 1;
            continue;
          }
          concept = insertConcept(db, {
            slug,
            name: input.name ?? slug.replace(/-/g, ' '),
            domain: input.domain ?? DEFAULT_DOMAIN,
            tier: input.tier ?? DEFAULT_TIER,
            source: 'llm',
          });
          created.push(concept.slug);
          budget -= 1;
        }

        logSessionConcept(db, sessionId, concept.id, input.context ?? null);
        logged.push(concept.slug);
      }
    });
    apply();

    // The gate's bar rises with the work: how many touched concepts are still
    // unmastered, capped at the configured questions per task.
    const unmastered = sessionConcepts(db, sessionId).filter((c) => {
      const m = masteryFor(db, c.id);
      return !isKnown({ score: decayedScore(m.score, m.next_review, now), reps: m.reps });
    }).length;

    const gate = syncGate(db, sessionId, config, {
      requiredHint: Math.min(unmastered, config.max_questions_per_task),
      repo: repoRoot,
    });

    // Said in the response, not only in the tutor skill. A bare concept is
    // tier 2, domain "general", no edges -- and `prereqs_unmet` is computed from
    // edges, so a concept with none can never be reported as unfair to ask
    // about, however far out of its depth the learner is. The skill says to fix
    // that, but it is model-invoked and may never load; the same gap is why the
    // concept-logging directive had to move into the SessionStart banner. This
    // lands in context whatever loaded.
    const nextAction =
      created.length > 0
        ? `Call upsert_concepts for ${created.join(', ')} — each was created bare (tier 2, domain "general", no edges). Give each a real domain, an honest tier, and at least one prerequisite_of edge, or prereqs_unmet stays empty and the fairness check silently passes.`
        : undefined;

    return {
      session_id: sessionId,
      logged,
      created,
      matched,
      capped,
      gate,
      ...(nextAction ? { next_action: nextAction } : {}),
    };
  },
};
