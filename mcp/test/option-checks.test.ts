import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { recordOptionCheck } from '../src/option-checks.js';

describe('recordOptionCheck', () => {
  it('stores the row, with a null slug when none is given', () => {
    const db = new Database(':memory:');
    db.exec(
      `CREATE TABLE option_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, slug TEXT, surface TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    );
    recordOptionCheck(db, { sessionId: 's', slug: 'csrf', surface: 'panel', outcome: 'sent_back' });
    recordOptionCheck(db, { sessionId: 's', surface: 'card', outcome: 'unchanged' });
    expect(db.prepare('SELECT slug, surface, outcome FROM option_checks ORDER BY id').all()).toEqual([
      { slug: 'csrf', surface: 'panel', outcome: 'sent_back' },
      { slug: null, surface: 'card', outcome: 'unchanged' },
    ]);
  });
  it('fails open on a database from before migration 028', () => {
    expect(() => recordOptionCheck(new Database(':memory:'), { sessionId: 's', surface: 'card', outcome: 'sent_back' })).not.toThrow();
  });
});
