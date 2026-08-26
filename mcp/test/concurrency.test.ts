import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../src/db.js';
import { retryOnBusy, MAX_BUSY_ATTEMPTS } from '../src/concurrency.js';
import { tempDbPath, cleanup } from './helpers.js';

const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDb = path.join(mcpRoot, 'dist', 'db.js');
const distStore = path.join(mcpRoot, 'dist', 'store.js');

let dbFile = '';
let db: DB;

beforeEach(() => {
  dbFile = tempDbPath('concurrency');
  db = openDb(dbFile);
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
});

describe('retryOnBusy', () => {
  it('passes through a successful call', () => {
    expect(retryOnBusy(() => 42)).toBe(42);
  });

  it('retries a busy transaction and eventually succeeds', () => {
    let calls = 0;
    const result = retryOnBusy(() => {
      calls += 1;
      if (calls < 3) {
        const err = new Error('database is locked') as Error & { code: string };
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return 'done';
    });
    expect(result).toBe('done');
    expect(calls).toBe(3);
  });

  it('rethrows anything that is not a lock, immediately', () => {
    let calls = 0;
    expect(() =>
      retryOnBusy(() => {
        calls += 1;
        throw new Error('constraint failed');
      }),
    ).toThrow(/constraint failed/);
    expect(calls).toBe(1);
  });

  it('gives up rather than spinning forever', () => {
    let calls = 0;
    expect(() =>
      retryOnBusy(() => {
        calls += 1;
        const err = new Error('locked') as Error & { code: string };
        err.code = 'SQLITE_BUSY';
        throw err;
      }, 3),
    ).toThrow();
    expect(calls).toBe(3);
    expect(MAX_BUSY_ATTEMPTS).toBeGreaterThan(1);
  });
});

describe('two sessions sharing one database', () => {
  /** A separate OS process writing attempts, as a second Claude Code session would. */
  function writerScript(session: string, count: number): string {
    return `
      import { openDb } from ${JSON.stringify(distDb)};
      import { conceptBySlug, gradeConcept, logSessionConcept } from ${JSON.stringify(distStore)};
      const db = openDb(process.env.EKLAVYA_DB);
      const slugs = ['csrf', 'jwt-structure', 'pkce', 'rbac', 'session-auth'];
      for (let i = 0; i < ${count}; i += 1) {
        const slug = slugs[i % slugs.length];
        const c = conceptBySlug(db, slug);
        logSessionConcept(db, ${JSON.stringify(session)}, c.id, 'concurrent write');
        gradeConcept(db, {
          conceptId: c.id,
          sessionId: ${JSON.stringify(session)},
          question: 'q' + i,
          answer: 'a',
          grade: 4,
          difficulty: 2,
          feedback: null,
          now: new Date(),
        });
      }
      db.close();
    `;
  }

  function runWriters(sessions: string[], count: number): Promise<number[]> {
    return Promise.all(
      sessions.map(
        (session) =>
          new Promise<number>((resolve) => {
            const proc = spawn(process.execPath, ['--input-type=module', '-e', writerScript(session, count)], {
              env: { ...process.env, EKLAVYA_DB: dbFile },
              stdio: ['ignore', 'ignore', 'pipe'],
            });
            let stderr = '';
            proc.stderr.on('data', (c) => (stderr += String(c)));
            proc.on('exit', (code) => {
              if (code !== 0) throw new Error(`writer ${session} failed: ${stderr}`);
              resolve(code ?? -1);
            });
          }),
      ),
    );
  }

  it('is built before the concurrency test runs', () => {
    expect(fs.existsSync(distStore), `missing ${distStore} — run npm run build`).toBe(true);
  });

  it('loses no writes when several sessions write at once', async () => {
    const sessions = ['pane-a', 'pane-b', 'pane-c'];
    const perSession = 25;

    await runWriters(sessions, perSession);

    const total = (db.prepare('SELECT count(*) n FROM attempts').get() as { n: number }).n;
    expect(total).toBe(sessions.length * perSession);

    for (const session of sessions) {
      const n = (db.prepare('SELECT count(*) n FROM attempts WHERE session_id = ?').get(session) as { n: number }).n;
      expect(n, `${session} lost writes`).toBe(perSession);
    }
  }, 30_000);

  it('leaves the database consistent afterwards', async () => {
    await runWriters(['pane-a', 'pane-b'], 20);

    const integrity = db.pragma('integrity_check', { simple: true });
    expect(integrity).toBe('ok');

    const orphans = (
      db
        .prepare('SELECT count(*) n FROM attempts a LEFT JOIN concepts c ON c.id = a.concept_id WHERE c.id IS NULL')
        .get() as { n: number }
    ).n;
    expect(orphans).toBe(0);
  }, 30_000);

  it('lets a reader through while writers are working — the git hook must never stall', async () => {
    const writers = runWriters(['pane-a', 'pane-b'], 25);

    let reads = 0;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const res = spawnSync('sqlite3', ['-noheader', '-batch', '-cmd', '.timeout 2000', dbFile, 'SELECT count(*) FROM gates;'], {
        encoding: 'utf8',
      });
      expect(res.status, `read failed: ${res.stderr}`).toBe(0);
      reads += 1;
    }

    await writers;
    expect(reads).toBeGreaterThan(0);
  }, 30_000);
});
