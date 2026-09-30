import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { ImportError, SUPPORTED_SCHEMA_VERSION, importFrom, inventory, restoreExport, verifyImport } from '../src/memory/import.js';
import { insertEntry } from '../src/memory/store.js';

// Edge cases of the Claude Mem importer the main suite's realistic fixture
// never reaches: nullable columns, odd timestamps, odd tables and copied paths.

const OCT = Date.UTC(2025, 9, 4, 11, 30, 0);
let dir = '';
let dbFile = '';
let db: DB;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-import-cov-'));
  dbFile = tempDbPath('eklavya-import-cov');
  db = openDb(dbFile);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  cleanup(dbFile);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A permissive Claude Mem layout: every column nullable, so each fallback is reachable. */
function looseSource(file: string, opts: { version?: number | null; tables?: string[] } = {}): Database.Database {
  const src = new Database(file);
  const want = new Set(opts.tables ?? ['observations', 'session_summaries', 'user_prompts', 'tool_uses', 'sdk_sessions']);
  if (opts.version !== undefined) {
    src.exec('CREATE TABLE schema_versions (id INTEGER PRIMARY KEY, version INTEGER, applied_at TEXT)');
    if (opts.version !== null) src.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, 'x')").run(opts.version);
  }
  if (want.has('sdk_sessions'))
    src.exec('CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, content_session_id TEXT, memory_session_id TEXT, project TEXT)');
  if (want.has('observations'))
    src.exec(`CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, merged_into_project TEXT,
      text TEXT, type TEXT, title TEXT, subtitle TEXT, facts TEXT, narrative TEXT, concepts TEXT, files_read TEXT,
      files_modified TEXT, prompt_number INTEGER, created_at TEXT, created_at_epoch REAL, generated_by_model TEXT, agent_type TEXT)`);
  if (want.has('session_summaries'))
    src.exec(`CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, merged_into_project TEXT,
      request TEXT, investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, notes TEXT, files_read TEXT,
      files_edited TEXT, created_at TEXT, created_at_epoch REAL)`);
  if (want.has('user_prompts'))
    src.exec(`CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, content_session_id TEXT,
      prompt_number INTEGER, prompt_text TEXT, created_at TEXT, created_at_epoch REAL)`);
  if (want.has('tool_uses'))
    src.exec(`CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, tool_use_id TEXT, content_session_id TEXT, memory_session_id TEXT,
      project TEXT, tool_name TEXT, tool_input TEXT, tool_response TEXT, cwd TEXT, agent_id TEXT, observation_id INTEGER,
      created_at TEXT, created_at_epoch REAL)`);
  return src;
}

