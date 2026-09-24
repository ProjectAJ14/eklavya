import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations, schemaVersion } from '../src/migrate.js';
import { openDb } from '../src/db.js';
import { migrationsDir } from '../src/paths.js';
import { tempDbPath, cleanup } from './helpers.js';

/** Bump alongside the newest migration file. */
const LATEST_SCHEMA_VERSION = 15;

const LEARNING_TABLES = [
  'attempts',
  'checkpoints',
  'concepts',
  'edges',
  'gates',
  'mastery',
  'meta',
  'project_levels',
  'session_concepts',
  'stop_markers',
];

/**
 * The memory half (migration 009). Listed separately from the learning tables
 * because the one guarantee worth asserting here is that adding memory did not
 * rename or drop anything learning depends on.
 *
 * `memory_fts_*` are FTS5's own shadow tables. They are named rather than
 * filtered out so that swapping the index implementation shows up as a failing
 * test rather than as a silent change of on-disk shape.
 */
const MEMORY_TABLES = [
  'context_receipt_items',
  'context_receipts',
  'evidence_events',
  'learning_sources',
  'memory_batches',
  'memory_collection_items',
  'memory_collections',
  'memory_entries',
  'memory_entry_events',
  'memory_entry_tags',
  'memory_fts',
  'memory_fts_config',
  'memory_fts_data',
  'memory_fts_docsize',
  'memory_fts_idx',
  'memory_jobs',
  'memory_vectors',
];

/** Migration 010: the importer's durable id map (PRD MIG-02). */
const IMPORT_TABLES = ['import_id_map'];

/**
 * Migration 011: multi-device sync through a shared directory (ADR-09).
 *
 * Listed apart from the memory tables for the reason SEC-02 gives: what syncs
 * is memory, and a learning table appearing in this list would be the first
 * sign that a developer's assessment history had started crossing machines.
 */
const SYNC_TABLES = ['sync_conflicts', 'sync_records', 'sync_state'];

const EXPECTED_TABLES = [
  ...LEARNING_TABLES,
  ...MEMORY_TABLES,
  ...IMPORT_TABLES,
  ...SYNC_TABLES,
].sort();

let dbFile = '';
afterEach(() => {
  if (dbFile) cleanup(dbFile);
  dbFile = '';
});

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_'))
    .sort();
}

