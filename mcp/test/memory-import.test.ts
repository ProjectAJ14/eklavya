import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import {
  importFrom,
  inventory,
  exportPayload,
  restoreExport,
  ImportError,
  EXPORT_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSION,
} from '../src/memory/import.js';
import { keywordSearch, semanticSearch } from '../src/memory/search.js';
import { appendEvent, countEntries, entryEvents, entryTags, insertEntry, timeline } from '../src/memory/store.js';

/**
 * Every row below is invented. The real Claude Mem database on a developer's
 * machine is their private history; a test fixture that borrowed from it would
 * put that history in git, so the schema is copied and the content is not.
 */

const PROJECT = 'demo-repo';
const SESSION = 'mem-session-1';
const OCT = Date.UTC(2025, 9, 4, 11, 30, 0); // the original timestamps under test

let sourceDir = '';
let sourcePath = '';
let snapshotDir = '';
let dbFile = '';
let db: DB;

/** The schema this importer was read against, trimmed to what it imports. */
function buildSource(schemaVersion: number = SUPPORTED_SCHEMA_VERSION): void {
  const src = new Database(sourcePath);
  src.pragma('journal_mode = WAL');
  src.exec(`
    CREATE TABLE schema_versions (id INTEGER PRIMARY KEY, version INTEGER UNIQUE NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content_session_id TEXT NOT NULL, memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL, platform_source TEXT NOT NULL DEFAULT 'claude', user_prompt TEXT,
      started_at TEXT NOT NULL, started_at_epoch INTEGER NOT NULL, completed_at TEXT, completed_at_epoch INTEGER,
      status TEXT NOT NULL DEFAULT 'active', worker_port INTEGER, prompt_counter INTEGER DEFAULT 0,
      custom_title TEXT, observed_model TEXT, observed_billing TEXT);
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT NOT NULL, project TEXT NOT NULL,
      text TEXT, type TEXT NOT NULL, title TEXT, subtitle TEXT, facts TEXT, narrative TEXT, concepts TEXT,
      files_read TEXT, files_modified TEXT, prompt_number INTEGER, discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL, content_hash TEXT, generated_by_model TEXT,
      relevance_count INTEGER DEFAULT 0, merged_into_project TEXT, agent_type TEXT, agent_id TEXT,
      metadata TEXT, synced_at INTEGER, origin_device_id TEXT, origin_local_id TEXT,
      sync_rev TEXT NOT NULL DEFAULT '1');
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT NOT NULL, project TEXT NOT NULL,
      request TEXT, investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, files_read TEXT,
      files_edited TEXT, notes TEXT, prompt_number INTEGER, discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL, merged_into_project TEXT,
      synced_at INTEGER, origin_device_id TEXT, origin_local_id TEXT, sync_rev TEXT NOT NULL DEFAULT '1');
    CREATE TABLE user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_db_id INTEGER, content_session_id TEXT NOT NULL,
      prompt_number INTEGER NOT NULL, prompt_text TEXT NOT NULL, created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL, synced_at INTEGER, origin_device_id TEXT, origin_local_id TEXT,
      sync_rev TEXT NOT NULL DEFAULT '1');
    CREATE TABLE tool_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tool_use_id TEXT NOT NULL, content_session_id TEXT NOT NULL,
      memory_session_id TEXT, session_db_id INTEGER, project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT 'claude', tool_name TEXT NOT NULL, tool_input TEXT,
      tool_response TEXT, cwd TEXT, prompt_number INTEGER, agent_type TEXT, agent_id TEXT,
      observation_id INTEGER, or_generation_id TEXT, or_session_id TEXT, content_hash TEXT,
      created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL, UNIQUE(content_session_id, tool_use_id));
    CREATE TABLE pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_db_id INTEGER NOT NULL, content_session_id TEXT NOT NULL,
      message_type TEXT NOT NULL, tool_name TEXT, tool_input TEXT, tool_response TEXT, cwd TEXT,
      last_user_message TEXT, last_assistant_message TEXT, prompt_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pending', created_at_epoch INTEGER NOT NULL, agent_type TEXT,
      agent_id TEXT, tool_use_id TEXT);
    CREATE TABLE sync_state (k TEXT PRIMARY KEY, v TEXT);
  `);

  src.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(
    schemaVersion,
    new Date(OCT).toISOString(),
  );
  src
    .prepare(
      `INSERT INTO sdk_sessions (id, content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
       VALUES (1, 'content-1', ?, ?, ?, ?, 'completed')`,
    )
    .run(SESSION, PROJECT, new Date(OCT).toISOString(), OCT);

  src
    .prepare(
      `INSERT INTO observations
         (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
          files_read, files_modified, created_at, created_at_epoch, generated_by_model, agent_type,
          metadata, origin_device_id, origin_local_id, discovery_tokens)
       VALUES (?, ?, ?, 'bugfix', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sonnet-test', 'general',
               '{"secret":"do-not-import"}', 'device-abc', 'local-9', 4242)`,
    )
    .run(
      SESSION,
      PROJECT,
      'fallback text',
      'Fixed the refresh token rotation bug',
      'auth kept logging people out',
      JSON.stringify(['tokens rotate on every refresh', 'the old token is revoked']),
      'The refresh handler reused the previous token, so a replayed request logged the user out.',
      JSON.stringify(['refresh-token-rotation', 'JWT expiry']),
      JSON.stringify(['src/auth/session.ts']),
      JSON.stringify(['src/auth/refresh.ts']),
      new Date(OCT).toISOString(),
      OCT,
    );

  src
    .prepare(
      `INSERT INTO observations
         (memory_session_id, project, type, title, narrative, created_at, created_at_epoch, merged_into_project)
       VALUES (?, 'old-name', 'refactor', 'Split the migration runner', 'One guarded runner instead of three.', ?, ?, ?)`,
    )
    .run(SESSION, new Date(OCT + 3_600_000).toISOString(), OCT + 3_600_000, PROJECT);

  src
    .prepare(
      `INSERT INTO session_summaries
         (memory_session_id, project, request, investigated, learned, completed, next_steps, notes,
          files_read, files_edited, created_at, created_at_epoch)
       VALUES (?, ?, 'Make login stop dropping sessions', 'the refresh path', 'rotation must revoke',
               'shipped the fix', 'add a regression test', 'noisy logs', ?, ?, ?, ?)`,
    )
    .run(
      SESSION,
      PROJECT,
      JSON.stringify(['src/auth/session.ts']),
      JSON.stringify(['src/auth/refresh.ts']),
      new Date(OCT + 7_200_000).toISOString(),
      OCT + 7_200_000,
    );

  src
    .prepare(
      `INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
       VALUES (1, 'content-1', 1, 'why do I keep getting logged out?', ?, ?)`,
    )
    .run(new Date(OCT).toISOString(), OCT);

  src
    .prepare(
      `INSERT INTO tool_uses (tool_use_id, content_session_id, memory_session_id, project, tool_name,
                              tool_input, tool_response, cwd, created_at, created_at_epoch, or_generation_id)
       VALUES ('tu-1', 'content-1', ?, ?, 'Edit', '{"file":"src/auth/refresh.ts"}', 'ok', '/work/demo-repo', ?, ?, 'gen-1')`,
    )
    .run(SESSION, PROJECT, new Date(OCT).toISOString(), OCT);

  // Runtime state that must never be copied into Eklavya (PRD MIG-01).
  src
    .prepare(
      `INSERT INTO pending_messages (session_db_id, content_session_id, message_type, created_at_epoch)
       VALUES (1, 'content-1', 'observation', ?)`,
    )
    .run(OCT);
  src.prepare('INSERT INTO sync_state (k, v) VALUES (?, ?)').run('device_id', 'device-abc');

  // Left open until now so the WAL still holds uncheckpointed rows: a bare file
  // copy of the main database would miss them, which is the point of VACUUM INTO.
  src.close();
}