const obs = (src: Database.Database, row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  src.prepare(`INSERT INTO observations (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
};

const mapRows = (sourceDb?: string) =>
  db
    .prepare(`SELECT source_db, source_table, source_id FROM import_id_map ${sourceDb ? 'WHERE source_db = ?' : ''} ORDER BY source_table, source_id`)
    .all(...(sourceDb ? [sourceDb] : [])) as { source_db: string; source_table: string; source_id: string }[];

describe('inventory of sources that are not what they seem', () => {
  it('refuses a database with neither observations nor a schema version, and counts an unquotable table as 0', () => {
    const file = path.join(dir, 'other.db');
    const src = new Database(file);
    src.exec('CREATE TABLE "odd""name" (x INTEGER); INSERT INTO "odd""name" VALUES (1)');
    src.close();

    const found = inventory(file);
    expect(found.supported).toBe(false);
    expect(found.schemaVersion).toBeNull();
    expect(found.problem).toMatch(/does not look like a Claude Mem database/);
    expect(found.tables).toEqual([{ name: 'odd"name', rows: 0, known: false }]);
    expect(found.projects).toEqual([]);
    expect(found.dateRange).toEqual({ from: null, to: null });
    expect(() => importFrom(db, file)).toThrow(ImportError);
  });

  it('treats an empty schema_versions table as unversioned and accepts it when observations exist', () => {
    const file = path.join(dir, 'unversioned.db');
    looseSource(file, { version: null, tables: ['observations'] }).close();
    const found = inventory(file);
    expect(found.schemaVersion).toBeNull();
    expect(found.supported).toBe(true);
    expect(found.dateRange).toEqual({ from: null, to: null });
  });
});

describe('importing a versioned source with no observations table', () => {
  it('imports prompts with no session or number as unknown, untitled evidence and links nothing', () => {
    const file = path.join(dir, 'prompts.db');
    const src = looseSource(file, { version: SUPPORTED_SCHEMA_VERSION, tables: ['user_prompts'] });
    src
      .prepare('INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at_epoch) VALUES (NULL, ?, NULL, ?, ?)')
      .run('content-9', 'hello there', OCT);
    src.close();

    const report = importFrom(db, file, { snapshotDir: path.join(dir, 'snap') });
    expect(report.imported.user_prompts).toBe(1);
    expect(report.links).toBe(0);
    expect(report.validation.ok).toBe(true);
    const ev = db.prepare("SELECT project, session_id, title FROM evidence_events WHERE source = 'import'").get();
    expect(ev).toEqual({ project: 'unknown', session_id: 'content-9', title: null });

    const verified = verifyImport(db, file);
    expect(verified.tables).toEqual([{ table: 'user_prompts', source: 1, present: 1, missing: [] }]);
    expect(verified.projects).toEqual([]);
  });
});

describe('importing rows with missing and malformed fields', () => {
  function build(file: string) {
    const src = looseSource(file, { version: SUPPORTED_SCHEMA_VERSION });
    src.prepare('INSERT INTO sdk_sessions (id, content_session_id, memory_session_id, project) VALUES (1, ?, NULL, ?)').run('content-1', 'p');
    // Epoch in seconds; concepts not JSON, one of them sluggable to nothing.
    obs(src, { id: 1, memory_session_id: 'content-1', project: 'p', subtitle: 'only a subtitle', concepts: 'alpha, !!!', created_at_epoch: OCT / 1000, prompt_number: 1, facts: '{"not":"an array"}' });
    // No epoch: the created_at string is used; text stands in for title and narrative.
    obs(src, { id: 2, project: 'p', text: 'only text', created_at: '2025-10-05T00:00:00.000Z' });
    // Nothing usable at all: an epoch past what Date can hold and an unparseable fallback.
    obs(src, { id: 3, project: 'p', created_at_epoch: 1e17, created_at: 'not a date' });
    obs(src, { id: 4, project: 'p', title: 'Zero epoch', created_at_epoch: 0 });
    obs(src, { id: 5, project: 'p', title: 'Fifth', created_at_epoch: OCT });
    src.prepare('INSERT INTO session_summaries (id, project, created_at_epoch) VALUES (1, ?, ?)').run('p', OCT);
    src
      .prepare('INSERT INTO user_prompts (id, session_db_id, content_session_id, prompt_number, prompt_text, created_at_epoch) VALUES (1, 1, ?, 1, ?, ?)')
      .run('content-1', 'first prompt', OCT);
    src
      .prepare('INSERT INTO tool_uses (id, tool_use_id, content_session_id, memory_session_id, project, tool_name, created_at_epoch) VALUES (1, ?, ?, NULL, ?, ?, ?)')
      .run('tu-1', 'content-1', 'p', 'Read', OCT);
    src.close();
  }

  it('falls back field by field and still accounts for every row', () => {
    const file = path.join(dir, 'loose.db');
    build(file);
    const before = Date.now();
    const report = importFrom(db, file, { snapshotDir: path.join(dir, 'snap'), projectMap: { p: 'p' } });

    expect(report.validation).toEqual({ ok: true, notes: [] });
    expect(report.imported).toEqual({ observations: 5, session_summaries: 1, user_prompts: 1, tool_uses: 1 });
    expect(report.candidates).toBe(1); // 'alpha'; '!!!' slugifies to nothing
    expect(report.rehomed).toBe(0); // a name mapped to itself moves nothing
    // The prompt resolves through a session with no memory id, to the observation of its turn.
    expect(report.links).toBe(1);

    const entries = db
      .prepare("SELECT title, narrative, facts, occurred_at FROM memory_entries WHERE kind = 'observation' ORDER BY id")
      .all() as { title: string; narrative: string; facts: string; occurred_at: string }[];
    expect(entries[0]).toMatchObject({ title: 'only a subtitle', narrative: 'only a subtitle', occurred_at: new Date(OCT).toISOString() });
    expect(JSON.parse(entries[0]!.facts)).toEqual(['{"not":"an array"}']);
    expect(entries[1]).toMatchObject({ title: 'only text', narrative: 'only text', occurred_at: '2025-10-05T00:00:00.000Z' });
    expect(entries[2]!.title).toBe('Imported observation');
    expect(Date.parse(entries[2]!.occurred_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(entries[3]!.occurred_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(db.prepare("SELECT title FROM memory_entries WHERE kind = 'session_summary'").get()).toEqual({ title: 'Session summary' });
    expect(db.prepare("SELECT session_id FROM evidence_events WHERE kind = 'tool_use'").get()).toEqual({ session_id: 'content-1' });
    expect(db.prepare("SELECT session_id FROM evidence_events WHERE kind = 'prompt'").get()).toEqual({ session_id: 'content-1' });
  });

  it('verifies a source edited since: changed titles and rows with no project name', () => {
    const file = path.join(dir, 'loose.db');
    build(file);
    importFrom(db, file, { snapshotDir: path.join(dir, 'snap') });
    const src = new Database(file);
    src.exec("UPDATE observations SET title = 'Renamed', project = NULL WHERE id = 5");
    src.close();

    const verified = verifyImport(db, file);
    expect(verified.changed).toBe(1);
    expect(verified.projects.find((p) => p.project === 'unknown')).toEqual({ project: 'unknown', entries: 1, filedUnder: { p: 1 } });
  });

  it('recognises the same database copied elsewhere, reads it under the old name, then claims it', () => {
    const original = path.join(dir, 'a', 'claude-mem.db');
    fs.mkdirSync(path.dirname(original));
    const src = looseSource(original, { version: SUPPORTED_SCHEMA_VERSION, tables: ['observations'] });
    // The sampler rebuilds each title the way the importer did, fallbacks included.
    obs(src, { id: 1, project: 'p', subtitle: 'sub', created_at_epoch: OCT });
    obs(src, { id: 2, project: 'p', text: 'txt', created_at_epoch: OCT });
    obs(src, { id: 3, project: 'p', created_at_epoch: OCT });
    for (let id = 4; id <= 6; id++) obs(src, { id, project: 'p', title: `T${id}`, created_at_epoch: OCT });
    src.close();
    importFrom(db, original, { snapshotDir: path.join(dir, 'snap') });

    // A copy with one row gone (a sampled id the copy lacks) is still the same history.
    const copy = path.join(dir, 'b', 'claude-mem.db');
    fs.mkdirSync(path.dirname(copy));
    fs.copyFileSync(original, copy);
    const c = new Database(copy);
    c.exec('DELETE FROM observations WHERE id = 6');
    c.close();

    const verified = verifyImport(db, copy);
    expect(verified.tables).toEqual([{ table: 'observations', source: 5, present: 5, missing: [] }]);
    expect(mapRows(fs.realpathSync(copy))).toEqual([]); // verify writes nothing

    const again = importFrom(db, copy, { snapshotDir: path.join(dir, 'snap') });
    expect(again.imported.observations).toBe(0);
    expect(again.skipped.observations).toBe(5);
    expect(mapRows(fs.realpathSync(original))).toEqual([]);
    expect(mapRows(fs.realpathSync(copy))).toHaveLength(6);
  });

  it('keeps a different database with overlapping ids as a separate source', () => {
    const first = path.join(dir, 'first.db');
    build(first);
    importFrom(db, first, { snapshotDir: path.join(dir, 'snap') });

    const other = path.join(dir, 'other.db');
    const src = looseSource(other, { version: SUPPORTED_SCHEMA_VERSION, tables: ['observations'] });
    for (let id = 1; id <= 5; id++) obs(src, { id, project: 'q', title: `Different ${id}`, created_at_epoch: OCT + id });
    src.close();

    expect(verifyImport(db, other).tables[0]).toMatchObject({ present: 0, missing: [1, 2, 3, 4, 5] });
    expect(importFrom(db, other, { snapshotDir: path.join(dir, 'snap2') }).imported.observations).toBe(5);
    expect(mapRows(fs.realpathSync(first)).length).toBe(8);
  });

  it('skips a candidate identity that holds no observations', () => {
    const prompts = path.join(dir, 'prompts.db');
    const p = looseSource(prompts, { version: SUPPORTED_SCHEMA_VERSION, tables: ['user_prompts'] });
    p.prepare("INSERT INTO user_prompts (id, content_session_id, prompt_text, created_at_epoch) VALUES (1, 'c', 'x', ?)").run(OCT);
    p.close();
    importFrom(db, prompts, { snapshotDir: path.join(dir, 'snap') });

    const file = path.join(dir, 'loose.db');
    build(file);
    const report = importFrom(db, file, { snapshotDir: path.join(dir, 'snap2') });
    expect(report.imported.observations).toBe(5);
    expect(mapRows(fs.realpathSync(prompts))).toHaveLength(1);
  });

  it('falls back to the resolved path when the source cannot be realpath-ed', () => {
    const file = path.join(dir, 'loose.db');
    build(file);
    const real = fs.realpathSync;
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (String(p) === file) throw new Error('ENOENT');
      return real(p, o as never);
    }) as typeof fs.realpathSync);
    importFrom(db, file, { snapshotDir: path.join(dir, 'snap') });
    expect(new Set(mapRows().map((r) => r.source_db))).toEqual(new Set([path.resolve(file)]));
  });
});

describe('validation failures keep the snapshot', () => {
  it('reports rows a resumed stale snapshot did not account for', () => {
    const snapDir = path.join(dir, 'snap');
    fs.mkdirSync(snapDir);
    const stale = looseSource(path.join(snapDir, 'claude-mem-snapshot.db'), { version: SUPPORTED_SCHEMA_VERSION, tables: ['observations'] });
    obs(stale, { id: 1, project: 'p', title: 'One', created_at_epoch: OCT });
    stale.close();

    const file = path.join(dir, 'src.db');
    const src = looseSource(file, { version: SUPPORTED_SCHEMA_VERSION, tables: ['observations'] });
    obs(src, { id: 1, project: 'p', title: 'One', created_at_epoch: OCT });
    obs(src, { id: 2, project: 'p', title: 'Two', created_at_epoch: OCT });
    src.close();

    const report = importFrom(db, file, { snapshotDir: snapDir, resume: true });
    expect(report.validation.ok).toBe(false);
    expect(report.validation.notes).toEqual(['observations: read 2, accounted for 1']);
    expect(fs.existsSync(path.join(snapDir, 'claude-mem-snapshot.db'))).toBe(true);
  });

  it('flags an imported entry that has no vector', () => {
    const id = insertEntry(db, { project: 'p', kind: 'observation', title: 'Orphan', narrative: 'n', importSource: 'claude-mem' });
    db.prepare('DELETE FROM memory_vectors WHERE entry_id = ?').run(id);
    const file = path.join(dir, 'src.db');
    looseSource(file, { version: SUPPORTED_SCHEMA_VERSION, tables: ['observations'] }).close();

    const report = importFrom(db, file, { snapshotDir: path.join(dir, 'snap') });
    expect(report.validation).toEqual({ ok: false, notes: ['1 imported entries have no vector'] });
  });
});

describe('restoreExport edge cases', () => {
  const write = (payload: unknown) => {
    const file = path.join(dir, `export-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(payload));
    return file;
  };

  it('names an unstated or foreign schema version', () => {
    expect(() => restoreExport(db, write({}))).toThrow(/export schema version unstated/);
    expect(() => restoreExport(db, write({ schema_version: 2 }))).toThrow(/export schema version 2;/);
  });

  it('ignores a section that is not a list', () => {
    const report = restoreExport(db, write({ schema_version: 1, entries: 'nope', evidence: {} }));
    expect(report.entries).toEqual({ restored: 0, skipped: 0 });
    expect(report.evidence).toEqual({ restored: 0, skipped: 0 });
  });

  it('restores receipts and their items once, with defaults, and skips items it cannot place', () => {
    const payload = {
      schema_version: 1,
      entries: [
        { id: 10, entry_uid: 'e-old', project: 'p', kind: 'observation', title: 'Old', narrative: 'o', generator: 'g', occurred_at: '2025-10-04T00:00:00Z', created_at: '2025-10-04T00:00:00Z', superseded_by: 11 },
        { id: 11, entry_uid: 'e-new', project: 'p', kind: 'observation', title: 'New', narrative: 'n', generator: 'g', occurred_at: '2025-10-04T00:00:00Z', created_at: '2025-10-04T00:00:00Z', superseded_by: null },
      ],
      receipts: [{ id: 7, receipt_uid: 'r-1', project: 'p', scope: 'search', method: 'est', base_tokens: 5, delivered_tokens: 3, item_count: 1, delivery: 'unknown', created_at: '2025-10-04T00:00:00Z' }],
      receipt_items: [
        { receipt_id: 7, entry_id: 10 },
        { receipt_id: 99, entry_id: 10 },
        { receipt_id: 7, entry_id: 99 },
      ],
    };
    const file = write(payload);
    const first = restoreExport(db, file);
    expect(first.receipts).toEqual({ restored: 1, skipped: 0 });
    expect(first.receiptItems).toBe(1);
    const item = db.prepare('SELECT source_tokens, sent_tokens, stage FROM context_receipt_items').get();
    expect(item).toEqual({ source_tokens: 0, sent_tokens: 0, stage: 'index' });
    const old = db.prepare("SELECT superseded_by FROM memory_entries WHERE entry_uid = 'e-old'").get() as { superseded_by: number };
    const neu = db.prepare("SELECT id FROM memory_entries WHERE entry_uid = 'e-new'").get() as { id: number };
    expect(old.superseded_by).toBe(neu.id);

    const second = restoreExport(db, file);
    expect(second.receipts).toEqual({ restored: 0, skipped: 1 });
    expect(second.receiptItems).toBe(0);
  });
});
