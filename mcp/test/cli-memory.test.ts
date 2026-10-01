import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { tempDbPath, cleanup } from './helpers.js';
import { buildSource } from './claude-mem-fixture.js';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { appendEvent, deleteEntry, insertEntry } from '../src/memory/store.js';
import { pull, push } from '../src/memory/sync.js';
import { stopMessage, workerLine } from '../src/cli-memory.js';
import { EXPORT_SCHEMA_VERSION } from '../src/memory/import.js';

/**
 * `eklavya memory …` beyond the dispatch and flag parsing `cli.test.ts` pins:
 * every branch of what each subcommand prints, run through the real CLI.
 */
const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(mcpRoot, 'dist', 'cli.js');

let dbFile = '';
let home = '';
let userHome = '';
let repo = '';
let claudeDir = '';
let runtimeDir = '';
const children: ChildProcess[] = [];

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    EKLAVYA_DB: dbFile,
    EKLAVYA_HOME: home,
    EKLAVYA_RUNTIME: runtimeDir,
    CLAUDE_CONFIG_DIR: claudeDir,
    HOME: userHome,
    USERPROFILE: userHome,
    ...extra,
  };
}

function eklavya(args: string[], cwd = repo, extra: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env: env(extra) });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * The same, without blocking this process: a stand-in worker this process
 * spawned is only reaped (and seen to be gone) while its event loop runs.
 */
function eklavyaAsync(args: string[]): Promise<{ status: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: repo, env: env() });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.on('close', (code) => resolve({ status: code ?? -1, stdout }));
  });
}

function withDb<T>(fn: (db: DB) => T): T {
  const db = openDb(dbFile);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function globalConfig(value: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(value));
}

/** A process that stands in for a worker: alive until signalled. */
function sacrificial(opts: { detached?: boolean } = {}): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: opts.detached ?? false,
  });
  children.push(child);
  return child;
}

function holder(value: Record<string, unknown>): void {
  withDb((db) =>
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('memory_worker', ?)").run(JSON.stringify(value)),
  );
}

const future = () => new Date(Date.now() + 120_000).toISOString();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-mem-home-'));
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-mem-user-'));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-mem-repo-')));
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-mem-claude-'));
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-mem-rt-'));
  fs.mkdirSync(path.join(repo, '.git'));
  dbFile = tempDbPath('cli-mem');
  openDb(dbFile).close();
});

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  cleanup(dbFile);
  for (const dir of [home, userHome, repo, claudeDir, runtimeDir]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workerLine', () => {
  let db: DB;
  let file: string;
  beforeEach(() => {
    file = tempDbPath('worker-line');
    db = openDb(file);
  });
  afterEach(() => {
    db.close();
    cleanup(file);
  });

  const set = (value: Record<string, unknown>) =>
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('memory_worker', ?)").run(JSON.stringify(value));

  it('says there is none, or that one is starting', () => {
    expect(workerLine(db)).toBe('none running');
    set({ token: 't', pid: null, child: null, job: null, until: future(), heartbeat: new Date().toISOString() });
    expect(workerLine(db)).toMatch(/^starting · heartbeat \d+s ago$/);
  });

  it('names every part of a running worker', () => {
    const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    set({
      token: 't', pid: process.pid, child: 4242, job: 7, jobStarted: ago(90), started: ago(125),
      generation: 2, until: future(), heartbeat: null,
    });
    expect(workerLine(db)).toBe(
      `pid ${process.pid} · up 2m 05s · hand-off 2 · claude pid 4242 · job #7 for 1m 30s · heartbeat ? ago`,
    );
  });

  it('says when a worker stopped renewing and is being stopped', () => {
    set({ token: 't', pid: process.pid, child: null, job: null, until: new Date(Date.now() - 1000).toISOString(), heartbeat: new Date(Date.now() - 5000).toISOString() });
    expect(workerLine(db)).toMatch(/^pid \d+ · STALE — no heartbeat for 5s, being stopped$/);
  });
});

