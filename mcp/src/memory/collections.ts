import type { DB } from '../db.js';
import type { EklavyaConfig } from '../config.js';
import { nowIso } from '../time.js';
import { search, type SearchFilter, type SearchMode } from './search.js';
import { timeline, type EntryRow } from './store.js';

/**
 * Saved knowledge collections (PRD RET-04).
 *
 * A collection is a named query plus the membership that query produced. Both
 * halves matter: the query so a rebuild reproduces the same intent, the stored
 * membership so a rebuild that goes wrong can be discarded without losing the
 * last good set. That is the failure the reference had — a rebuild that
 * silently replaced a good collection with an empty one.
 */

export interface CollectionFilter {
  query?: string;
  mode?: SearchMode;
  type?: string;
  tag?: string;
  since?: string;
  project?: string | null;
  allProjects?: boolean;
  limit?: number;
}

export interface CollectionRow {
  id: number;
  name: string;
  description: string | null;
  filter: string;
  project: string | null;
  built_at: string | null;
  status: string;
  created_at: string;
}

export function createCollection(
  db: DB,
  opts: { name: string; description?: string | null; filter: CollectionFilter; project?: string | null },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO memory_collections (name, description, filter, project, status, created_at)
         VALUES (?, ?, ?, ?, 'ready', ?)
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           filter = excluded.filter,
           project = excluded.project`,
      )
      .run(opts.name, opts.description ?? null, JSON.stringify(opts.filter), opts.project ?? null, nowIso())
      .lastInsertRowid,
  ) || collectionByName(db, opts.name)!.id;
}

export function collectionByName(db: DB, name: string): CollectionRow | undefined {
  return db.prepare('SELECT * FROM memory_collections WHERE name = ?').get(name) as CollectionRow | undefined;
}

export function listCollections(db: DB): CollectionRow[] {
  return db.prepare('SELECT * FROM memory_collections ORDER BY name').all() as CollectionRow[];
}

export function deleteCollection(db: DB, name: string): boolean {
  return db.prepare('DELETE FROM memory_collections WHERE name = ?').run(name).changes > 0;
}

export interface RebuildResult {
  name: string;
  members: number;
  previous: number;
  kept: boolean;
  reason?: string;
}

/**
 * Re-runs a collection's query and swaps in the result.
 *
 * The swap is conditional and that is the point: a rebuild that finds nothing
 * where there used to be something is far more likely to be a broken index or
 * a mistyped filter than a genuine emptying, and overwriting on that guess
 * destroys the collection. It keeps the last good set, marks the collection
 * `failed`, and says why. `force` is for the developer who really did mean it.
 */
export function rebuildCollection(
  db: DB,
  config: EklavyaConfig,
  name: string,
  opts: { force?: boolean } = {},
): RebuildResult | null {
  const collection = collectionByName(db, name);
  if (!collection) return null;

  let filter: CollectionFilter;
  try {
    filter = JSON.parse(collection.filter) as CollectionFilter;
  } catch {
    return { name, members: 0, previous: memberCount(db, collection.id), kept: true, reason: 'unreadable_filter' };
  }

  const previous = memberCount(db, collection.id);
  const searchFilter: SearchFilter = {
    project: filter.project ?? collection.project ?? null,
    allProjects: filter.allProjects ?? false,
    type: filter.type ?? null,
    tag: filter.tag ?? null,
    since: filter.since ?? null,
    limit: filter.limit ?? 100,
  };

  const found: EntryRow[] = filter.query
    ? search(db, filter.query, filter.mode ?? config.retrieval.mode, searchFilter).map((h) => h.entry)
    : timeline(db, {
        project: searchFilter.allProjects ? null : searchFilter.project,
        type: searchFilter.type,
        since: searchFilter.since,
        limit: searchFilter.limit,
      });

  if (found.length === 0 && previous > 0 && !opts.force) {
    db.prepare("UPDATE memory_collections SET status = 'failed' WHERE id = ?").run(collection.id);
    return { name, members: previous, previous, kept: true, reason: 'empty_rebuild_refused' };
  }

  db.transaction(() => {
    db.prepare('DELETE FROM memory_collection_items WHERE collection_id = ?').run(collection.id);
    const insert = db.prepare(
      'INSERT OR REPLACE INTO memory_collection_items (collection_id, entry_id, rank) VALUES (?, ?, ?)',
    );
    found.forEach((entry, index) => insert.run(collection.id, entry.id, found.length - index));
    db.prepare("UPDATE memory_collections SET built_at = ?, status = 'ready' WHERE id = ?").run(
      nowIso(),
      collection.id,
    );
  })();

  return { name, members: found.length, previous, kept: false };
}

export function collectionEntries(db: DB, name: string, limit = 50): EntryRow[] {
  const collection = collectionByName(db, name);
  if (!collection) return [];
  return db
    .prepare(
      `SELECT e.* FROM memory_entries e
       JOIN memory_collection_items i ON i.entry_id = e.id
       WHERE i.collection_id = ? AND e.deleted_at IS NULL
       ORDER BY i.rank DESC LIMIT ?`,
    )
    .all(collection.id, limit) as EntryRow[];
}

function memberCount(db: DB, collectionId: number): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM memory_collection_items WHERE collection_id = ?').get(collectionId) as {
      n: number;
    }
  ).n;
}
