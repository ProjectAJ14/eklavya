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
const LATEST_SCHEMA_VERSION = 5;

const EXPECTED_TABLES = [
  'attempts',
  'concepts',
  'edges',
  'gates',
  'mastery',
  'meta',
  'session_concepts',
  'stop_markers',
];

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
      ]);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(tableNames(db)).toEqual(EXPECTED_TABLES);

      // And the upgraded table really has the new column.
      const cols = (db.prepare('PRAGMA table_info(gates)').all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain('repo');
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
