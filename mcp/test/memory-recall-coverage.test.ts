import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { INDEX_MAX_ITEMS, alreadyRecalled, recall } from '../src/memory/recall.js';
import { insertEntry } from '../src/memory/store.js';

const PROJECT = '/tmp/recall-cov';
const config = (): EklavyaConfig => structuredClone(DEFAULT_CONFIG);

let dbFile: string;
let db: DB;
beforeEach(() => {
  dbFile = tempDbPath('eklavya-recall-cov');
  db = openDb(dbFile);
});
afterEach(() => {
  if (db.open) db.close();
  cleanup(dbFile);
});

const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();

describe('recall edges', () => {
  it('returns nothing when memory is disabled', () => {
    insertEntry(db, { project: PROJECT, title: 'Something' });
    const cfg = config();
    cfg.memory.enabled = false;
    expect(recall(db, cfg, { project: PROJECT }).block).toBeNull();
  });

  it('treats an unreadable delivery record as nothing delivered', () => {
    db.close();
    expect(alreadyRecalled(db, 's1')).toEqual(new Set());
  });

  it('still returns the recall when recording the delivery fails', () => {
    insertEntry(db, { project: PROJECT, title: 'Rotated the refresh cookie' });
    db.exec(`CREATE TRIGGER no_recalled BEFORE INSERT ON meta WHEN NEW.key LIKE 'recalled:%'
             BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    const result = recall(db, config(), { project: PROJECT, sessionId: 's1' });
    expect(result.entries.map((e) => e.title)).toEqual(['Rotated the refresh cookie']);
    expect(alreadyRecalled(db, 's1')).toEqual(new Set());
  });

  it('renders untyped entries as changes and ignores files and facts that are not JSON lists', () => {
    const id = insertEntry(db, { project: PROJECT, title: 'Plain entry', narrative: 'body' });
    db.prepare('UPDATE memory_entries SET type = NULL, files = ?, facts = ? WHERE id = ?').run('{"a":1}', 'not json', id);
    const block = recall(db, config(), { project: PROJECT }).block!;
    expect(block).toContain(`[#${id}] Plain entry — change,`);
    expect(block).not.toContain('files:');
  });

  it('closes on a bare checkpoint, titled from the entry, with no detail heading and a raw undated timeline line', () => {
    const summary = insertEntry(db, {
      project: PROJECT,
      sessionId: 'earlier',
      kind: 'session_summary',
      title: 'Session: shipped the gate',
      narrative: '',
      occurredAt: at(10),
    });
    const older = insertEntry(db, { project: PROJECT, sessionId: 'earlier', kind: 'session_summary', title: 'Session: older', occurredAt: at(1) });
    db.prepare('UPDATE memory_entries SET occurred_at = ?, type = NULL WHERE id = ?').run('0000-bad', older);

    const result = recall(db, config(), { project: PROJECT, sessionId: 'now', index: true });
    const block = result.block!;
    expect(result.entries.map((e) => e.id)).toEqual([summary]);
    expect(block).toContain(`Where the last session left off ([#${summary}]`);
    expect(block).toContain('Session: shipped the gate');
    expect(block).not.toContain('Latest, in full:');
    // An unparseable timestamp keeps its raw text as the day and no clock time.
    expect(block).toContain('### 0000-bad');
    expect(block).toContain(`[#${older}]  session · older`);
  });

  it('caps the timeline at its item allowance', () => {
    for (let i = 0; i < INDEX_MAX_ITEMS + 10; i++) insertEntry(db, { project: PROJECT, title: `e${i}`, occurredAt: at(i) });
    const cfg = config();
    // Room for two in full but budget for one: more than the allowance is left over.
    cfg.retrieval.max_items = 2;
    cfg.retrieval.max_tokens = 1;
    const result = recall(db, cfg, { project: PROJECT, index: true });
    expect(result.entries).toHaveLength(1);
    expect(result.indexed).toBe(INDEX_MAX_ITEMS);
  });

  it('caps the timeline at its token allowance', () => {
    for (let i = 0; i < 40; i++) insertEntry(db, { project: PROJECT, title: `${'long title words '.repeat(12)}${i}`, occurredAt: at(i) });
    const cfg = config();
    cfg.retrieval.max_items = 1;
    const result = recall(db, cfg, { project: PROJECT, index: true });
    expect(result.indexed).toBeGreaterThan(0);
    expect(result.indexed).toBeLessThan(39);
  });
});
