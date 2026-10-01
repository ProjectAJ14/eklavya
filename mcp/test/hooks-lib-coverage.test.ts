import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig, type ResolvedConfig } from '../src/config.js';
import type { EvidenceIdentity } from '../src/memory/identity.js';
import { appendEvent, batchSession } from '../src/memory/store.js';
import { clearNudgeState, framingFor, NUDGE_KEY_PREFIX, openOrDiagnose, sessionId } from '../src/hooks/lib.js';
import { batchIfFull, record } from '../src/hooks/capture-lib.js';
import { flushAtSeam, memoryHealthLine, recallBlock, wrapUpAtSeam } from '../src/hooks/memory-lib.js';
import { noteEdit, recordBaseline, sessionChangedCode, treeFingerprint } from '../src/hooks/changes-lib.js';
import { isCommitCommand } from '../src/hooks/commit-lib.js';
import { cleanup, tempDbPath } from './helpers.js';

const PROJECT = '/tmp/demo-repo';

let dbFile = '';
let db: DB;
let home = '';
const saved = { home: process.env.EKLAVYA_HOME, db: process.env.EKLAVYA_DB, sid: process.env.EKLAVYA_SESSION_ID };

beforeEach(() => {
  dbFile = tempDbPath('eklavya-hooklib');
  db = openDb(dbFile);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-hooklib-home-'));
  process.env.EKLAVYA_HOME = home;
  delete process.env.EKLAVYA_SESSION_ID;
});

afterEach(() => {
  for (const [key, value] of [['EKLAVYA_HOME', saved.home], ['EKLAVYA_DB', saved.db], ['EKLAVYA_SESSION_ID', saved.sid]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (db.open) db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
});

/** A database whose every statement throws, as a handle closed under the hook would. */
function closedDb(): DB {
  const file = tempDbPath('eklavya-closed');
  const closed = openDb(file);
  closed.close();
  cleanup(file);
  return closed;
}

const identity = (sessionId = 's1'): EvidenceIdentity => ({ project: PROJECT, checkout: PROJECT, sessionId, agentId: null, host: 'claude-code' });

function resolved(over: (c: EklavyaConfig) => void = () => {}): ResolvedConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  over(config);
  return { config } as unknown as ResolvedConfig;
}

function pausedJob(errorClass: string | null, updatedAt?: string): void {
  const batch = Number(
    db.prepare("INSERT INTO memory_batches (project, session_id, reason) VALUES (?, 's1', 'manual')").run(PROJECT).lastInsertRowid,
  );
  db.prepare("INSERT INTO memory_jobs (batch_id, status, error_class) VALUES (?, 'paused', ?)").run(batch, errorClass);
  if (updatedAt !== undefined) db.prepare('UPDATE memory_jobs SET updated_at = ?').run(updatedAt);
}

function gitRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-hooklib-repo-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  return dir;
}

