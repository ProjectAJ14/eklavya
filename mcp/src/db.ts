import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dbPath, eklavyaHome, ensureEklavyaHome, makePrivate } from './paths.js';
import { runMigrations } from './migrate.js';
import { retryOnBusy } from './concurrency.js';
import { seedIfNeeded } from './seed.js';
import { mergeWorktreeProjects } from './store.js';
import { applyPacksIfNeeded } from './packs.js';

export type DB = Database.Database;

/**
 * Opens (creating if needed) the knowledge DB with the pragmas the design
 * depends on: WAL so several Claude Code sessions and the git hook can share
 * the file, and foreign keys so the graph stays honest.
 */
export function openDb(file: string = dbPath()): DB {
  const onDisk = file !== ':memory:' && file !== '';
  if (onDisk) {
    // Private from the first byte: see `makePrivate`. A directory Eklavya did
    // not create (an `EKLAVYA_DB` pointed somewhere shared) keeps its mode;
    // the database file itself is always ours.
    if (path.resolve(path.dirname(file)) === path.resolve(eklavyaHome())) ensureEklavyaHome();
    else fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      // Created 0600 before SQLite opens it; SQLite gives the -wal and -shm
      // files the database's own permission bits.
      fs.closeSync(fs.openSync(file, 'a', 0o600));
    } catch {
      // Let SQLite report whatever is wrong with the path.
    }
  }

  const db = new Database(file);
  if (onDisk) for (const f of [file, `${file}-wal`, `${file}-shm`]) makePrivate(f, 0o600);
  // Concurrent writers (two sessions, or a session plus the pre-commit hook)
  // should wait briefly rather than fail with SQLITE_BUSY. First, before any
  // other pragma: switching a fresh file to WAL takes a lock too, and several
  // sessions launched together on a new install all make that switch at once.
  db.pragma('busy_timeout = 5000');
  // Retried as well, because that switch is the one lock the timeout cannot
  // cover: two connections both holding a shared lock and both asking for the
  // exclusive one is a deadlock, and SQLite breaks it by failing one at once.
  // The retry then finds the file already in WAL and has nothing to change.
  // 20 attempts back off 10ms, 20ms … 200ms: about 2s in all, inside a hook's
  // 10s budget even if every attempt also waits out part of busy_timeout.
  retryOnBusy(() => db.pragma('journal_mode = WAL'), 20);
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  // Before anything reads a project key, so old worktree rows fold into the
  // checkout they branched from rather than lingering as phantom projects.
  mergeWorktreeProjects(db);
  seedIfNeeded(db);
  // After the seed, because packs are merged over it. A re-seed undoes whatever
  // a pack had overridden, and `applyPacksIfNeeded` knows that: SEED_VERSION is
  // part of the fingerprint it compares.
  applyPacksIfNeeded(db);

  return db;
}
