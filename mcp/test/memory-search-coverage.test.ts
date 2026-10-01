import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { insertEntry } from '../src/memory/store.js';
import { fileHistory, keywordSearch, search } from '../src/memory/search.js';

const P = '/tmp/search-cov';
let dbFile: string;
let db: DB;
beforeEach(() => {
  dbFile = tempDbPath('eklavya-search-cov');
  db = openDb(dbFile);
  insertEntry(db, { project: P, title: 'Cookie rotation early', type: 'feature', tags: ['Auth'], files: ['src/a.ts'], occurredAt: '2026-01-01T00:00:00.000Z' });
  insertEntry(db, { project: P, title: 'Cookie rotation middle', type: 'bugfix', tags: ['auth'], files: ['src/a.ts'], occurredAt: '2026-02-01T00:00:00.000Z' });
  insertEntry(db, { project: P, title: 'Cookie rotation late', type: 'feature', files: ['src/a.ts'], occurredAt: '2026-03-01T00:00:00.000Z' });
});
afterEach(() => {
  db.close();
  cleanup(dbFile);
});

const titles = (hits: { entry: { title: string } }[]) => hits.map((h) => h.entry.title).sort();

describe('search filters', () => {
  it('narrows by type, date window and tag', () => {
    expect(titles(keywordSearch(db, 'cookie', { project: P, type: 'feature' }))).toEqual(['Cookie rotation early', 'Cookie rotation late']);
    expect(titles(keywordSearch(db, 'cookie', { project: P, since: '2026-01-15', until: '2026-02-15' }))).toEqual(['Cookie rotation middle']);
    expect(titles(keywordSearch(db, 'cookie', { project: P, tag: 'AUTH' }))).toEqual(['Cookie rotation early', 'Cookie rotation middle']);
  });

  it('widens to any term when no entry has them all', () => {
    expect(titles(keywordSearch(db, 'cookie zebra', { project: P }))).toHaveLength(3);
    expect(keywordSearch(db, 'cookie zebra', { project: P, strict: true })).toEqual([]);
  });

  it('returns nothing for a blank query', () => {
    expect(search(db, '   ', 'hybrid')).toEqual([]);
  });

  it('honours a limit on file history', () => {
    expect(fileHistory(db, 'src/a.ts', { project: P, limit: 1 }).map((e) => e.title)).toEqual(['Cookie rotation late']);
    expect(fileHistory(db, 'src/a.ts')).toHaveLength(3);
  });
});