describe('hooks/lib', () => {
  it('diagnoses garbage as unreadable, and a database held by another writer as busy, not broken', () => {
    process.env.EKLAVYA_DB = path.join(home, 'garbage.db');
    fs.writeFileSync(process.env.EKLAVYA_DB, 'not a database at all, just text'.repeat(40));
    expect(openOrDiagnose()).toEqual({ db: null, problem: 'unreadable' });

    const locked = path.join(home, 'locked.db');
    const holder = new Database(locked);
    holder.pragma('journal_mode = DELETE');
    holder.exec('CREATE TABLE t (x)');
    holder.exec('BEGIN EXCLUSIVE');
    holder.exec('INSERT INTO t VALUES (1)');
    process.env.EKLAVYA_DB = locked;
    try {
      expect(openOrDiagnose()).toEqual({ db: null, problem: null });
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  }, 10_000);

  it('clears the nudge row, and swallows a database that will not answer', () => {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(`${NUDGE_KEY_PREFIX}s1`, 'x');
    clearNudgeState(db, 's1');
    expect(db.prepare('SELECT 1 FROM meta WHERE key = ?').get(`${NUDGE_KEY_PREFIX}s1`)).toBeUndefined();
    expect(() => clearNudgeState(closedDb(), 's1')).not.toThrow();
  });

  it('has no session id without env, input or a database, and none from a database that throws', () => {
    expect(sessionId({}, null)).toBeNull();
    expect(sessionId({ cwd: home }, closedDb())).toBeNull();
    process.env.EKLAVYA_SESSION_ID = 'shared';
    expect(sessionId({ session_id: 'host' }, null)).toBe('shared');
  });

  it('exits 0 for a body that returns nothing, and with its own code otherwise', () => {
    const lib = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'hooks', 'lib.js')).href;
    const exit = (body: string) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', `const { run } = await import(${JSON.stringify(lib)}); await run(${body});`], {
        input: '{}',
        env: { ...process.env, EKLAVYA_HOME: home, EKLAVYA_DB: path.join(home, 'none.db') },
      }).status;
    expect(exit('async () => {}')).toBe(0);
    expect(exit('async () => 3')).toBe(3);
  });

  it('frames every focus for both the checkpoint and the stop', () => {
    expect(framingFor('concept', null, 'stop')).toContain('ask the transferable version');
    expect(framingFor('concept', null, 'checkpoint')).toContain('general rule');
    expect(framingFor('learn', null, 'checkpoint')).toContain('Skip the question and say so.');
    expect(framingFor('learn', '', 'stop')).toContain('Ask what they want to learn');
    expect(framingFor('learn', 'OAuth', 'checkpoint')).toContain(`Focus is 'learn' on "OAuth": ask the next thing`);
    expect(framingFor('learn', 'OAuth', 'stop')).toContain('teach that topic in prerequisite order');
    expect(framingFor('project', null, 'checkpoint')).toContain('the file, the line, the decision.');
    expect(framingFor('project', null, 'stop')).toContain('ground every question in the diff');
  });
});

describe('hooks/capture-lib', () => {
  const event = { kind: 'tool_use' as const, tool: 'Bash', title: 'Bash', body: 'npm test', files: [] };

  it('reports a capture that threw as not recorded', () => {
    const broken = { config: { retrieval: { cross_project: false } } } as unknown as ResolvedConfig;
    expect(record(db, broken, identity(), event)).toBe(false);
  });

  it('closes a batch once the session reaches batch_max_events, and never throws', () => {
    const config = resolved((c) => {
      c.memory.batch_max_events = 2;
    });
    for (let i = 0; i < 2; i++) {
      appendEvent(db, { eventUid: `e${i}`, project: PROJECT, sessionId: 's1', kind: 'tool_use', body: `step ${i}` });
    }
    batchIfFull(db, config, identity());
    const row = db.prepare("SELECT reason FROM memory_batches WHERE session_id = 's1'").get() as { reason: string };
    expect(row.reason).toBe('size');
    expect(() => batchIfFull(closedDb(), config, identity())).not.toThrow();
  });
});

