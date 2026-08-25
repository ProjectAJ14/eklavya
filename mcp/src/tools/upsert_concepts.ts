import { z } from 'zod';
import { loadConfig } from '../config.js';
import { normalizeSlug, isValidSlug, findFuzzyMatch } from '../slug.js';
import { resolveSessionId } from '../session.js';
import { allConceptSlugs, conceptBySlug, insertConcept, newConceptsThisSession } from '../store.js';
import { CWD_HINT, SESSION_HINT, type ToolDef } from './types.js';

export const upsertConcepts: ToolDef = {
  name: 'upsert_concepts',
  title: 'Upsert concepts',
  description:
    'Grow the knowledge graph when work touches a concept that has no slug yet. Slugs are normalized and near-duplicates are folded into the existing concept, so check the returned canonical slug before using it.',
  inputSchema: {
    session_id: z.string().optional().describe(SESSION_HINT),
    cwd: z.string().optional().describe(CWD_HINT),
    concepts: z
      .array(
        z.object({
          slug: z.string(),
          name: z.string().optional(),
          domain: z.string().optional(),
          tier: z.number().int().min(1).max(5).optional(),
          description: z.string().optional(),
        }),
      )
      .min(1),
    edges: z
      .array(
        z.object({
          from: z.string(),
          to: z.string(),
          relation: z.enum(['prerequisite_of', 'related_to', 'part_of']),
        }),
      )
      .optional()
      .describe('Prefer prerequisite_of edges — they are what orders a teaching session.'),
  },
  handler: (
    args: {
      session_id?: string;
      cwd?: string;
      concepts: { slug: string; name?: string; domain?: string; tier?: number; description?: string }[];
      edges?: { from: string; to: string; relation: 'prerequisite_of' | 'related_to' | 'part_of' }[];
    },
    { db },
  ) => {
    const { config } = loadConfig(args.cwd);
    const sessionId = resolveSessionId(db, args.session_id);

    const created: string[] = [];
    const matched: { requested: string; resolved: string }[] = [];
    const rejected: { slug: string; reason: string }[] = [];
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

        if (budget <= 0) {
          rejected.push({ slug, reason: 'session_cap_reached' });
          continue;
        }

        const concept = insertConcept(db, {
          slug,
          name: input.name ?? slug.replace(/-/g, ' '),
          domain: input.domain ?? 'general',
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

    return { created, matched, rejected, edges_added: edgesAdded };
  },
};
