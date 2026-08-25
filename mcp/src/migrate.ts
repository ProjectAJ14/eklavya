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
 * Applies numbered SQL migrations in order, recording progress in `meta`.
 * Idempotent: re-running applies nothing. Returns the filenames applied.
 */
export function runMigrations(db: Database, dir = migrationsDir()): string[] {
  // Bootstrap `meta` itself so the version read below has somewhere to look.
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

  const current = readVersion(db);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const n = Number(file.slice(0, 3));
    if (!Number.isFinite(n) || n === 0) {
      throw new Error(`Migration filename must start with a number: ${file}`);
    }
    if (n <= current) continue;

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      writeVersion(db, n);
    })();
    applied.push(file);
  }
  return applied;
}

export function schemaVersion(db: Database): number {
  return readVersion(db);
}