describe('hooks/memory-lib', () => {
  it('survives a seam on a database that throws, with and without an observer', async () => {
    const retain = (c: EklavyaConfig) => {
      c.memory.retention_days = 30;
    };
    await expect(flushAtSeam(closedDb(), resolved(retain), identity(), { all: true })).resolves.toBeUndefined();
    const observer = resolved((c) => {
      retain(c);
      c.providers.observer = { kind: 'claude-cli' } as unknown as EklavyaConfig['providers']['observer'];
    });
    await expect(flushAtSeam(closedDb(), observer, identity())).resolves.toBeUndefined();
  });

  it('leaves the worker slot alone when the seam itself runs inside the observer', async () => {
    appendEvent(db, { eventUid: 'e1', project: PROJECT, sessionId: 's1', kind: 'tool_use', body: 'step' });
    batchSession(db, { project: PROJECT, sessionId: 's1', reason: 'manual' });
    const observer = resolved((c) => {
      c.providers.observer = { kind: 'claude-cli' } as unknown as EklavyaConfig['providers']['observer'];
    });
    process.env.EKLAVYA_INTERNAL_OBSERVER = '1';
    try {
      await flushAtSeam(db, observer, identity());
    } finally {
      delete process.env.EKLAVYA_INTERNAL_OBSERVER;
    }
    expect(db.prepare("SELECT 1 FROM meta WHERE key = 'memory_worker'").get()).toBeUndefined();
  });

  it('names an unknown pause cause generically and keeps an unparseable date as written', () => {
    pausedJob('provider', 'not-a-date-at-all');
    expect(memoryHealthLine(db)).toBe('Memory paused · provider failing since not-a-date · local summaries meanwhile · fix it, then: eklavya memory process');
  });

  it('omits the since clause when the pause has no stamp, and names a null cause generically', () => {
    pausedJob(null, '');
    expect(memoryHealthLine(db)).toBe('Memory paused · provider failing · local summaries meanwhile · fix it, then: eklavya memory process');
  });

  it('counts several waiting jobs in the plural, and says nothing from a database that throws', () => {
    for (const sid of ['s1', 's2']) {
      appendEvent(db, { eventUid: sid, project: PROJECT, sessionId: sid, kind: 'tool_use', body: sid });
      batchSession(db, { project: PROJECT, sessionId: sid, reason: 'manual' });
    }
    expect(memoryHealthLine(db, Date.now() + 7 * 3_600_000)).toMatch(/^Memory behind · 2 jobs waiting, oldest [67]h/);
    expect(memoryHealthLine(closedDb())).toBeNull();
  });

  it('recalls nothing with memory off, or from a database that throws', () => {
    const off = resolved((c) => {
      c.memory.enabled = false;
    });
    expect(recallBlock(db, off, identity(), 'session_start')).toBeNull();
    expect(recallBlock(closedDb(), resolved(), identity(), 'session_start')).toBeNull();
  });

  it('alerts a pause with no recorded cause as unknown', async () => {
    const sink = path.join(home, 'sink.jsonl');
    pausedJob(null);
    const config = resolved((c) => {
      c.notifications.enabled = true;
      c.notifications.sinks = [{ kind: 'file', target: sink }] as EklavyaConfig['notifications']['sinks'];
    });
    await wrapUpAtSeam(db, config, identity());
    const sent = fs.readFileSync(sink, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> });
    expect(sent.find((n) => n.kind === 'queue_paused')?.data.error_class).toBe('unknown');
  });

  it('wraps up without throwing on a database that throws, notifications on or off', async () => {
    await expect(wrapUpAtSeam(closedDb(), resolved(), identity())).resolves.toBeUndefined();
    const on = resolved((c) => {
      c.notifications.enabled = true;
    });
    await expect(wrapUpAtSeam(closedDb(), on, identity())).resolves.toBeUndefined();
  });
});

describe('hooks/changes-lib', () => {
  let repo = '';
  beforeEach(() => {
    repo = gitRepo();
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('has no fingerprint when git cannot be run there or cannot read the index', () => {
    expect(treeFingerprint(`${repo}\0bad`)).toBeNull();
    fs.writeFileSync(path.join(repo, '.git', 'index'), 'corrupt index');
    expect(treeFingerprint(repo)).toBeNull();
  });

  it('treats a database that will not answer as changed, and never throws recording or marking', () => {
    const broken = closedDb();
    expect(() => recordBaseline(broken, 's1', repo, 'fp')).not.toThrow();
    expect(sessionChangedCode(broken, 's1', repo)).toBe(true);
    expect(() => noteEdit(broken, 's1', path.join(repo, 'a.ts'))).not.toThrow();
  });

  it('answers changed when git itself is missing, since unknown errs towards asking', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-nogit-'));
    const pathBefore = process.env.PATH;
    process.env.PATH = path.join(plain, 'nothing-here');
    try {
      expect(sessionChangedCode(db, 's1', plain)).toBe(true);
    } finally {
      process.env.PATH = pathBefore;
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('hooks/commit-lib lexer edges', () => {
  it.each([
    ['a trailing comment with no newline', 'git commit -m x # done', true],
    ['a comment-only line', '# git commit', false],
    ['a backslash-escaped letter', 'g\\it commit -m x', true],
    ['an unterminated single quote', "git commit -m 'oops", true],
    ['an escape inside double quotes', '"gi\\t" commit -m x', true],
    ['a backtick inside double quotes', 'echo "now `git commit -m x`"', true],
    ['a here-document delimiter after a tab', 'cat <<\tEOF\ngit commit\nEOF\ngit status', false],
    ['a keyword with no command after it', 'if true; then', false],
    ['a comment ended by a newline', 'echo x # note\ngit commit -m x', true],
    ['a trailing backslash', 'git commit \\', true],
    ['a trailing backslash in an open double quote', 'git commit -m "x\\', true],
  ])('%s', (_name, command, expected) => {
    expect(isCommitCommand(command)).toBe(expected);
  });
});
