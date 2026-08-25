import { z } from 'zod';
import { decayedScore, isKnown } from '../srs.js';
import { type ToolDef } from './types.js';

const NODE_CAP = 200;

interface Node {
  slug: string;
  name: string;
  tier: number;
  score?: number;
  known?: boolean;
  attempts?: number;
}

/**
 * Prerequisite-first ordering (decision G10). Cycles are broken by tier then
 * slug so the order is stable rather than dependent on insertion order.
 */
function topoSort(
  nodes: { id: number; slug: string; tier: number }[],
  edges: { from: number; to: number }[],
): number[] {
  const indegree = new Map<number, number>(nodes.map((n) => [n.id, 0]));
  const out = new Map<number, number[]>(nodes.map((n) => [n.id, []]));

  for (const e of edges) {
    if (!indegree.has(e.from) || !indegree.has(e.to)) continue;
    out.get(e.from)!.push(e.to);
    indegree.set(e.to, indegree.get(e.to)! + 1);
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rank = (id: number): string => {
    const n = byId.get(id)!;
    return `${n.tier}-${n.slug}`;
  };

  const ready = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  ready.sort((a, b) => rank(a).localeCompare(rank(b)));

  const ordered: number[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const next of out.get(id) ?? []) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) {
        ready.push(next);
        ready.sort((a, b) => rank(a).localeCompare(rank(b)));
      }
    }
  }

  // Anything left sits in a cycle; append it deterministically rather than drop it.
  const placed = new Set(ordered);
  const leftovers = nodes.filter((n) => !placed.has(n.id)).sort((a, b) => rank(a.id).localeCompare(rank(b.id)));
  return [...ordered, ...leftovers.map((n) => n.id)];
}

export const getConceptGraph: ToolDef = {
  name: 'get_concept_graph',
  title: 'Get concept graph',
  description:
    'Concepts and edges for a domain in prerequisite order — the order to teach them in. Optionally annotated with this learner\'s mastery.',
  inputSchema: {
    domain: z.string().describe('e.g. "web-auth", "react", "git", "node-backend"'),
    include_mastery: z.boolean().optional(),
    unmastered_only: z.boolean().optional().describe('Drop concepts the learner already knows.'),
  },
  handler: (
    args: { domain: string; include_mastery?: boolean; unmastered_only?: boolean },
    { db },
  ) => {
    const now = new Date();
    const rows = db
      .prepare(
        `SELECT c.id, c.slug, c.name, c.tier,
                m.score, m.reps, m.next_review,
                (SELECT count(*) FROM attempts a WHERE a.concept_id = c.id) AS attempts
         FROM concepts c
         LEFT JOIN mastery m ON m.concept_id = c.id
         WHERE c.domain = ?`,
      )
      .all(args.domain) as {
      id: number;
      slug: string;
      name: string;
      tier: number;
      score: number | null;
      reps: number | null;
      next_review: string | null;
      attempts: number;
    }[];

    if (rows.length === 0) {
      return { domain: args.domain, concepts: [], edges: [], truncated: false };
    }

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const edgeRows = db
      .prepare(
        `SELECT from_concept, to_concept, relation FROM edges
         WHERE from_concept IN (${placeholders}) AND to_concept IN (${placeholders})`,
      )
      .all(...ids, ...ids) as { from_concept: number; to_concept: number; relation: string }[];

    const order = topoSort(
      rows.map((r) => ({ id: r.id, slug: r.slug, tier: r.tier })),
      edgeRows
        .filter((e) => e.relation === 'prerequisite_of')
        .map((e) => ({ from: e.from_concept, to: e.to_concept })),
    );

    const byId = new Map(rows.map((r) => [r.id, r]));
    const slugOf = new Map(rows.map((r) => [r.id, r.slug]));

    let nodes: Node[] = order.map((id) => {
      const r = byId.get(id)!;
      const node: Node = { slug: r.slug, name: r.name, tier: r.tier };
      if (args.include_mastery) {
        const score = decayedScore(r.score ?? 0, r.next_review, now);
        node.score = Number(score.toFixed(2));
        node.known = r.attempts > 0 && isKnown({ score, reps: r.reps ?? 0 });
        node.attempts = r.attempts;
      }
      return node;
    });

    if (args.unmastered_only) {
      const now2 = new Date();
      const knownIds = new Set(
        rows
          .filter(
            (r) =>
              r.attempts > 0 &&
              isKnown({ score: decayedScore(r.score ?? 0, r.next_review, now2), reps: r.reps ?? 0 }),
          )
          .map((r) => r.slug),
      );
      nodes = nodes.filter((n) => !knownIds.has(n.slug));
    }

    const truncated = nodes.length > NODE_CAP;

    return {
      domain: args.domain,
      concepts: nodes.slice(0, NODE_CAP),
      edges: edgeRows
        .map((e) => ({ from: slugOf.get(e.from_concept)!, to: slugOf.get(e.to_concept)!, relation: e.relation }))
        .slice(0, NODE_CAP * 2),
      truncated,
    };
  },
};
