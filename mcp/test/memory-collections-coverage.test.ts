import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { insertEntry } from '../src/memory/store.js';
import { collectionByName, collectionEntries, createCollection, rebuildCollection } from '../src/memory/collections.js';

const A = '/tmp/coll-a';
const B = '/tmp/coll-b';
let dbFile: string;
let db: DB;
const config: EklavyaConfig = structuredClone(DEFAULT_CONFIG);
config.retrieval.mode = 'keyword';

beforeEach(() => {
  dbFile = tempDbPath('eklavya-coll-cov');
  db = openDb(dbFile);
  insertEntry(db, { project: A, title: 'Cookie rotation in A', narrative: 'auth', type: 'feature' });
  insertEntry(db, { project: B, title: 'Cookie rotation in B', narrative: 'auth', type: 'feature' });
});
afterEach(() => {
  db.close();
  cleanup(dbFile);
});

describe('collections edges', () => {
  it('stores null description and project when omitted, and resolves the id on an upsert from a fresh connection', () => {
    const id = createCollection(db, { name: 'c', filter: {} });
    expect(collectionByName(db, 'c')).toMatchObject({ id, description: null, project: null });
    db.close();
    db = openDb(dbFile);
    // No insert on this connection yet, so lastInsertRowid is 0 and the id comes from the lookup.
    expect(createCollection(db, { name: 'c', description: 'again', filter: {} })).toBe(id);
    expect(collectionByName(db, 'c')!.description).toBe('again');
  });

  it('returns null for an unknown collection and no entries for it', () => {
    expect(rebuildCollection(db, config, 'nope')).toBeNull();
    expect(collectionEntries(db, 'nope')).toEqual([]);
  });

  it('keeps the set when the stored filter is unreadable', () => {
    const id = createCollection(db, { name: 'bad', filter: {} });
    db.prepare('UPDATE memory_collections SET filter = ? WHERE id = ?').run('{not json', id);
    expect(rebuildCollection(db, config, 'bad')).toEqual({
      name: 'bad',
      members: 0,
      previous: 0,
      kept: true,
      reason: 'unreadable_filter',
    });
  });

  it('falls back to the collection project and the configured search mode', () => {
    createCollection(db, { name: 'q', filter: { query: 'cookie rotation' }, project: A });
    expect(rebuildCollection(db, config, 'q')!.members).toBe(1);
    expect(collectionEntries(db, 'q').map((e) => e.project)).toEqual([A]);
  });

  it('lists every project from the timeline when allProjects is set or no project is known', () => {
    createCollection(db, { name: 'all', filter: { allProjects: true }, project: A });
    expect(rebuildCollection(db, config, 'all')!.members).toBe(2);
    createCollection(db, { name: 'none', filter: {} });
    expect(rebuildCollection(db, config, 'none')!.members).toBe(2);
  });
});
