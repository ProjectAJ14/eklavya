/**
 * A concept is an entity: a short name, a description that deepens over time
 * and tags. The slug stays the key edges, attempts and mastery join on.
 *
 * This is the one place that decides "is this new concept really one the
 * learner's graph already has?" -- by comparing what the model says it is
 * (name, tags, slug) with what each existing concept is (those plus its
 * description), weighting rare words over common ones. The slug matcher in
 * `slug.ts` only ever saw token overlap of two slugs, so `worktree` and
 * `git-worktrees` were different concepts and so were `idempotency` and
 * `idempotency-key`.
 */
import type { DB } from './db.js';
import type { ConceptRow } from './store.js';
import { QUALIFIER_TOKENS, singular } from './slug.js';

export const MAX_NAME_WORDS = 3;
export const CANDIDATE_MIN_SCORE = 0.5;
export const CANDIDATE_LIMIT = 3;
/** With no model to ask (the observer's fallback), only a candidate this close is reused unasked. */
export const AUTO_REUSE_SCORE = 0.75;

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'to', 'for', 'and', 'or', 'with', 'by', 'is', 'are', 'vs', 'only', 'how', 'why', 'what', 'when', 'it', 'its', 'as', 'at', 'from', 'that', 'this', 'be', 'can', 'so']);

export function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Lowercase words with camelCase split, plurals folded, filler and qualifier words dropped. */
export function tokens(text: string): string[] {
  const out = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w) && !QUALIFIER_TOKENS.has(w))
    .map(singular);
  return [...new Set(out)];
}

export function parseTags(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Short lowercase tags, deduplicated, at most `max` of them. */
export function cleanTags(tags: string[] | undefined, max = 5): string[] {
  const seen = new Set<string>();
  for (const t of tags ?? []) {
    const tag = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (tag) seen.add(tag);
  }
  return [...seen].slice(0, max);
}

export interface Candidate {
  slug: string;
  name: string;
  description: string | null;
  tags: string[];
  domain: string;
  score: number;
}

interface Doc {
  row: ConceptRow;
  tokens: Set<string>;
  /** What the concept is called: its slug and name, not its description. */
  identity: string[];
}

/**
 * The score a concept earns when everything it is called appears in the query:
 * `idempotency-key` is `idempotency` plus a word. Word overlap alone punishes
 * the extra word, and the rarer it is, the harder.
 */
const CONTAINED_IDENTITY_SCORE = 0.75;

/**
 * The existing concepts closest to a described one, best first, none under
 * `CANDIDATE_MIN_SCORE`. The score is the share of the query's information (rare
 * words count for more) that the candidate also carries.
 */
export function findCandidates(
  db: DB,
  q: { slug: string; name?: string; tags?: string[]; domain?: string },
  limit = CANDIDATE_LIMIT,
): Candidate[] {
  const rows = db.prepare('SELECT * FROM concepts').all() as ConceptRow[];
  const docs: Doc[] = rows.map((row) => ({
    row,
    tokens: new Set(tokens([row.slug, row.name, row.domain, ...parseTags(row.tags), row.description ?? ''].join(' '))),
    identity: tokens(`${row.slug} ${row.name}`),
  }));
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + docs.length / (df.get(t) ?? 0.5));

  const query = tokens([q.slug, q.name ?? '', q.domain ?? '', ...(q.tags ?? [])].join(' '));
  const total = query.reduce((n, t) => n + idf(t), 0);
  if (total === 0) return [];

  const queryHas = new Set(query);
  return docs
    .map((d) => {
      const overlap = query.reduce((n, t) => n + (d.tokens.has(t) ? idf(t) : 0), 0) / total;
      const contained = d.identity.length > 0 && d.identity.every((t) => queryHas.has(t));
      return { d, score: contained ? Math.max(overlap, CONTAINED_IDENTITY_SCORE) : overlap };
    })
    .filter((r) => r.score >= CANDIDATE_MIN_SCORE && r.d.row.slug !== q.slug)
    .sort((a, b) => b.score - a.score || a.d.row.slug.localeCompare(b.d.row.slug))
    .slice(0, limit)
    .map(({ d, score }) => ({
      slug: d.row.slug,
      name: d.row.name,
      description: d.row.description,
      tags: parseTags(d.row.tags),
      domain: d.row.domain,
      score: Number(score.toFixed(2)),
    }));
}

/**
 * Lets a session deepen a concept it met again: tags are added (never removed);
 * a description fills an empty one, or revises a model-minted one when the new
 * text still carries at least half of what the old said, so a revision refines
 * rather than replaces. The catalogue's own descriptions (seed, packs) are left
 * alone: one model call must not rewrite them for every learner.
 * Returns whether anything changed.
 */
export function growConcept(db: DB, c: ConceptRow, input: { description?: string; tags?: string[] }): boolean {
  let changed = false;

  const tags = cleanTags([...parseTags(c.tags), ...(input.tags ?? [])]);
  if (tags.join() !== parseTags(c.tags).join()) {
    db.prepare('UPDATE concepts SET tags = ? WHERE id = ?').run(JSON.stringify(tags), c.id);
    changed = true;
  }

  const next = input.description?.trim();
  if (next && next !== c.description) {
    const old = new Set(tokens(c.description ?? ''));
    const kept = [...old].filter((t) => tokens(next).includes(t)).length;
    const refines = old.size === 0 || kept / old.size >= 0.5;
    if (!c.description || (c.source === 'llm' && refines)) {
      db.prepare('UPDATE concepts SET description = ? WHERE id = ?').run(next, c.id);
      changed = true;
    }
  }
  return changed;
}
