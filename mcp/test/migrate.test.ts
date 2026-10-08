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
const LATEST_SCHEMA_VERSION = 26;

const LEARNING_TABLES = [
  'attempt_retries',
  'attempts',
  'checkpoints',
  'concepts',
  'edges',
  'gates',
  'mastery',
  'meta',
  'panel_questions',
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
 * Migrations 011, 022 and 023: multi-device sync through a shared directory (ADR-09),
 * the correction links waiting for a replacement, and the per-revision receipts
 * that let records arrive out of order.
 *
 * Listed apart from the memory tables for the reason SEC-02 gives: what syncs
 * is memory, and a learning table appearing in this list would be the first
 * sign that a developer's assessment history had started crossing machines.
 */
const SYNC_TABLES = ['sync_conflicts', 'sync_received', 'sync_records', 'sync_state', 'sync_supersessions'];

/** Migration 016: feature-use counts for the anonymous usage ping. */
const USAGE_TABLES = ['usage_counts'];

/** Migration 017: the root commits a moved checkout is recognised by. */
const IDENTITY_TABLES = ['project_roots'];

/** Migration 018: every memory read tool call, linked to a receipt or not. */
const READ_TABLES = ['memory_reads'];

/** Migration 021: the counter the dashboard's stale-data notice polls. */
const CHANGE_TABLES = ['change_version'];

/**
 * Migration 026: prompt feedback. Apart from the learning tables on purpose:
 * nothing here references attempts, mastery or concepts, so feedback cannot
 * change a score.
 */
const FEEDBACK_TABLES = ['feedback_items', 'feedback_reviewed'];

const EXPECTED_TABLES = [
  ...LEARNING_TABLES,
  ...USAGE_TABLES,
  ...IDENTITY_TABLES,
  ...READ_TABLES,
  ...CHANGE_TABLES,
  ...FEEDBACK_TABLES,
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
        '016_usage_counts.sql',
        '017_project_roots.sql',
        '018_memory_reads.sql',
        '019_attempt_corrections.sql',
        '020_memory_fts_live.sql',
        '021_change_version.sql',
        '022_sync_supersessions.sql',
        '023_sync_received.sql',
        '024_purge_excluded_file_failures.sql',
        '025_panel_questions.sql',
        '026_feedback.sql',
      ]);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(tableNames(db)).toEqual(EXPECTED_TABLES);

      // And the upgraded table really has the new column.
      const cols = (db.prepare('PRAGMA table_info(gates)').all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain('repo');

      // Migration 019: the answer key and the correction link on attempts.
      const attemptCols = (db.prepare('PRAGMA table_info(attempts)').all() as { name: string }[]).map((c) => c.name);
      expect(attemptCols).toEqual(expect.arrayContaining(['correct', 'option_notes', 'retry_of']));

      // 012 adds a column to a table 009 created, so it only survives if the
      // two ran in order on the same database rather than each from scratch.
      // 023 adds a column to the sync_state table 011 created.
      const syncCols = (db.prepare('PRAGMA table_info(sync_state)').all() as { name: string }[]).map((c) => c.name);
      expect(syncCols).toContain('outstanding');

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

      expect(runMigrations(db)).toEqual(['015_event_link_indexes.sql', '016_usage_counts.sql', '017_project_roots.sql', '018_memory_reads.sql', '019_attempt_corrections.sql', '020_memory_fts_live.sql', '021_change_version.sql', '022_sync_supersessions.sql', '023_sync_received.sql', '024_purge_excluded_file_failures.sql', '025_panel_questions.sql', '026_feedback.sql']);
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

  it('repairs a v19 memory index that a repeated soft delete had corrupted', () => {
    // Before 020, a soft delete removed the row's terms twice: once through the
    // update trigger and once by hand. Reproduce that on a v19 database, then
    // check the upgrade rebuilds the index without losing any row or state.
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-mig-'));
    try {
      for (const f of fs.readdirSync(migrationsDir()).filter((f) => f < '020')) {
        fs.copyFileSync(path.join(migrationsDir(), f), path.join(oldDir, f));
      }
      const db = new Database(':memory:');
      runMigrations(db, oldDir);
      expect(schemaVersion(db)).toBe(19);
      const insert = db.prepare(
        "INSERT INTO memory_entries (id, entry_uid, project, title, narrative, occurred_at) VALUES (?, ?, 'p', ?, ?, 'now')",
      );
      insert.run(1, 'a', 'Lease renewal', 'The worker renews its lease.');
      insert.run(2, 'b', 'Checkpoint starvation', 'Readers starve the checkpoint.');
      db.prepare("UPDATE memory_entries SET deleted_at = 'then' WHERE id = 1").run();
      db.prepare(
        `INSERT INTO memory_fts(memory_fts, rowid, title, narrative, facts, files)
         SELECT 'delete', id, title, narrative, facts, files FROM memory_entries WHERE id = 1`,
      ).run();
      expect(() => db.prepare("UPDATE memory_entries SET deleted_at = 'again' WHERE id = 1").run()).toThrow(/malformed/);

      expect(runMigrations(db)).toEqual(['020_memory_fts_live.sql', '021_change_version.sql', '022_sync_supersessions.sql', '023_sync_received.sql', '024_purge_excluded_file_failures.sql', '025_panel_questions.sql', '026_feedback.sql']);
      db.exec("INSERT INTO memory_fts(memory_fts, rank) VALUES ('integrity-check', 1)");
      expect(db.prepare('SELECT id, deleted_at FROM memory_entries ORDER BY id').all()).toEqual([
        { id: 1, deleted_at: 'then' },
        { id: 2, deleted_at: null },
      ]);
      const hits = (q: string) =>
        (db.prepare('SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?').all(q) as { rowid: number }[]).map((r) => r.rowid);
      expect(hits('checkpoint')).toEqual([2]);
      expect(hits('lease')).toEqual([]);

      db.prepare("UPDATE memory_entries SET deleted_at = 'again' WHERE id = 1").run();
      db.prepare('DELETE FROM memory_entries WHERE id = 1').run();
      db.prepare('DELETE FROM memory_entries WHERE id = 2').run();
      db.exec("INSERT INTO memory_fts(memory_fts, rank) VALUES ('integrity-check', 1)");
      expect(hits('checkpoint')).toEqual([]);
      db.close();
    } finally {
      fs.rmSync(oldDir, { recursive: true, force: true });
    }
  });

  it('purges failed reads and edits of excluded files that a v23 database kept', () => {
    // Before capture applied path exclusions to failures, a failed Read of an
    // excluded file was stored with its path stripped and its error kept.
    // Synthetic text only.
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-mig-'));
    try {
      for (const f of fs.readdirSync(migrationsDir()).filter((f) => f < '024')) {
        fs.copyFileSync(path.join(migrationsDir(), f), path.join(oldDir, f));
      }
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db, oldDir);
      expect(schemaVersion(db)).toBe(23);
      const event = db.prepare(
        "INSERT INTO evidence_events (id, event_uid, project, session_id, kind, tool, body, files, occurred_at) VALUES (?, ?, 'p', 's', ?, ?, ?, ?, 'now')",
      );
      event.run(1, 'leak-read', 'tool_error', 'Read', 'SYNTHETIC_PRIVATE_TEXT', null);
      event.run(2, 'leak-edit', 'tool_error', 'Edit', 'SYNTHETIC_PRIVATE_TEXT', '[]');
      event.run(3, 'allowed', 'tool_error', 'Read', 'File does not exist', '["src/auth.ts"]');
      event.run(4, 'bash', 'tool_error', 'Bash', 'npm test failed', null);
      event.run(5, 'read', 'file_read', 'Read', 'file_path=src/auth.ts', '["src/auth.ts"]');
      db.prepare("INSERT INTO memory_entries (id, entry_uid, project, title, occurred_at) VALUES (1, 'e', 'p', 't', 'now')").run();
      db.prepare('INSERT INTO memory_entry_events (entry_id, event_id) VALUES (1, 1), (1, 3)').run();
      db.prepare("INSERT INTO learning_sources (id, event_id, slug, project) VALUES (1, 1, 'x', 'p')").run();

      expect(runMigrations(db)).toEqual(['024_purge_excluded_file_failures.sql', '025_panel_questions.sql', '026_feedback.sql']);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect((db.prepare('SELECT id FROM evidence_events ORDER BY id').all() as { id: number }[]).map((r) => r.id)).toEqual([3, 4, 5]);
      // The entry and the candidate stay; only the links to the purged event go.
      expect(db.prepare('SELECT event_id FROM memory_entry_events').all()).toEqual([{ event_id: 3 }]);
      expect(db.prepare('SELECT event_id FROM learning_sources WHERE id = 1').get()).toEqual({ event_id: null });
      expect(db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get()).toEqual({ n: 1 });
      expect(tableNames(db)).toEqual(EXPECTED_TABLES);
      db.close();
    } finally {
      fs.rmSync(oldDir, { recursive: true, force: true });
    }
  });

  it('counts the writes a dashboard shows and not the bookkeeping it does not', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const n = () => (db.prepare('SELECT n FROM change_version').get() as { n: number }).n;
    expect(n()).toBe(0);

    db.prepare("INSERT INTO memory_entries (id, entry_uid, project, title, occurred_at) VALUES (1, 'e', 'p', 't', 'now')").run();
    expect(n()).toBe(1);
    // In place, which no row count can see: the rolling session summary.
    db.prepare("UPDATE memory_entries SET narrative = 'next steps' WHERE id = 1").run();
    expect(n()).toBe(2);

    // A gate is upserted every turn; the page reads only which repo it names.
    db.prepare("INSERT INTO gates (session_id, mode) VALUES ('s', 'ambient')").run();
    const gate = n();
    db.prepare("UPDATE gates SET answered = 1, updated_at = 'later' WHERE session_id = 's'").run();
    expect(n()).toBe(gate);
    db.prepare("UPDATE gates SET repo = '/r' WHERE session_id = 's'").run();
    expect(n()).toBe(gate + 1);

    // A lease renewal is not a queue change; a status move is.
    db.prepare("INSERT INTO memory_batches (id, project, session_id, reason) VALUES (1, 'p', 's', 'manual')").run();
    db.prepare("INSERT INTO memory_jobs (id, batch_id) VALUES (1, 1)").run();
    const job = n();
    db.prepare("UPDATE memory_jobs SET lease_until = 'later', updated_at = 'later' WHERE id = 1").run();
    expect(n()).toBe(job);
    db.prepare("UPDATE memory_jobs SET status = 'claimed' WHERE id = 1").run();
    expect(n()).toBe(job + 1);

    // Bookkeeping the page never shows.
    db.prepare("INSERT INTO meta (key, value) VALUES ('x', 'y')").run();
    db.prepare("INSERT INTO usage_counts (day, name, n) VALUES ('2026-10-03', 'k', 1)").run();
    expect(n()).toBe(job + 1);
    db.close();
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

  it('creates the panel question table with its columns and one-open-per-session index', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const cols = (db.prepare('PRAGMA table_info(panel_questions)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      'id', 'session_id', 'repo', 'concept_id', 'tier', 'stem', 'options', 'key', 'explanation', 'more',
      'phase', 'attempt_id', 'result', 'created_at', 'updated_at',
    ]);
    db.prepare("INSERT INTO concepts (id, slug, name, domain) VALUES (1, 'c', 'C', 'd')").run();
    const add = db.prepare(
      "INSERT INTO panel_questions (id, session_id, repo, concept_id, tier, stem, options, key, explanation, phase) VALUES (?, 's', 'r', 1, 1, 'q', '[]', '{}', 'e', ?)",
    );
    add.run('a', 'pending');
    // A second open question for one session is refused, whichever open phase it is in.
    expect(() => add.run('b', 'unplaced')).toThrow(/UNIQUE/);
    expect(() => add.run('c', 'grading')).toThrow(/UNIQUE/);
    // Closed rows are not open: any number may sit beside the open one.
    add.run('d', 'answered');
    add.run('e', 'skipped');
    add.run('f', 'expired');
    expect(() => add.run('g', 'nonsense')).toThrow(/CHECK/);
    db.close();
  });

  it('creates the feedback tables, a one-pending index and no link to grading', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const cols = (db.prepare('PRAGMA table_info(feedback_items)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      'id', 'session_id', 'project', 'event_id', 'prompt', 'review', 'better', 'tips', 'rubric', 'model',
      'created_at', 'acknowledged_at',
    ]);
    const add = db.prepare(
      "INSERT INTO feedback_items (session_id, project, prompt, review, better, tips, rubric, model, acknowledged_at) VALUES ('s', 'p', 'x', '{}', 'b', '[]', 1, 'm', ?)",
    );
    add.run('2026-01-01');
    add.run('2026-01-02');
    add.run(null);
    expect(() => add.run(null)).toThrow(/UNIQUE/);
    for (const table of ['feedback_items', 'feedback_reviewed']) {
      expect(db.prepare(`PRAGMA foreign_key_list(${table})`).all()).toEqual([]);
    }
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
