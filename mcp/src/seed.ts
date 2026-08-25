import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { seedDir } from './paths.js';
import { isValidSlug } from './slug.js';

/**
 * Bump when seed content changes so existing installs pick up the new graphs on
 * next start. Seeding is idempotent, so re-running is always safe.
 */
export const SEED_VERSION = 1;
const SEED_VERSION_KEY = 'seed_version';

export const RELATIONS = ['prerequisite_of', 'related_to', 'part_of'] as const;
export type Relation = (typeof RELATIONS)[number];

export interface SeedConcept {
  slug: string;
  name: string;
  tier: number;
  description?: string;
  domain?: string;
}

export interface SeedEdge {
  from: string;
  to: string;
  relation: Relation;
}

export interface SeedGraph {
  domain: string;
  concepts: SeedConcept[];
  edges?: SeedEdge[];
}

export interface SeedSummary {
  concepts: number;
  edges: number;
  domains: string[];
}

function validateGraph(graph: SeedGraph, file: string): void {
  if (!graph.domain) throw new Error(`${file}: missing "domain"`);
  if (!Array.isArray(graph.concepts) || graph.concepts.length === 0) {
    throw new Error(`${file}: "concepts" must be a non-empty array`);
  }

  const slugs = new Set<string>();
  for (const c of graph.concepts) {
    if (!isValidSlug(c.slug)) throw new Error(`${file}: invalid slug "${c.slug}"`);
    if (slugs.has(c.slug)) throw new Error(`${file}: duplicate slug "${c.slug}"`);
    if (!c.name) throw new Error(`${file}: concept "${c.slug}" missing name`);
    if (!Number.isInteger(c.tier) || c.tier < 1 || c.tier > 5) {
      throw new Error(`${file}: concept "${c.slug}" has tier ${c.tier}, expected 1..5`);
    }
    slugs.add(c.slug);
  }

  for (const e of graph.edges ?? []) {
    if (!RELATIONS.includes(e.relation)) {
      throw new Error(`${file}: unknown relation "${e.relation}"`);
    }
    // Edges may only point within the same seed file: cross-domain links are the
    // LLM's job via upsert_concepts, and this keeps each file independently valid.
    if (!slugs.has(e.from)) throw new Error(`${file}: edge from unknown slug "${e.from}"`);
    if (!slugs.has(e.to)) throw new Error(`${file}: edge to unknown slug "${e.to}"`);
    if (e.from === e.to) throw new Error(`${file}: self-edge on "${e.from}"`);
  }
}

export function loadSeedGraphs(dir: string = seedDir()): SeedGraph[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const graph = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as SeedGraph;
      validateGraph(graph, file);
      return graph;
    });
}

/**
 * Upserts a graph by slug. Mastery rows are never touched — a learner's history
 * survives any number of seed updates.
 */
export function applySeedGraph(db: Database, graph: SeedGraph): SeedSummary {
  const upsertConcept = db.prepare(
    `INSERT INTO concepts (slug, name, domain, description, tier, source)
     VALUES (@slug, @name, @domain, @description, @tier, 'seed')
     ON CONFLICT(slug) DO UPDATE SET
       name        = excluded.name,
       domain      = excluded.domain,
       description = excluded.description,
       tier        = excluded.tier,
       source      = 'seed'`,
  );
  const idOf = db.prepare('SELECT id FROM concepts WHERE slug = ?');
  const insertEdge = db.prepare(
    `INSERT OR IGNORE INTO edges (from_concept, to_concept, relation) VALUES (?, ?, ?)`,
  );

  let edges = 0;
  db.transaction(() => {
    for (const c of graph.concepts) {
      upsertConcept.run({
        slug: c.slug,
        name: c.name,
        domain: c.domain ?? graph.domain,
        description: c.description ?? null,
        tier: c.tier,
      });
    }
    for (const e of graph.edges ?? []) {
      const from = idOf.get(e.from) as { id: number } | undefined;
      const to = idOf.get(e.to) as { id: number } | undefined;
      if (!from || !to) continue;
      insertEdge.run(from.id, to.id, e.relation);
      edges += 1;
    }
  })();

  return { concepts: graph.concepts.length, edges, domains: [graph.domain] };
}

export function seedAll(db: Database, dir: string = seedDir()): SeedSummary {
  const summary: SeedSummary = { concepts: 0, edges: 0, domains: [] };
  for (const graph of loadSeedGraphs(dir)) {
    const s = applySeedGraph(db, graph);
    summary.concepts += s.concepts;
    summary.edges += s.edges;
    summary.domains.push(graph.domain);
  }
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SEED_VERSION_KEY, String(SEED_VERSION));
  return summary;
}

/** Seeds on first run, and again whenever SEED_VERSION moves. */
export function seedIfNeeded(db: Database, dir: string = seedDir()): SeedSummary | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(SEED_VERSION_KEY) as
    | { value: string }
    | undefined;
  if (row && Number(row.value) === SEED_VERSION) return null;
  return seedAll(db, dir);
}
