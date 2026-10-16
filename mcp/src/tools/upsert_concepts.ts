import { z } from 'zod';
import { loadConfig } from '../config.js';
import { normalizeSlug, isValidSlug, findFuzzyMatch } from '../slug.js';
import { resolveSessionId } from '../session.js';
import { cleanTags, findCandidates, growConcept, MAX_NAME_WORDS, wordCount, type Candidate } from '../concepts.js';
import { allConceptSlugs, conceptBySlug, insertConcept, newConceptsThisSession } from '../store.js';
import { CWD_HINT, LIMITS, SESSION_HINT, type ToolDef } from './types.js';

const DEFAULT_DOMAIN = 'general';

export const upsertConcepts: ToolDef = {
  name: 'upsert_concepts',
  title: 'Upsert concepts',
  description:
    'Grow the knowledge graph when work touches a concept that has no slug yet, or give a concept log_session_concepts just created its real domain, tier, description and tags. A concept is a short name (1-3 words), a description and tags. Slugs are normalized and near-duplicates are folded into the existing concept, so check the returned canonical slug before using it; a new concept that resembles existing ones is listed in needs_decision instead of created, so reuse a candidate or repeat it with new: true. A concept from the seed or a pack, or one that already has a domain (given when it was logged, or its first tag), keeps its domain, tier and description; its tags can still grow. `updated` lists what changed.',
  inputSchema: {
    session_id: z.string().max(LIMITS.sessionId).optional().describe(SESSION_HINT),
    cwd: z.string().max(LIMITS.cwd).optional().describe(CWD_HINT),
    concepts: z
      .array(
        z.object({
          slug: z.string().max(LIMITS.slug),
          name: z
            .string()
            .max(LIMITS.name)
            .refine((n) => wordCount(n) <= MAX_NAME_WORDS, `a concept name is 1-${MAX_NAME_WORDS} words; put the detail in description`)
            .optional(),
          domain: z.string().max(LIMITS.domain).optional(),
          tier: z.number().int().min(1).max(5).optional(),
          description: z.string().max(LIMITS.conceptDescription).optional(),
          tags: z.array(z.string().max(LIMITS.tag)).max(LIMITS.tags).optional(),
          new: z.boolean().optional().describe('Set when needs_decision listed candidates and none is the same idea.'),
        }),
      )
      .min(1)
      .max(LIMITS.concepts),
    edges: z
      .array(
        z.object({
          from: z.string().max(LIMITS.slug),
          to: z.string().max(LIMITS.slug),
          relation: z.enum(['prerequisite_of', 'related_to', 'part_of']),
        }),
      )
      .max(LIMITS.edges)
      .optional()
      .describe('Prefer prerequisite_of edges — they are what orders a teaching session.'),
  },
  handler: (
    args: {
      session_id?: string;
      cwd?: string;
      concepts: { slug: string; name?: string; domain?: string; tier?: number; description?: string; tags?: string[]; new?: boolean }[];
      edges?: { from: string; to: string; relation: 'prerequisite_of' | 'related_to' | 'part_of' }[];
    },
    { db },
  ) => {
    const { config } = loadConfig(args.cwd);
    const sessionId = resolveSessionId(db, args.session_id, args.cwd);

    const created: string[] = [];
    const matched: { requested: string; resolved: string }[] = [];
    const updated: string[] = [];
    const rejected: { slug: string; reason: string }[] = [];
    const needsDecision: { requested: string; candidates: Candidate[] }[] = [];
    const resolvedSlug = new Map<string, string>();
    let edgesAdded = 0;

    db.transaction(() => {
      let budget = Math.max(0, config.max_new_concepts_per_session - newConceptsThisSession(db, sessionId));

      for (const input of args.concepts) {
        const slug = normalizeSlug(input.slug);
        if (!isValidSlug(slug)) {
          rejected.push({ slug: input.slug, reason: 'invalid_slug' });
          continue;
        }

        const existing = conceptBySlug(db, slug);
        if (existing) {
          // `log_session_concepts` mints a concept in the domain it was given (or
          // its first tag), else `general`, at tier 2. Only a concept still in
          // `general` is unplaced: a seeded, pack or already-placed concept is the
          // catalogue's, and one model call must not rewrite it for every learner.
          const bare = existing.source === 'llm' && existing.domain === DEFAULT_DOMAIN;
          const domain = input.domain && input.domain !== DEFAULT_DOMAIN ? input.domain : null;
          let changed = false;
          if (bare && (domain || input.tier !== undefined)) {
            db.prepare('UPDATE concepts SET domain = ?, tier = ? WHERE id = ?').run(
              domain ?? existing.domain,
              input.tier ?? existing.tier,
              existing.id,
            );
            changed = true;
          }
          // Description and tags deepen any concept the session met again; the
          // catalogue's own descriptions are left alone (see growConcept).
          if (growConcept(db, existing, { description: input.description, tags: input.tags })) changed = true;
          if (changed) updated.push(existing.slug);
          resolvedSlug.set(input.slug, existing.slug);
          matched.push({ requested: slug, resolved: existing.slug });
          continue;
        }

        const near = findFuzzyMatch(slug, allConceptSlugs(db));
        if (near) {
          resolvedSlug.set(input.slug, near.slug);
          matched.push({ requested: slug, resolved: near.slug });
          continue;
        }

        if (!input.new) {
          const candidates = findCandidates(db, { slug, name: input.name, tags: input.tags, domain: input.domain });
          if (candidates.length > 0) {
            needsDecision.push({ requested: slug, candidates });
            continue;
          }
        }

        if (budget <= 0) {
          rejected.push({ slug, reason: 'session_cap_reached' });
          continue;
        }

        const tags = cleanTags([input.domain ?? '', ...(input.tags ?? [])]);
        const concept = insertConcept(db, {
          slug,
          name: input.name ?? slug.replace(/-/g, ' '),
          domain: input.domain ?? tags[0] ?? DEFAULT_DOMAIN,
          tags,
          description: input.description ?? null,
          tier: input.tier ?? 2,
          source: 'llm',
        });
        resolvedSlug.set(input.slug, concept.slug);
        created.push(concept.slug);
        budget -= 1;
      }

      const insertEdge = db.prepare(
        'INSERT OR IGNORE INTO edges (from_concept, to_concept, relation) VALUES (?, ?, ?)',
      );
      for (const edge of args.edges ?? []) {
        const from = conceptBySlug(db, resolvedSlug.get(edge.from) ?? normalizeSlug(edge.from));
        const to = conceptBySlug(db, resolvedSlug.get(edge.to) ?? normalizeSlug(edge.to));
        if (!from || !to || from.id === to.id) continue;
        const result = insertEdge.run(from.id, to.id, edge.relation);
        edgesAdded += result.changes;
      }
    })();

    return { created, updated, matched, rejected, needs_decision: needsDecision, edges_added: edgesAdded };
  },
};