describe('memory status', () => {
  it('reports memory off, quarantined and paused jobs, a provider and confirmed receipts', () => {
    globalConfig({ memory: { enabled: false }, providers: { observer: { kind: 'anthropic', model: 'haiku' } } });
    withDb((db) => {
      const batch = () => db.prepare("INSERT INTO memory_batches (project, session_id, reason) VALUES (?, 's1', 'manual')").run(repo).lastInsertRowid;
      db.prepare("INSERT INTO memory_jobs (batch_id, status) VALUES (?, 'quarantined')").run(batch());
      db.prepare("INSERT INTO memory_jobs (batch_id, status, error_class) VALUES (?, 'paused', 'auth')").run(batch());
      db.prepare("INSERT INTO memory_jobs (batch_id, status) VALUES (?, 'paused')").run(batch());
      db.prepare("INSERT INTO context_receipts (receipt_uid, project, scope, method, base_tokens, delivered_tokens, delivery) VALUES ('r1', ?, 'search', 'm', 1000, 100, 'confirmed')").run(repo);
    });
    const res = eklavya(['memory', 'status']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^capture:\s+off \(memory\.enabled is false\)$/m);
    expect(res.stdout).toMatch(/· 1 quarantined$/m);
    expect(res.stdout).toMatch(/^paused:.*1 on auth \(claude is not logged in\), since .*1 on unclassified, since /m);
    expect(res.stdout).toMatch(/^provider:\s+anthropic:haiku \(via claude -p, on your subscription\)$/m);
    expect(res.stdout).toMatch(/^receipts:\s+1 \(1 confirmed\) · base 1000 → delivered 100 tokens$/m);
  });

  it('counts imported history here, and names what no checkout matches', () => {
    withDb((db) => {
      insertEntry(db, { project: repo, title: 'here', importSource: 'claude-mem' });
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) insertEntry(db, { project: name, title: name, importSource: 'claude-mem' });
    });
    const res = eklavya(['memory', 'status']);
    expect(res.stdout).toMatch(/^imported:\s+1 here from Claude Mem$/m);
    expect(res.stdout).toMatch(/^unplaced:\s+6 under 6 name\(s\) no checkout matches — a, b, c, d, e, …$/m);
  });

  it('counts imported history elsewhere as zero here', () => {
    withDb((db) => insertEntry(db, { project: '/somewhere/else', title: 'x', importSource: 'claude-mem' }));
    const res = eklavya(['memory', 'status']);
    expect(res.stdout).toMatch(/^imported:\s+0 here from Claude Mem$/m);
    expect(res.stdout).not.toMatch(/unplaced/);
    withDb((db) => insertEntry(db, { project: 'solo', title: 'y', importSource: 'claude-mem' }));
    expect(eklavya(['memory', 'status']).stdout).toMatch(/^unplaced:\s+1 under 1 name\(s\) no checkout matches — solo$/m);
  });
});