function learningCounts(): Record<string, number> {
  const one = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    concepts: one('concepts'),
    attempts: one('attempts'),
    mastery: one('mastery'),
    gates: one('gates'),
    session_concepts: one('session_concepts'),
  };
}

beforeEach(() => {
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mem-src-'));
  sourcePath = path.join(sourceDir, 'claude-mem.db');
  snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-snap-'));
  dbFile = tempDbPath('eklavya-import');
  db = openDb(dbFile);
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  for (const dir of [sourceDir, snapshotDir]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('inventory', () => {
  it('reports the schema version, tables, projects and date range without writing', () => {
    buildSource();
    const before = fs.statSync(sourcePath).mtimeMs;

    const found = inventory(sourcePath);
    expect(found.supported).toBe(true);
    expect(found.schemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(Object.fromEntries(found.tables.map((t) => [t.name, t.rows]))).toMatchObject({
      observations: 2,
      session_summaries: 1,
      user_prompts: 1,
      tool_uses: 1,
      pending_messages: 1,
    });
    // `merged_into_project` already folded the renamed project, so both
    // observations report under the new name.
    expect(found.projects).toEqual([{ project: PROJECT, entries: 2 }]);
    expect(found.dateRange.from?.slice(0, 10)).toBe('2025-10-04');
    expect(fs.statSync(sourcePath).mtimeMs).toBe(before);
  });

  it('says which fields are mapped, which are dropped and why', () => {
    buildSource();
    const fields = inventory(sourcePath).fields;

    const mapped = fields.find((f) => f.table === 'observations' && f.field === 'created_at_epoch');
    expect(mapped?.kind).toBe('mapped');
    expect(mapped?.to).toBe('memory_entries.occurred_at');

    // The three MIG-01 forbids: foreign device identity, live jobs, credentials.
    for (const [table, field] of [
      ['observations', 'origin_device_id'],
      ['pending_messages', '*'],
      ['sync_state', '*'],
    ] as const) {
      const row = fields.find((f) => f.table === table && f.field === field);
      expect(row?.kind).toBe('dropped');
      expect(row?.reason.length).toBeGreaterThan(10);
    }
  });

  it('reports a column added since this importer was written rather than dropping it silently', () => {
    buildSource();
    const src = new Database(sourcePath);
    src.exec('ALTER TABLE observations ADD COLUMN mood TEXT');
    src.close();

    const unknown = inventory(sourcePath).fields.find((f) => f.field === 'mood');
    expect(unknown?.kind).toBe('unrecognised');
  });
});

describe('importFrom', () => {
  it('brings entries in with their original timestamps and import provenance', () => {
    buildSource();
    const report = importFrom(db, sourcePath, { snapshotDir });

    expect(report.imported).toEqual({
      observations: 2,
      session_summaries: 1,
      user_prompts: 1,
      tool_uses: 1,
    });
    expect(report.validation.ok).toBe(true);

    const entries = timeline(db, { project: PROJECT, limit: 50 });
    expect(entries).toHaveLength(3);
    for (const entry of entries) expect(entry.import_source).toBe('claude-mem');

    const fix = entries.find((e) => e.title.startsWith('Fixed the refresh'));
    // The original timestamp, not the time of the import.
    expect(fix?.occurred_at).toBe(new Date(OCT).toISOString());
    expect(fix?.generator).toBe('claude-mem:sonnet-test');
    expect(JSON.parse(fix!.files as string).sort()).toEqual(['src/auth/refresh.ts', 'src/auth/session.ts']);

    // `merged_into_project` wins, so the renamed project does not reappear.
    expect(entries.every((e) => e.project === PROJECT)).toBe(true);
  });

  it('files source concepts as unassessed candidates, never as concepts or mastery', () => {
    buildSource();
    const before = learningCounts();
    importFrom(db, sourcePath, { snapshotDir });

    const candidates = db
      .prepare('SELECT slug, status, confidence FROM learning_sources ORDER BY slug')
      .all() as { slug: string; status: string; confidence: number }[];
    expect(candidates.map((c) => c.slug)).toEqual(['jwt-expiry', 'refresh-token-rotation']);
    expect(candidates.every((c) => c.status === 'candidate')).toBe(true);

    // The whole point: nothing in the learning half moved.
    expect(learningCounts()).toEqual(before);
  });

  it('leaves the learning tables untouched', () => {
    buildSource();
    const before = learningCounts();
    importFrom(db, sourcePath, { snapshotDir });
    expect(learningCounts()).toEqual(before);
  });

  it('copies no worker jobs, credentials or foreign device identity into runtime state', () => {
    buildSource();
    importFrom(db, sourcePath, { snapshotDir });

    // pending_messages is a live queue; importing it would resurrect another
    // install's work as ours.
    expect((db.prepare('SELECT COUNT(*) AS n FROM memory_jobs').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM memory_batches').get() as { n: number }).n).toBe(0);

    const blob = JSON.stringify(
      db.prepare('SELECT * FROM memory_entries').all(),
    );
    expect(blob).not.toContain('device-abc');
    expect(blob).not.toContain('do-not-import');
  });

  it('never mutates the source database', () => {
    buildSource();
    const before = fs.readFileSync(sourcePath);
    importFrom(db, sourcePath, { snapshotDir });
    expect(fs.readFileSync(sourcePath).equals(before)).toBe(true);
  });

  it('does not leave a copy of the whole history in a temp directory', () => {
    buildSource();
    const report = importFrom(db, sourcePath, { snapshotDir });
    expect(report.validation.ok).toBe(true);
    expect(fs.existsSync(report.snapshot!)).toBe(false);
  });

  it('takes a snapshot that includes rows still sitting in the WAL', () => {
    buildSource();
    // A row written and left uncheckpointed, with the writer still open so the
    // WAL survives. `cp claude-mem.db` would hand back two observations; only a
    // snapshot that reads through the log sees the third.
    const writer = new Database(sourcePath);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer
      .prepare(
        `INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
         VALUES (?, ?, 'discovery', 'Written straight into the WAL', 'Never checkpointed.', ?, ?)`,
      )
      .run(SESSION, PROJECT, new Date(OCT + 60_000).toISOString(), OCT + 60_000);
    try {
      expect(fs.statSync(`${sourcePath}-wal`).size).toBeGreaterThan(0);
      expect(importFrom(db, sourcePath, { snapshotDir }).imported.observations).toBe(3);
    } finally {
      writer.close();
    }
  });

  it('adds nothing on a second run', () => {
    buildSource();
    importFrom(db, sourcePath, { snapshotDir });
    const entriesAfterFirst = countEntries(db);
    const eventsAfterFirst = (db.prepare('SELECT COUNT(*) AS n FROM evidence_events').get() as { n: number }).n;

    const second = importFrom(db, sourcePath, { snapshotDir, resume: true });
    expect(second.imported).toEqual({
      observations: 0,
      session_summaries: 0,
      user_prompts: 0,
      tool_uses: 0,
    });
    expect(second.skipped).toEqual({
      observations: 2,
      session_summaries: 1,
      user_prompts: 1,
      tool_uses: 1,
    });
    expect(second.validation.ok).toBe(true);
    expect(countEntries(db)).toBe(entriesAfterFirst);
    expect((db.prepare('SELECT COUNT(*) AS n FROM evidence_events').get() as { n: number }).n).toBe(
      eventsAfterFirst,
    );
    expect((db.prepare('SELECT COUNT(*) AS n FROM learning_sources').get() as { n: number }).n).toBe(2);
  });

  it('makes imported entries searchable by keyword and by vector', () => {
    buildSource();
    const report = importFrom(db, sourcePath, { snapshotDir });
    expect(report.reindexed).toBe(3);

    const keyword = keywordSearch(db, 'refresh token rotation', { project: PROJECT });
    expect(keyword.length).toBeGreaterThan(0);
    expect(keyword[0]?.entry.title).toMatch(/refresh token rotation/i);

    expect(semanticSearch(db, 'logged out after refreshing', { project: PROJECT }).length).toBeGreaterThan(0);
  });

  it('records the imported prompts and tool uses as evidence, marked as imported', () => {
    buildSource();
    importFrom(db, sourcePath, { snapshotDir });
    const events = db
      .prepare('SELECT kind, source, host, occurred_at FROM evidence_events ORDER BY kind')
      .all() as { kind: string; source: string; host: string; occurred_at: string }[];
    expect(events.map((e) => e.kind)).toEqual(['prompt', 'tool_use']);
    expect(events.every((e) => e.source === 'import' && e.host === 'claude-mem')).toBe(true);
    expect(events[0]?.occurred_at).toBe(new Date(OCT).toISOString());
  });

  it('writes nothing on a dry run', () => {
    buildSource();
    const report = importFrom(db, sourcePath, { snapshotDir, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.read.observations).toBe(2);
    expect(report.imported.observations).toBe(0);
    expect(countEntries(db)).toBe(0);
    expect(report.unsupportedFields.length).toBeGreaterThan(0);
  });

  it('refuses an unknown newer schema with a message that names the next step', () => {
    buildSource(SUPPORTED_SCHEMA_VERSION + 7);
    expect(() => importFrom(db, sourcePath, { snapshotDir })).toThrow(ImportError);
    expect(() => importFrom(db, sourcePath, { snapshotDir })).toThrow(
      new RegExp(`schema version ${SUPPORTED_SCHEMA_VERSION + 7}.*written against ${SUPPORTED_SCHEMA_VERSION}`, 's'),
    );
    expect(() => importFrom(db, sourcePath, { snapshotDir })).toThrow(/--dry-run/);
    expect(countEntries(db)).toBe(0);
  });

  it('refuses a file that is not a Claude Mem database at all', () => {
    const src = new Database(sourcePath);
    src.exec('CREATE TABLE something_else (a)');
    src.close();
    expect(() => inventory(sourcePath).supported).toBeTruthy();
    expect(inventory(sourcePath).supported).toBe(false);
    expect(() => importFrom(db, sourcePath, { snapshotDir })).toThrow(/does not look like a Claude Mem database/);
  });

  it('says so rather than throwing a driver error when the path is wrong', () => {
    expect(() => inventory(path.join(sourceDir, 'nope.db'))).toThrow(/claude-mem\.db/);
  });
});

describe('filing imported history under a local checkout', () => {
  it('maps a source project name onto an Eklavya project key when asked', () => {
    buildSource();
    const report = importFrom(db, sourcePath, { projectMap: { [PROJECT]: '/work/local-checkout' } });
    expect(report.projectsMapped).toEqual([{ from: PROJECT, to: '/work/local-checkout' }]);
    expect(report.projectsKept).toEqual([]);
    const projects = (
      db.prepare('SELECT DISTINCT project FROM memory_entries').all() as { project: string }[]
    ).map((r) => r.project);
    expect(projects).toEqual(['/work/local-checkout']);
  });

  it('names the projects it left alone, because those are only findable across projects', () => {
    // Unmapped history lands in a scope no session queries: a search in the
    // very repository it came from finds nothing until somebody maps it.
    buildSource();
    const report = importFrom(db, sourcePath, {});
    expect(report.projectsMapped).toEqual([]);
    expect(report.projectsKept).toContain(PROJECT);
  });
});

/**
 * The other half of the backup pair. `export` writing a file nothing can read
 * is not a backup, and the rollback drill in the migration guide depends on
 * this half existing.
 */
describe('restoreExport', () => {
  let backupFile = '';

  /** A second Eklavya database, exported to a file — what a real backup is. */
  function backup(fill: (source: DB) => void): string {
    const file = tempDbPath('eklavya-export-source');
    const source = openDb(file);
    try {
      fill(source);
      fs.writeFileSync(backupFile, JSON.stringify(exportPayload(source)), 'utf8');
    } finally {
      source.close();
      cleanup(file);
    }
    return backupFile;
  }

  /** One entry with a tag and a linked evidence event, so every table is used. */
  function oneOfEach(source: DB): void {
    const event = appendEvent(source, {
      eventUid: 'restore-event-1',
      project: PROJECT,
      sessionId: SESSION,
      kind: 'tool_use',
      tool: 'Edit',
      body: 'Rewrote the cookie handler.',
      files: ['src/auth.ts'],
      occurredAt: new Date(OCT).toISOString(),
    });
    insertEntry(source, {
      project: PROJECT,
      title: 'Refresh cookie rotation',
      narrative: 'Every use rotates the cookie because reuse detection needs a one-shot token.',
      facts: ['reuse detection needs a one-shot token'],
      files: ['src/auth.ts'],
      tags: ['auth'],
      eventIds: [event.id],
      occurredAt: new Date(OCT).toISOString(),
    });
  }

  beforeEach(() => {
    backupFile = path.join(snapshotDir, 'backup.json');
  });

  it('round-trips an export into an empty database, evidence links included', () => {
    const report = restoreExport(db, backup(oneOfEach));

    expect(report.entries).toEqual({ restored: 1, skipped: 0 });
    expect(report.evidence).toEqual({ restored: 1, skipped: 0 });
    expect(report.tags).toBe(1);
    expect(report.links).toBe(1);

    const [entry] = timeline(db, {});
    expect(entry.title).toBe('Refresh cookie rotation');
    expect(entry.occurred_at).toBe(new Date(OCT).toISOString());
    expect(entryTags(db, entry.id)).toEqual(['auth']);
    expect(entryEvents(db, entry.id).map((e) => e.body)).toEqual(['Rewrote the cookie handler.']);
  });

  it('rebuilds the search index and the vectors for what it restored', () => {
    restoreExport(db, backup(oneOfEach));
    // Both halves of retrieval, because only one of them is trigger-maintained.
    expect(keywordSearch(db, 'cookie', {}).length).toBe(1);
    expect(semanticSearch(db, 'cookie rotation', {}).length).toBe(1);
  });

  it('adds nothing on a second restore', () => {
    const file = backup(oneOfEach);
    restoreExport(db, file);
    const after = countEntries(db);

    const again = restoreExport(db, file);
    expect(again.entries).toEqual({ restored: 0, skipped: 1 });
    expect(again.evidence).toEqual({ restored: 0, skipped: 1 });
    expect(again.reindexed).toBe(0);
    expect(countEntries(db)).toBe(after);
    expect((db.prepare('SELECT COUNT(*) AS n FROM memory_entry_tags').get() as { n: number }).n).toBe(1);
  });

  it('leaves the learning tables untouched', () => {
    // Rows to lose, so the assertion is about preservation rather than emptiness.
    db.prepare("INSERT INTO attempts (concept_id, question, grade, difficulty) VALUES (1, 'q', 5, 1)").run();
    db.prepare('INSERT INTO mastery (concept_id, score, reps) VALUES (1, 0.9, 4)').run();
    const before = learningCounts();

    restoreExport(db, backup(oneOfEach));

    expect(learningCounts()).toEqual(before);
    expect((db.prepare('SELECT score FROM mastery WHERE concept_id = 1').get() as { score: number }).score).toBe(0.9);
  });

  it('refuses a schema version it does not understand, naming both', () => {
    fs.writeFileSync(backupFile, JSON.stringify({ schema_version: EXPORT_SCHEMA_VERSION + 1, entries: [] }));
    expect(() => restoreExport(db, backupFile)).toThrow(ImportError);
    expect(() => restoreExport(db, backupFile)).toThrow(
      new RegExp(`version ${EXPORT_SCHEMA_VERSION + 1}.*understands version ${EXPORT_SCHEMA_VERSION}`, 's'),
    );
    expect(countEntries(db)).toBe(0);
  });

  it('says so rather than throwing a parser error on a file that is not an export', () => {
    fs.writeFileSync(backupFile, 'not json at all');
    expect(() => restoreExport(db, backupFile)).toThrow(/not readable JSON/);
    expect(() => restoreExport(db, path.join(snapshotDir, 'nope.json'))).toThrow(/No export file at/);
  });
});

describe('a source database does not get to end the process', () => {
  it('survives a timestamp no Date can represent, and imports the row anyway', () => {
    // Each observation commits in its own transaction, so an unguarded
    // `new Date(...).toISOString()` throwing partway through would leave the
    // rows before it committed and nothing saying so — a silent partial import
    // with a stack trace where the report should be.
    buildSource();
    const src = new Database(sourcePath);
    src.prepare("UPDATE observations SET created_at_epoch = 100000000000000000 WHERE id = 1").run();
    src.close();

    let report: ReturnType<typeof importFrom>;
    expect(() => {
      report = importFrom(db, sourcePath, {});
    }).not.toThrow();

    expect(report!.imported.observations).toBeGreaterThan(0);
    expect(report!.validation.ok).toBe(true);
    // The unusable timestamp is what was lost, not the observation.
    const row = db.prepare('SELECT occurred_at FROM memory_entries ORDER BY id LIMIT 1').get() as {
      occurred_at: string;
    };
    expect(Number.isNaN(Date.parse(row.occurred_at))).toBe(false);
  });
});
