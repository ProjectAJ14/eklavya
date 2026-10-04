import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { deleteEntry, insertEntry, supersedeEntry } from '../src/memory/store.js';
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

describe('collection filters and live entries', () => {
  const P = '/synthetic';
  let oldAuth: number;
  let unrelated: number;
  let newAuth: number;

  beforeEach(() => {
    oldAuth = insertEntry(db, { project: P, title: 'Old auth decision', narrative: 'session cookies', tags: ['auth'] });
    unrelated = insertEntry(db, { project: P, title: 'Unrelated note', narrative: 'session cookies', tags: ['other'] });
    newAuth = insertEntry(db, { project: P, title: 'New auth decision', narrative: 'session cookies', tags: ['auth'] });
    supersedeEntry(db, oldAuth, newAuth);
  });

  it('applies a tag to a filter-only collection and leaves superseded entries out', () => {
    createCollection(db, { name: 'auth-only', filter: { project: P, tag: 'auth' }, project: P });
    expect(rebuildCollection(db, config, 'auth-only')!.members).toBe(1);
    expect(collectionEntries(db, 'auth-only').map((e) => e.id)).toEqual([newAuth]);
  });

  it('gives a query-backed collection the same constraints as a filter-only one', () => {
    createCollection(db, { name: 'by-tag', filter: { project: P, tag: 'AUTH' }, project: P });
    createCollection(db, { name: 'by-query', filter: { project: P, tag: 'AUTH', query: 'session cookies' }, project: P });
    rebuildCollection(db, config, 'by-tag');
    rebuildCollection(db, config, 'by-query');
    const ids = (name: string) => collectionEntries(db, name).map((e) => e.id);
    expect(ids('by-query')).toEqual(ids('by-tag'));
    expect(ids('by-query')).not.toContain(unrelated);
  });

  it('stops showing a member corrected after the rebuild, and the rebuild picks up its replacement', () => {
    createCollection(db, { name: 'auth-only', filter: { project: P, tag: 'auth' }, project: P });
    rebuildCollection(db, config, 'auth-only');
    const newest = insertEntry(db, { project: P, title: 'Newest auth decision', narrative: 'x', tags: ['auth'] });
    supersedeEntry(db, newAuth, newest);
    expect(collectionEntries(db, 'auth-only')).toEqual([]);
    expect(rebuildCollection(db, config, 'auth-only')!.members).toBe(1);
    expect(collectionEntries(db, 'auth-only').map((e) => e.id)).toEqual([newest]);
  });

  it('keeps deleted members out and still refuses an empty rebuild', () => {
    createCollection(db, { name: 'auth-only', filter: { project: P, tag: 'auth' }, project: P });
    rebuildCollection(db, config, 'auth-only');
    deleteEntry(db, newAuth);
    expect(collectionEntries(db, 'auth-only')).toEqual([]);
    expect(rebuildCollection(db, config, 'auth-only')).toMatchObject({ kept: true, reason: 'empty_rebuild_refused' });
    expect(rebuildCollection(db, config, 'auth-only', { force: true })).toMatchObject({ kept: false, members: 0 });
  });
});
