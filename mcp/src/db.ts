import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dbPath } from './paths.js';
import { runMigrations } from './migrate.js';
import { seedIfNeeded } from './seed.js';

export type DB = Database.Database;

/**
 * Opens (creating if needed) the knowledge DB with the pragmas the design
 * depends on: WAL so several Claude Code sessions and the git hook can share
 * the file (PRD §8 "Concurrency"), and foreign keys so the graph stays honest.
 */
export function openDb(file: string = dbPath()): DB {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Concurrent writers (two sessions, or a session plus the pre-commit hook)
  // should wait briefly rather than fail with SQLITE_BUSY.
  db.pragma('busy_timeout = 5000');

  runMigrations(db);
  seedIfNeeded(db);

  return db;
}
