import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations, schemaVersion } from '../src/migrate.js';
import { migrationsDir } from '../src/paths.js';

/**
 * Several Claude Code sessions start at once after an upgrade -- the MCP server
 * and every hook call `openDb()`, and each one migrates. Before the fix each
 * process read the schema version outside any lock, so all of them tried to
 * apply the same `ALTER TABLE ... ADD COLUMN`, and every one but the first died
 * on "duplicate column name" -- which took the MCP server down with exit 1.
 *
 * These run real OS processes against one file, because the bug lives in the
 * gap between two connections and one connection cannot reproduce it.
 */

const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrateTs = path.join(mcpRoot, 'src', 'migrate.ts');
const dbTs = path.join(mcpRoot, 'src', 'db.ts');

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tempDir(label: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `eklavya-${label}-`));
  dirs.push(d);
  return d;
}

/** A database genuinely at schema `version`: built from only the first `version` files. */
function dbAtVersion(version: number): string {
  const oldDir = tempDir('old-migrations');
  for (const f of fs.readdirSync(migrationsDir()).filter((f) => f.endsWith('.sql'))) {
    if (Number(f.slice(0, 3)) <= version) fs.copyFileSync(path.join(migrationsDir(), f), path.join(oldDir, f));
  }
  const file = path.join(tempDir('race-db'), 'knowledge.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  runMigrations(db, oldDir);
  expect(schemaVersion(db)).toBe(version);
  db.close();
  return file;
}

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `body` as an ES module under tsx, so the children exercise src/ rather than a stale dist/. */
function runChild(body: string, env: Record<string, string> = {}): Promise<ChildResult> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', body], {
      cwd: mcpRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => (stdout += String(c)));
    proc.stderr.on('data', (c) => (stderr += String(c)));
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Every child waits for the same wall-clock instant before migrating, so they
 * collide instead of running one after another as they finish booting.
 */
function racer(file: string, startAt: number, dir?: string): string {
  return `
    import Database from 'better-sqlite3';
    import { runMigrations } from ${JSON.stringify(migrateTs)};
    const db = new Database(${JSON.stringify(file)});
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    while (Date.now() < ${startAt}) {}
    const applied = runMigrations(db${dir ? `, ${JSON.stringify(dir)}` : ''});
    process.stdout.write(JSON.stringify(applied));
    db.close();
  `;
}

function columns(file: string, table: string): string[] {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  } finally {
    db.close();
  }
}

const RACERS = 6;

describe('concurrent migrations', () => {
  it('every process survives an upgrade that adds columns, and each migration runs exactly once', async () => {
    // 012 -> 014: 013 is two ALTER TABLE ADD COLUMNs, the shape that is not
    // idempotent and that crashed every loser of the race.
    const file = dbAtVersion(12);
    const startAt = Date.now() + 1500;
    const results = await Promise.all(Array.from({ length: RACERS }, () => runChild(racer(file, startAt))));

    for (const r of results) expect(r.code, r.stderr).toBe(0);

    // Between them the racers applied each pending file once, and no file twice.
    const applied = results.flatMap((r) => JSON.parse(r.stdout) as string[]).sort();
    expect(applied).toEqual(['013_batch_provenance.sql', '014_batch_events_index.sql']);

    const db = new Database(file, { readonly: true });
    expect(schemaVersion(db)).toBe(14);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();
    expect(columns(file, 'memory_batches')).toEqual(expect.arrayContaining(['summarizer', 'config_digest']));
  }, 20_000);

  it('every process survives a fresh install where all of them open the file first', async () => {
    // The first-run shape: no file, no `meta`, and several sessions launched
    // together. Through `openDb`, so the pragmas, seed and packs race too.
    const home = tempDir('race-home');
    const file = path.join(home, 'knowledge.db');
    const startAt = Date.now() + 1500;
    const body = `
      import { openDb } from ${JSON.stringify(dbTs)};
      while (Date.now() < ${startAt}) {}
      const db = openDb(${JSON.stringify(file)});
      process.stdout.write(String(db.prepare('SELECT count(*) n FROM concepts').get().n));
      db.close();
    `;
    const results = await Promise.all(
      Array.from({ length: RACERS }, () => runChild(body, { EKLAVYA_HOME: home })),
    );
    for (const r of results) expect(r.code, r.stderr).toBe(0);

    const db = new Database(file, { readonly: true });
    const latest = fs.readdirSync(migrationsDir()).filter((f) => f.endsWith('.sql')).length;
    expect(schemaVersion(db)).toBe(latest);
    const seeded = (db.prepare('SELECT count(*) n FROM concepts').get() as { n: number }).n;
    expect(seeded).toBeGreaterThan(0);
    // Every racer saw the same, complete graph -- none raced ahead of the seed.
    for (const r of results) expect(Number(r.stdout)).toBe(seeded);
    db.close();
  }, 20_000);

  it('waits out a writer that holds the lock longer than the caller\'s busy_timeout', async () => {
    // A migration can be slow on a big database -- 014 builds an index over
    // every captured event. A process queued behind it must wait for it, not
    // fail with SQLITE_BUSY the moment its own short timeout lapses, or the
    // slow upgrade crashes every other session instead of just delaying it.
    const file = dbAtVersion(12);
    const lockFile = path.join(tempDir('lock'), 'held');
    const holder = runChild(`
      import fs from 'node:fs';
      import Database from 'better-sqlite3';
      const db = new Database(${JSON.stringify(file)});
      db.exec('BEGIN IMMEDIATE');
      fs.writeFileSync(${JSON.stringify(lockFile)}, '1');
      const until = Date.now() + 1500;
      while (Date.now() < until) {}
      db.exec('COMMIT');
      db.close();
    `);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(lockFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(lockFile)).toBe(true);

    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 100');
    try {
      expect(runMigrations(db)).toEqual(['013_batch_provenance.sql', '014_batch_events_index.sql']);
      // The caller's own timeout is put back: only migrating waits longer.
      expect(Number(db.pragma('busy_timeout', { simple: true }))).toBe(100);
    } finally {
      db.close();
    }
    expect((await holder).code).toBe(0);
  }, 20_000);

  it('takes no write lock when nothing is pending, so an up-to-date open never queues', async () => {
    // Every hook opens the database. If an up-to-date open still took a write
    // lock to check the version, one long write anywhere would stall them all.
    const file = dbAtVersion(14);
    const lockFile = path.join(tempDir('lock'), 'held');
    const holder = runChild(`
      import fs from 'node:fs';
      import Database from 'better-sqlite3';
      const db = new Database(${JSON.stringify(file)});
      db.exec('BEGIN IMMEDIATE');
      fs.writeFileSync(${JSON.stringify(lockFile)}, '1');
      const until = Date.now() + 1500;
      while (Date.now() < until) {}
      db.exec('COMMIT');
      db.close();
    `);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(lockFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

    const db = new Database(file);
    db.pragma('busy_timeout = 0');
    try {
      const started = Date.now();
      expect(runMigrations(db)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      db.close();
    }
    expect((await holder).code).toBe(0);
  }, 20_000);
});