describe('migrations', () => {
  it('creates every table the design requires', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(tableNames(db)).toEqual(EXPECTED_TABLES);
    db.close();
  });

  it('records the schema version', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('applies every migration file on a fresh database', () => {
    const db = new Database(':memory:');
    expect(runMigrations(db).length).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('upgrades an older install by applying only the migrations it is missing', () => {
    // Build a genuine v1 database: a directory holding nothing but 001.
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-mig-'));
    try {
      fs.copyFileSync(
        path.join(migrationsDir(), '001_init.sql'),
        path.join(oldDir, '001_init.sql'),
      );

      const db = new Database(':memory:');
      expect(runMigrations(db, oldDir)).toEqual(['001_init.sql']);
      expect(schemaVersion(db)).toBe(1);

      // Now hand it the full set: only the newer files should run.
      expect(runMigrations(db)).toEqual([
        '002_stop_markers.sql',
        '003_gate_repo.sql',
        '004_attempt_outcome.sql',
        '005_session_concept_origin.sql',
        '006_attempt_format.sql',
        '007_checkpoints.sql',
        '008_difficulty_levels.sql',
        '009_memory.sql',
        '010_import.sql',
        '011_sync.sql',
        '012_job_backoff.sql',
        '013_batch_provenance.sql',
        '014_batch_events_index.sql',
        '015_event_link_indexes.sql',
      ]);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(tableNames(db)).toEqual(EXPECTED_TABLES);

      // And the upgraded table really has the new column.
      const cols = (db.prepare('PRAGMA table_info(gates)').all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain('repo');

      // 012 adds a column to a table 009 created, so it only survives if the
      // two ran in order on the same database rather than each from scratch.
      const jobCols = (db.prepare('PRAGMA table_info(memory_jobs)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(jobCols).toContain('next_attempt');

      // 013 does the same to memory_batches: the run identity MEM-01 asks for.
      const batchCols = (db.prepare('PRAGMA table_info(memory_batches)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(batchCols).toContain('summarizer');
      expect(batchCols).toContain('config_digest');

      // 014 indexes the key the worker retires a batch by. Asserting the plan
      // rather than the index name, because the failure it prevents is the scan:
      // without it, summarising one fixed-size batch costs a pass over every
      // event ever captured, which is 613ms at a million of them.
      const plan = db
        .prepare("EXPLAIN QUERY PLAN SELECT * FROM evidence_events WHERE batch_id = ?")
        .all(1) as { detail: string }[];
      expect(plan.map((r) => r.detail).join(' ')).toContain('idx_events_batch');
      db.close();
    } finally {
      fs.rmSync(oldDir, { recursive: true, force: true });
    }
  });

  it('upgrades a populated v14 database with the event_id indexes retention needs', () => {
    // Deleting an evidence event makes SQLite find its rows in the two tables
    // that reference it by event_id. Without an index there, each deleted event
    // cost a scan of every link and every candidate.
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-mig-'));
    try {
      for (const f of fs.readdirSync(migrationsDir()).filter((f) => f < '015')) {
        fs.copyFileSync(path.join(migrationsDir(), f), path.join(oldDir, f));
      }
      const db = new Database(':memory:');
      runMigrations(db, oldDir);
      expect(schemaVersion(db)).toBe(14);
      db.prepare(
        "INSERT INTO evidence_events (id, event_uid, project, session_id, kind, occurred_at) VALUES (1, 'u', 'p', 's', 'note', 'now')",
      ).run();
      db.prepare("INSERT INTO memory_entries (id, entry_uid, project, title, occurred_at) VALUES (1, 'e', 'p', 't', 'now')").run();
      db.prepare('INSERT INTO memory_entry_events (entry_id, event_id) VALUES (1, 1)').run();
      db.prepare("INSERT INTO learning_sources (event_id, slug, project) VALUES (1, 'x', 'p')").run();

      expect(runMigrations(db)).toEqual(['015_event_link_indexes.sql']);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(db.prepare('SELECT COUNT(*) AS n FROM memory_entry_events').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM learning_sources WHERE event_id = 1').get()).toEqual({ n: 1 });

      const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(
        (r) => r.name,
      );
      expect(indexes).toEqual(
        expect.arrayContaining(['idx_entry_events_event', 'idx_sources_event', 'idx_receipts_session']),
      );
      // The plan, not the name, is the thing that matters: a lookup by event_id
      // alone must search an index rather than scan the table.
      for (const [table, index] of [
        ['memory_entry_events', 'idx_entry_events_event'],
        ['learning_sources', 'idx_sources_event'],
        ['context_receipts', 'idx_receipts_session'],
      ]) {
        const column = table === 'context_receipts' ? 'session_id' : 'event_id';
        const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE ${column} = ?`).all(1) as {
          detail: string;
        }[]).map((r) => r.detail).join(' ');
        expect(plan).toContain(index);
        expect(plan).not.toMatch(/^SCAN/);
      }
      db.close();
    } finally {
      fs.rmSync(oldDir, { recursive: true, force: true });
    }
  });

  it('is idempotent — a second run applies nothing', () => {
    const db = new Database(':memory:');
    const first = runMigrations(db);
    const second = runMigrations(db);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual([]);
    expect(tableNames(db)).toEqual(EXPECTED_TABLES);
    db.close();
  });

  it('survives reopening the same file twice', () => {
    dbFile = tempDbPath('migrate');
    openDb(dbFile).close();
    const db = openDb(dbFile);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(tableNames(db)).toEqual(EXPECTED_TABLES);
    db.close();
  });
});

describe('pragmas', () => {
  it('enables WAL and foreign keys on a file database', () => {
    dbFile = tempDbPath('pragma');
    const db = openDb(dbFile);
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(Number(db.pragma('busy_timeout', { simple: true }))).toBeGreaterThan(0);
    db.close();
  });

  it('actually enforces the foreign keys', () => {
    dbFile = tempDbPath('fk');
    const db = openDb(dbFile);
    expect(() =>
      db.prepare('INSERT INTO mastery (concept_id) VALUES (?)').run(999999),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });
});
