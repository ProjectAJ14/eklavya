import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { migrationsDir } from './paths.js';

const VERSION_KEY = 'schema_version';

function readVersion(db: Database): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(VERSION_KEY) as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

function writeVersion(db: Database, version: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(VERSION_KEY, String(version));
}

/**
 * How long a process waits for another one's migration, whatever the caller's
 * own `busy_timeout` says. A migration can be slow on a big database -- 014
 * builds an index over every captured event -- and a session queued behind it
 * that gives up after the usual five seconds crashes instead of starting late.
 */
export const MIGRATION_BUSY_TIMEOUT_MS = 60_000;

function hasMeta(db: Database): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== undefined;
}

/**
 * Applies numbered SQL migrations in order, recording progress in `meta`.
 * Idempotent: re-running applies nothing. Returns the filenames applied.
 *
 * Safe when several processes migrate one file at once -- every session and
 * every hook opens the database, so after an upgrade they all do. Each
 * migration runs in a `BEGIN IMMEDIATE` transaction that re-reads the version
 * once it holds the write lock, so a process that lost the race skips what the
 * winner applied instead of re-running it. Reading the version outside the
 * lock and trusting it is what let six processes all try the same
 * `ALTER TABLE ... ADD COLUMN`, and every one but the first die on "duplicate
 * column name". IMMEDIATE rather than the default DEFERRED because a deferred
 * transaction reads first and upgrades later, and in WAL mode that upgrade
 * fails at once (SQLITE_BUSY_SNAPSHOT) instead of waiting.
 *
 * An up-to-date database takes no write lock at all: the version is read
 * unlocked first, and only a pending migration queues for the lock.
 */
export function runMigrations(db: Database, dir = migrationsDir()): string[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const n = Number(file.slice(0, 3));
      if (!Number.isFinite(n) || n === 0) {
        throw new Error(`Migration filename must start with a number: ${file}`);
      }
      return { file, n };
    });

  // The fast path: nothing pending, nothing locked.
  const bootstrapped = hasMeta(db);
  const known = bootstrapped ? readVersion(db) : 0;
  if (bootstrapped && files.every((f) => f.n <= known)) return [];

  const callerTimeout = Number(db.pragma('busy_timeout', { simple: true }));
  db.pragma(`busy_timeout = ${Math.max(callerTimeout, MIGRATION_BUSY_TIMEOUT_MS)}`);
  try {
    // Bootstrap `meta` itself under the same lock as everything else.
    db.transaction(() => {
      db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    }).immediate();

    const applied: string[] = [];
    for (const { file, n } of files) {
      if (n <= known) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const ran = db.transaction(() => {
        // Re-read under the lock: another process may have applied it while we
        // were queued, and running an ALTER TABLE twice is an error, not a no-op.
        if (readVersion(db) >= n) return false;
        db.exec(sql);
        writeVersion(db, n);
        return true;
      }).immediate();
      if (ran) applied.push(file);
    }
    return applied;
  } finally {
    db.pragma(`busy_timeout = ${callerTimeout}`);
  }
}

export function schemaVersion(db: Database): number {
  return readVersion(db);
}
