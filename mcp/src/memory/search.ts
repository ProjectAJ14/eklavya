import type { DB } from '../db.js';
import { cosine, embedLocal, fromBlob, LOCAL_EMBEDDER } from './embed.js';
import type { EntryRow } from './store.js';
import { entriesByIds } from './store.js';

/**
 * Retrieval (PRD RET-01/02): keyword, semantic, and the hybrid of the two.
 *
 * Project scope is the default on every path, including the batch-by-id one.
 * Cross-project recall exists and is explicit, because the failure it prevents —
 * a question about another repository's code — is the one that makes a memory
 * tool feel broken.
 */

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

export interface SearchFilter {
  project?: string | null;
  allProjects?: boolean;
  type?: string | null;
  tag?: string | null;
  since?: string | null;
  until?: string | null;
  limit?: number;
}

export interface SearchHit {
  entry: EntryRow;
  score: number;
  via: SearchMode;
}

/**
 * FTS5 has a query language, and a developer's search box does not. Feeding
 * `fix: auth (retry?)` straight to MATCH is a syntax error, and quoting the
 * whole string turns a two-word search into a phrase search that matches almost
 * nothing. So: split into terms, quote each one, and combine them.
 */
function ftsQuery(raw: string, join: 'AND' | 'OR'): string | null {
  const terms = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1)
    .map((t) => `"${t.replace(/"/g, '')}"`);
  if (!terms.length) return null;
  return terms.join(` ${join} `);
}

function scopeClause(filter: SearchFilter, alias = 'e'): { sql: string; args: unknown[] } {
  const where: string[] = [`${alias}.deleted_at IS NULL`, `${alias}.superseded_by IS NULL`];
  const args: unknown[] = [];
  if (!filter.allProjects && filter.project) {
    where.push(`${alias}.project = ?`);
    args.push(filter.project);
  }
  if (filter.type) {
    where.push(`${alias}.type = ?`);
    args.push(filter.type);
  }
  if (filter.since) {
    where.push(`${alias}.occurred_at >= ?`);
    args.push(filter.since);
  }
  if (filter.until) {
    where.push(`${alias}.occurred_at <= ?`);
    args.push(filter.until);
  }
  if (filter.tag) {
    where.push(`EXISTS (SELECT 1 FROM memory_entry_tags t WHERE t.entry_id = ${alias}.id AND t.tag = ?)`);
    args.push(filter.tag.toLowerCase());
  }
  return { sql: where.join(' AND '), args };
}

export function keywordSearch(db: DB, query: string, filter: SearchFilter = {}): SearchHit[] {
  const limit = filter.limit ?? 20;
  const scope = scopeClause(filter);

  const run = (match: string): SearchHit[] => {
    const rows = db
      .prepare(
        `SELECT e.*, bm25(memory_fts) AS rank
         FROM memory_fts
         JOIN memory_entries e ON e.id = memory_fts.rowid
         WHERE memory_fts MATCH ? AND ${scope.sql}
         ORDER BY rank LIMIT ?`,
      )
      .all(match, ...scope.args, limit) as (EntryRow & { rank: number })[];
    // bm25 returns a negative score where more negative is better; flip it so
    // every mode in this module speaks "higher is better".
    return rows.map(({ rank, ...entry }) => ({ entry: entry as EntryRow, score: -rank, via: 'keyword' as const }));
  };

  const andQuery = ftsQuery(query, 'AND');
  if (!andQuery) return [];
  const strict = run(andQuery);
  if (strict.length) return strict;
  // Nothing matched every term. Widen rather than return nothing: a developer
  // searching "refresh cookie rotation" wants the rotation note even if the
  // wording differs.
  const orQuery = ftsQuery(query, 'OR');
  return orQuery ? run(orQuery) : [];
}

/** Bounded scan: cosine over the project's most recent vectors (ADR-03). */
export function semanticSearch(
  db: DB,
  query: string,
  filter: SearchFilter = {},
  scanLimit = 5000,
): SearchHit[] {
  const scope = scopeClause(filter);
  const rows = db
    .prepare(
      `SELECT e.id, v.vec FROM memory_entries e
       JOIN memory_vectors v ON v.entry_id = e.id AND v.embedder_id = ?
       WHERE ${scope.sql}
       ORDER BY e.occurred_at DESC LIMIT ?`,
    )
    .all(LOCAL_EMBEDDER, ...scope.args, scanLimit) as { id: number; vec: Buffer }[];
  if (!rows.length) return [];

  const q = embedLocal(query);
  const scored = rows
    .map((r) => ({ id: r.id, score: cosine(q, fromBlob(r.vec)) }))
    .filter((r) => r.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, filter.limit ?? 20);

  const entries = new Map(entriesByIds(db, scored.map((s) => s.id)).map((e) => [e.id, e]));
  return scored
    .map((s) => ({ entry: entries.get(s.id)!, score: s.score, via: 'semantic' as const }))
    .filter((h) => h.entry);
}

/**
 * Reciprocal rank fusion of the two lists.
 *
 * RRF rather than a weighted sum of scores because bm25 and cosine are not on a
 * common scale, and normalising them per query invents a calibration the data
 * does not support. Rank is the only thing the two agree on.
 */
export function hybridSearch(db: DB, query: string, filter: SearchFilter = {}): SearchHit[] {
  const limit = filter.limit ?? 20;
  const wide = { ...filter, limit: Math.max(limit * 3, 30) };
  const keyword = keywordSearch(db, query, wide);
  const semantic = semanticSearch(db, query, wide);

  const K = 60;
  const fused = new Map<number, { entry: EntryRow; score: number }>();
  const add = (hits: SearchHit[]) => {
    hits.forEach((hit, index) => {
      const prev = fused.get(hit.entry.id);
      const contribution = 1 / (K + index + 1);
      if (prev) prev.score += contribution;
      else fused.set(hit.entry.id, { entry: hit.entry, score: contribution });
    });
  };
  add(keyword);
  add(semantic);

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((f) => ({ entry: f.entry, score: f.score, via: 'hybrid' as const }));
}

export function search(db: DB, query: string, mode: SearchMode, filter: SearchFilter = {}): SearchHit[] {
  if (!query.trim()) return [];
  if (mode === 'keyword') return keywordSearch(db, query, filter);
  if (mode === 'semantic') return semanticSearch(db, query, filter);
  return hybridSearch(db, query, filter);
}

/** Every entry that touched a file, newest first (PRD RET-01 file history). */
export function fileHistory(db: DB, file: string, filter: SearchFilter = {}): EntryRow[] {
  const scope = scopeClause(filter);
  return db
    .prepare(
      `SELECT e.* FROM memory_entries e
       WHERE ${scope.sql} AND e.files IS NOT NULL
         AND EXISTS (SELECT 1 FROM json_each(e.files) WHERE json_each.value LIKE ?)
       ORDER BY e.occurred_at DESC LIMIT ?`,
    )
    .all(...scope.args, `%${file}%`, filter.limit ?? 20) as EntryRow[];
}