describe('memory search and show', () => {
  it('names where an imported hit came from', () => {
    withDb((db) => insertEntry(db, { project: repo, title: 'Rotation decision', type: 'decision', importSource: 'claude-mem' }));
    const res = eklavya(['memory', 'search', 'rotation', '--mode', 'keyword']);
    expect(res.stdout).toMatch(/decision · score [\d.]+ · \w+ · imported from claude-mem/);
  });

  it('refuses a mode it cannot run', () => {
    const res = eklavya(['memory', 'search', 'x', '--mode', 'fuzzy']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/--mode must be keyword, semantic or hybrid/);
  });

  it('shows every field an entry has, and its evidence', () => {
    const id = withDb((db) => {
      const ev = appendEvent(db, { eventUid: 'e1', project: repo, sessionId: 's1', kind: 'tool', tool: 'Edit', body: 'changed   the\nhandler' }).id;
      const ev2 = appendEvent(db, { eventUid: 'e2', project: repo, sessionId: 's1', kind: 'prompt', body: 'why' }).id;
      const entry = insertEntry(db, {
        project: repo, title: 'Full entry', type: 'bugfix', narrative: 'Because.', facts: ['one fact'],
        files: ['src/a.ts'], tags: ['Auth'], importSource: 'claude-mem', eventIds: [ev, ev2],
      });
      db.prepare('UPDATE memory_entries SET superseded_by = ? WHERE id = ?').run(entry, entry);
      return entry;
    });
    const res = eklavya(['memory', 'show', String(id)]);
    expect(res.status).toBe(0);
    for (const line of [
      /^kind:\s+observation \/ bugfix$/m, /^imported:\s+from claude-mem/m, /^superseded by #\d+$/m,
      /^tags:\s+auth$/m, /^files:\s+src\/a\.ts$/m, /^Because\.$/m, /^ {2}- one fact$/m,
      /^Evidence \(2\):$/m, /tool\/Edit {2}changed the handler$/m, /prompt {2}why$/m,
    ]) expect(res.stdout).toMatch(line);
  });

  it('says so when an entry has no narrative, and when the id names nothing', () => {
    const id = withDb((db) => insertEntry(db, { project: repo, title: 'Bare' }));
    expect(eklavya(['memory', 'show', String(id)]).stdout).toMatch(/^\(no narrative\)$/m);
    const res = eklavya(['memory', 'show', '999']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/No memory entry #999\./);
  });
});

describe('memory process', () => {
  it('leaves the queue to a worker that holds the slot, naming it', () => {
    const w = sacrificial();
    holder({ token: 't', pid: w.pid, child: null, job: null, until: future(), heartbeat: new Date().toISOString() });
    const res = eklavya(['memory', 'process']);
    expect(res.stdout).toBe(`another memory worker is running (pid ${w.pid}) — its queue is this queue, so nothing to do.\n`);
    // Background runs say nothing.
    expect(eklavya(['memory', 'process', '--no-resume']).stdout).toBe('');
  });

  it('does nothing with a hand-over token that no longer holds the slot', () => {
    const res = eklavya(['memory', 'process', '--worker-token', 'stale-token']);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('another memory worker is running — its queue is this queue, so nothing to do.\n');
  });

  it('adopts a slot handed to it', () => {
    holder({ token: 'handed', pid: null, child: null, job: null, until: future(), heartbeat: new Date().toISOString() });
    expect(eklavya(['memory', 'process', '--worker-token', 'handed']).stdout).toBe('processed 0 · entries 0 · failed 0 · skipped 0\n');
  });

  it('leaves a database it cannot reserve in alone', () => {
    withDb((db) => db.exec("CREATE TRIGGER no_worker BEFORE INSERT ON meta WHEN NEW.key = 'memory_worker' BEGIN SELECT RAISE(ABORT, 'locked'); END"));
    const res = eklavya(['memory', 'process']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^another memory worker is running/);
  });

  it('hands the rest of the queue to a successor when a provider is set', async () => {
    globalConfig({ providers: { observer: { kind: 'anthropic', model: 'haiku' } } });
    withDb((db) => {
      for (let i = 0; i < 2; i++) {
        const b = db.prepare("INSERT INTO memory_batches (project, session_id, reason) VALUES (?, 's1', 'manual')").run(repo).lastInsertRowid;
        db.prepare("INSERT INTO memory_jobs (batch_id, status) VALUES (?, 'pending')").run(b);
      }
    });
    const res = eklavya(['memory', 'process', '--max', '1']);
    expect(res.stdout).toBe('processed 0 · entries 0 · failed 0 · skipped 1 · more queued, continuing in the background\n');
    // The successor drains the rest and gives the slot back.
    for (let i = 0; i < 100; i++) {
      const left = withDb((db) => db.prepare("SELECT COUNT(*) n FROM memory_jobs WHERE status <> 'done'").get() as { n: number });
      const slot = withDb((db) => db.prepare("SELECT 1 FROM meta WHERE key = 'memory_worker'").get());
      if (!left.n && !slot) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(withDb((db) => db.prepare("SELECT COUNT(*) n FROM memory_jobs WHERE status = 'done'").get())).toEqual({ n: 2 });
  });
});

describe('memory process, signalled', () => {
  it.skipIf(process.platform === 'win32')('hands the job back when stopped mid-call, and exits cleanly', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-mem-bin-'));
    const mark = path.join(bin, 'started');
    try {
      fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho up > "${mark}"\nexec sleep 5\n`, { mode: 0o755 });
      globalConfig({ providers: { observer: { kind: 'anthropic', model: 'haiku' } } });
      withDb((db) => {
        const b = db.prepare("INSERT INTO memory_batches (project, session_id, reason) VALUES (?, 's1', 'manual')").run(repo).lastInsertRowid;
        appendEvent(db, { eventUid: 'sig-1', project: repo, sessionId: 's1', kind: 'prompt', body: 'rotate the token' });
        db.prepare("UPDATE evidence_events SET batch_id = ? WHERE event_uid = 'sig-1'").run(b);
        db.prepare("INSERT INTO memory_jobs (batch_id, status) VALUES (?, 'pending')").run(b);
      });
      const child = spawn(process.execPath, [cliPath, 'memory', 'process'], {
        cwd: repo,
        env: env({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }),
      });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      const closed = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
      for (let i = 0; i < 100 && !fs.existsSync(mark); i++) await new Promise((r) => setTimeout(r, 50));
      expect(fs.existsSync(mark)).toBe(true);
      child.kill('SIGTERM');
      expect(await closed).toBe(0);
      expect(stdout).toMatch(/^processed \d+ · entries 0/m);
      expect(withDb((db) => db.prepare('SELECT status FROM memory_jobs').get())).toEqual({ status: 'pending' });
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('memory backlog', () => {
  function queue(project: string, session = 's1', body = '<evidence project="x">'): number {
    return withDb((db) => {
      const b = Number(db.prepare("INSERT INTO memory_batches (project, session_id, reason) VALUES (?, ?, 'manual')").run(project, session).lastInsertRowid);
      appendEvent(db, { eventUid: `ev-${b}`, project, sessionId: session, kind: 'prompt', body });
      db.prepare('UPDATE evidence_events SET batch_id = ? WHERE event_uid = ?').run(b, `ev-${b}`);
      db.prepare("INSERT INTO memory_jobs (batch_id, status) VALUES (?, 'pending')").run(b);
      return b;
    });
  }

  it('lists nothing, and then each group', () => {
    expect(eklavya(['memory', 'backlog']).stdout).toBe('No unfinished jobs or helper sessions.\n');
    queue(repo, 's1', 'an ordinary prompt');
    const res = eklavya(['memory', 'backlog', '--project', repo]);
    expect(res.stdout).toMatch(new RegExp(`^\\s+1 pending\\s+${esc(repo)}$`, 'm'));
    expect(res.stdout).not.toMatch(/Helper sessions/);
  });

  it('flags observer helper sessions and says what to do with them', () => {
    queue(repo, 'helper-1');
    const res = eklavya(['memory', 'backlog']);
    expect(res.stdout).toMatch(/\[observer helper sessions\]/);
    expect(res.stdout).toMatch(/eklavya memory backlog discard --helpers/);
  });

  it('quarantines, restores and discards what a selector names', () => {
    const b = queue(repo);
    expect(eklavya(['memory', 'backlog', 'quarantine', '--batch', String(b)]).stdout).toBe('quarantined 1 job(s) — kept, and never processed until restored.\n');
    expect(eklavya(['memory', 'backlog', 'restore', '--session', 's1']).stdout).toBe('restored 1 job(s) to the queue.\n');
    expect(eklavya(['memory', 'backlog', 'discard', '--project', repo]).stdout).toMatch(/^discarded 1 batch\(es\), 1 evidence event\(s\) and 0 memory entries\.$/m);
  });

  it('says entry, singular, for one discarded entry', () => {
    const b = queue(repo);
    withDb((db) => insertEntry(db, { project: repo, title: 'from the batch', batchId: b }));
    expect(eklavya(['memory', 'backlog', 'discard', '--batch', String(b)]).stdout).toMatch(/and 1 memory entry\.$/m);
  });

  it('refuses a change with no selector, a bad batch id and an unknown action', () => {
    expect(eklavya(['memory', 'backlog', 'discard']).stderr).toMatch(/needs --helpers, --project <key>, --session <id> or --batch <id>/);
    expect(eklavya(['memory', 'backlog', 'list', '--batch', 'x']).stderr).toMatch(/--batch needs a batch id\./);
    const res = eklavya(['memory', 'backlog', 'shred', '--helpers']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/^Usage: eklavya memory backlog \[list\|quarantine/m);
  });
});

describe('memory stop', () => {
  it('says when there is no worker', () => {
    expect(eklavya(['memory', 'stop']).stdout).toBe('no memory worker is running.\n');
  });

  it('stops the worker by pid and releases the slot', async () => {
    const w = sacrificial();
    holder({ token: 't', pid: w.pid, child: null, job: null, until: future(), heartbeat: new Date().toISOString() });
    const res = await eklavyaAsync(['memory', 'stop']);
    expect(res.stdout).toBe(`stopped the memory worker (pid ${w.pid}). Unfinished jobs stay queued.\n`);
    expect(withDb((db) => db.prepare("SELECT 1 FROM meta WHERE key = 'memory_worker'").get())).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('stops a provider call whose worker is gone, and says a provider restarts it', async () => {
    globalConfig({ providers: { observer: { kind: 'anthropic', model: 'haiku' } } });
    const call = sacrificial({ detached: true });
    holder({ token: 't', pid: null, child: call.pid, job: null, until: future(), heartbeat: new Date().toISOString() });
    const res = await eklavyaAsync(['memory', 'stop']);
    expect(res.stdout).toBe(
      `stopped the memory worker and its claude call (pid ${call.pid}). Unfinished jobs stay queued.\n` +
        'the next session seam starts a new one. To keep it stopped: eklavya config set providers.observer null\n',
    );
  });

  it('says when a worker had to be killed, and when something it started would not exit', () => {
    expect(stopMessage({ stopped: true, pid: 7, child: null, forced: true, released: false })).toBe(
      'stopped the memory worker (pid 7) — it had to be killed. Unfinished jobs stay queued.\n' +
        'something it started would not exit; the slot stays held until it does.\n',
    );
  });

  it('does nothing inside the observer\'s own session', () => {
    expect(eklavya(['memory', 'stop'], repo, { EKLAVYA_INTERNAL_OBSERVER: '1' }).stdout).toBe('');
  });
});

describe('memory replay', () => {
  it('has nowhere to replay into with memory off', () => {
    globalConfig({ memory: { enabled: false } });
    expect(eklavya(['memory', 'replay']).stdout).toBe('memory.enabled is false, so there is nowhere to replay into.\n');
  });

  it('says where it looked when there are no transcripts', () => {
    const res = eklavya(['memory', 'replay']);
    expect(res.stdout).toMatch(/^No Claude Code transcripts found for this checkout\.$/m);
    expect(res.stdout).toContain(path.join(userHome, '.claude', 'projects'));
  });

  it('reads this checkout\'s transcripts and says what it captured', () => {
    const dir = path.join(userHome, '.claude', 'projects', repo.replace(/[/\\]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const line = { type: 'user', cwd: repo, sessionId: 'replay-1', timestamp: '2026-09-20T10:00:00.000Z', message: { role: 'user', content: 'rotate the refresh token' } };
    fs.writeFileSync(path.join(dir, 'replay-1.jsonl'), `${JSON.stringify(line)}\n`);
    const res = eklavya(['memory', 'replay', '--limit', '5']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^transcripts: 1 of 1$/m);
    expect(res.stdout).toMatch(/^captured:\s+1$/m);
    expect(eklavya(['memory', 'replay']).stdout).toMatch(/^already had: 1$/m);
  });
});

describe('memory move', () => {
  const gone = () => path.join(path.dirname(repo), `moved-away-${path.basename(repo)}`);

  it('lists folders with history that no longer exist, or says there are none', () => {
    expect(eklavya(['memory', 'move']).stdout).toBe('No history is filed under a folder that no longer exists.\n');
    withDb((db) => insertEntry(db, { project: gone(), title: 'old' }));
    const res = eklavya(['memory', 'move']);
    expect(res.stdout).toMatch(new RegExp(`^ {2}${esc(gone())} {2}\\(1 entries\\)$`, 'm'));
    expect(res.stdout).toMatch(/Re-file one here: eklavya memory move <old>/);
  });

  it('re-files a moved checkout\'s history here', () => {
    withDb((db) => insertEntry(db, { project: gone(), title: 'old' }));
    const res = eklavya(['memory', 'move', gone()]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(new RegExp(`^Moved ${esc(gone())} → ${esc(repo)}: \\d+ rows re-filed, 1 memory entries here now\\.$`, 'm'));
  });

  it('refuses what it cannot or should not move', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-mem-plain-'));
    try {
      const cases: Array<[string[], RegExp]> = [
        [['memory', 'move', gone(), path.join(outside, 'nope')], /does not exist\./],
        [['memory', 'move', gone(), outside], /not inside a git repository/],
        [['memory', 'move', repo], /is already this project\./],
        [['memory', 'move', outside], /still exists, so it is a separate checkout/],
        [['memory', 'move', gone()], /No history is filed under/],
      ];
      for (const [argv, want] of cases) {
        const res = eklavya(argv);
        expect(res.status).toBe(1);
        expect(res.stderr).toMatch(want);
      }
      // --force takes the one that still exists, once it has history.
      withDb((db) => insertEntry(db, { project: outside, title: 'other' }));
      expect(eklavya(['memory', 'move', outside, '--force']).status).toBe(0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('memory import', () => {
  function source(extra: (db: Database.Database) => void = () => {}): string {
    const file = path.join(home, `claude-mem-${Math.random().toString(36).slice(2)}.db`);
    buildSource(file);
    const db = new Database(file);
    extra(db);
    db.close();
    return file;
  }

  it('verifies before an import: every row missing, ids listed, exit 1', () => {
    const src = source((db) => {
      const add = db.prepare(
        "INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch) VALUES ('mem-session-1', 'demo-repo', 'note', ?, '2025-10-05T00:00:00.000Z', 1)",
      );
      for (let i = 0; i < 10; i++) add.run(`extra ${i}`);
    });
    const res = eklavya(['memory', 'import', src, '--verify']);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/observations\s+12 in source ·\s+0 in Eklavya · 12 missing \(ids 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, …\)/);
    expect(res.stdout).toMatch(/^INCOMPLETE: /m);
  });

  it('verifies after one: placed and unplaced projects, and an entry changed since', () => {
    const src = source();
    expect(eklavya(['memory', 'import', src, '--map', `demo-repo=${repo}`]).status).toBe(0);
    withDb((db) => db.prepare("UPDATE memory_entries SET title = 'edited here' WHERE id = (SELECT MIN(id) FROM memory_entries WHERE kind = 'observation')").run());
    const res = eklavya(['memory', 'import', src, '--verify']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/changed since import: 1 entry$/m);
    expect(res.stdout).toMatch(new RegExp(`demo-repo\\s+→ ${esc(repo)}`));
    expect(res.stdout).toMatch(/^complete: every source row is in Eklavya\.$/m);
  });

  it('says changed entries, plural, and names a project it could not place', () => {
    const src = source();
    expect(eklavya(['memory', 'import', src]).status).toBe(0);
    const res = eklavya(['memory', 'import', src, '--verify']);
    expect(res.stdout).toMatch(/changed since import: 0 entries$/m);
    expect(res.stdout).toMatch(/not placed — searchable only with --all-projects/);
  });

  it('describes a database it cannot import before refusing it', () => {
    const file = path.join(home, 'odd.db');
    const db = new Database(file);
    db.exec('CREATE TABLE mystery (x)');
    db.close();
    const res = eklavya(['memory', 'import', file]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^schema:\s+unversioned/m);
    expect(res.stdout).toMatch(/^range:\s+— … —$/m);
    expect(res.stdout).toMatch(/mystery {3}\(unrecognised\)$/m);
  });

  it('plans a dry run with a mapped and an unmapped project', () => {
    const src = source((db) => {
      db.prepare(
        "INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch) VALUES ('x', 'other-repo', 'note', 'elsewhere', '2025-10-05T00:00:00.000Z', 1)",
      ).run();
    });
    const res = eklavya(['memory', 'import', src, '--dry-run', '--map', `demo-repo=${repo}`]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(new RegExp(`^would map: demo-repo -> ${esc(repo)}$`, 'm'));
    expect(res.stdout).toMatch(/^would keep as-is: .*other-repo/m);
  });

  it('plans a dry run where every project is mapped', () => {
    const res = eklavya(['memory', 'import', source(), '--dry-run', '--map', `demo-repo=${repo}`]);
    expect(res.stdout).not.toMatch(/would keep as-is/);
  });

  it('names a trailing --map with no pair', () => {
    expect(eklavya(['memory', 'import', 'src.db', '--map']).stderr).toMatch(/Usage: --map <source-project>=<path-to-checkout>/);
  });

  it('fails an import whose counts do not validate', () => {
    withDb((db) => {
      const id = insertEntry(db, { project: repo, title: 'imported earlier', importSource: 'claude-mem' });
      db.prepare('DELETE FROM memory_vectors WHERE entry_id = ?').run(id);
    });
    const res = eklavya(['memory', 'import', source()]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^ {2}validation: FAILED — .*have no vector/m);
  });

  it('fails an import that leaves a source row missing by id', () => {
    withDb((db) =>
      db.exec(`CREATE TRIGGER lose_one AFTER INSERT ON memory_entries WHEN NEW.title = 'Split the migration runner'
               BEGIN UPDATE memory_entries SET deleted_at = '2000-01-01' WHERE id = NEW.id; END`),
    );
    const res = eklavya(['memory', 'import', source()]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^ {2}validation: ok$/m);
    expect(res.stdout).toMatch(/^INCOMPLETE: 1 source row/m);
  });

  it('asks which checkout when two with the project\'s name sit where it used to be', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-mem-moved-')));
    try {
      for (const d of ['a', 'b']) fs.mkdirSync(path.join(base, d, 'demo-repo', '.git'), { recursive: true });
      const transcripts = path.join(claudeDir, 'projects', '-no-such-dir');
      fs.mkdirSync(transcripts, { recursive: true });
      fs.writeFileSync(path.join(transcripts, 'content-1.jsonl'), `${JSON.stringify({ cwd: path.join(base, 'old', 'demo-repo') })}\n`);
      const src = source();
      const dry = eklavya(['memory', 'import', src, '--dry-run']);
      expect(dry.stdout).toMatch(/^ {2}demo-repo: 2 checkouts carry this name — pick one: --map demo-repo=<path>/m);
      const real = eklavya(['memory', 'import', src]);
      expect(real.stdout).toMatch(/^ {2}demo-repo: 2 checkouts carry this name/m);
      // Re-run with the choice made: the rows an earlier run left under the bare name move.
      const mapped = eklavya(['memory', 'import', src, '--map', `demo-repo=${path.join(base, 'a', 'demo-repo')}`]);
      expect(mapped.stdout).toMatch(/^ {2}re-homed: \d+ entries an earlier run left under a bare project name$/m);
      expect(mapped.stdout).not.toMatch(/checkouts carry this name/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('memory export', () => {
  it('refuses to replace a file without --force, and replaces it with', () => {
    const out = path.join(home, 'backup', 'memory.json');
    expect(eklavya(['memory', 'export', out]).status).toBe(0);
    const again = eklavya(['memory', 'export', out]);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/already exists\. Pass --force to replace it\./);
    expect(eklavya(['memory', 'export', out, '--force']).stdout).toMatch(/^Wrote .* — 0 entries, schema version \d+$/m);
  });
});

describe('memory restore', () => {
  it('lets an unexpected failure through rather than calling it a bad export', () => {
    const file = path.join(home, 'export.json');
    fs.writeFileSync(file, JSON.stringify({ schema_version: EXPORT_SCHEMA_VERSION, entries: [{ id: 1, entry_uid: 'u1' }] }));
    const res = eklavya(['memory', 'restore', file]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).not.toBe('');
  });
});

describe('memory sync', () => {
  let shared = '';
  beforeEach(() => {
    shared = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-mem-shared-'));
  });
  afterEach(() => fs.rmSync(shared, { recursive: true, force: true }));

  const on = (over: Record<string, unknown> = {}) =>
    globalConfig({ sync: { enabled: true, target: shared, device_id: 'desktop', ...over } });
  const device = (id: string): EklavyaConfig => ({ ...DEFAULT_CONFIG, sync: { enabled: true, target: shared, device_id: id } });

  it('says why it cannot push or pull', () => {
    expect(eklavya(['memory', 'sync', 'push']).stderr).toMatch(/^Sync is off\./m);
    on({ target: null });
    const res = eklavya(['memory', 'sync', 'pull']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/^No sync target\./m);
  });

  it('pushes one revision, singular', () => {
    on();
    withDb((db) => insertEntry(db, { project: repo, title: 'one' }));
    expect(eklavya(['memory', 'sync', 'status']).stdout).toMatch(/^pending:\s+1 local change to push$/m);
    expect(eklavya(['memory', 'sync', 'push']).stdout).toMatch(/: 1 new revision, 1 record written, 0 already there\.$/m);
    withDb((db) => {
      insertEntry(db, { project: repo, title: 'two' });
      insertEntry(db, { project: repo, title: 'three' });
    });
    expect(eklavya(['memory', 'sync', 'push']).stdout).toMatch(/: 2 new revisions, 2 records written, 1 already there\.$/m);
    expect(eklavya(['memory', 'sync', 'pull']).stdout).toMatch(/: 0 applied \(0 deletions\), 0 already known, 0 quarantined\.$/m);
  });

  it('pulls deletions and conflicts, stops at a torn record, and lists its peers', () => {
    on();
    const laptopFile = tempDbPath('laptop');
    const laptop = openDb(laptopFile);
    try {
      const shared1 = insertEntry(laptop, { project: repo, title: 'shared', narrative: 'v1' });
      const doomed = insertEntry(laptop, { project: repo, title: 'doomed' });
      push(laptop, device('laptop'));
      withDb((db) => pull(db, device('desktop')));

      laptop.prepare("UPDATE memory_entries SET narrative = 'laptop version' WHERE id = ?").run(shared1);
      withDb((db) => db.prepare("UPDATE memory_entries SET narrative = 'desktop version' WHERE title = 'shared'").run());
      deleteEntry(laptop, doomed);
      push(laptop, device('laptop'));

      // A third device whose only record is still being written.
      const phoneDir = path.join(shared, 'devices', 'phone');
      fs.mkdirSync(phoneDir, { recursive: true });
      fs.writeFileSync(path.join(phoneDir, '000000000001.json'), '{"half":');

      const res = eklavya(['memory', 'sync', 'pull']);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/: 1 applied \(1 deletion\), 0 already known, 1 quarantined\.$/m);
      expect(res.stdout).toMatch(/^Quarantined versions are kept whole in sync_conflicts/m);
      expect(res.stdout).toMatch(/^Stopped early on an unreadable record from: phone/m);
      expect(eklavya(['memory', 'sync', 'status']).stdout).toMatch(/^peers:\s+laptop@\d+/m);
    } finally {
      laptop.close();
      cleanup(laptopFile);
    }
  });
});
