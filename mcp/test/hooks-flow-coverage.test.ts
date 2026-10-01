import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../src/db.js';
import { conceptBySlug, gradeConcept, logSessionConcept } from '../src/store.js';
import { getCurrentSession } from '../src/session.js';
import { insertEntry } from '../src/memory/store.js';
import { probeDashboard } from '../src/dashboard-daemon.js';
import { tempDbPath, cleanup } from './helpers.js';

/**
 * The branches of the quiz, nudge and session-start hooks that the behavioural
 * suite in hooks.test.ts does not reach: failures injected with SQLite triggers
 * (deterministic, and no mocking of a spawned process), the dashboard states,
 * and the rarer inputs. The built hooks, run as the host runs them.
 */
const hooksDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'hooks');
const SESSION_START = path.join(hooksDir, 'session-start.js');
const STOP_CHECK = path.join(hooksDir, 'stop-quiz-check.js');
const CHECKPOINT = path.join(hooksDir, 'checkpoint-quiz.js');
const NUDGE = path.join(hooksDir, 'prompt-submit-nudge.js');
const DELEGATE_NUDGE = path.join(hooksDir, 'delegate-nudge.js');

const SESSION = 'flow-session';

let tmp = '';
let home = '';
let cwd = '';
let dbFile = '';
let db: DB;

interface Result {
  status: number;
  context: string;
  shown: string;
}

function parse(status: number | null, stdout: string): Result {
  let out: { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } } = {};
  if (stdout.trim()) out = JSON.parse(stdout);
  return { status: status ?? -1, context: out.hookSpecificOutput?.additionalContext ?? '', shown: out.systemMessage ?? '' };
}

const baseEnv = (env: Record<string, string>) => ({
  ...process.env,
  EKLAVYA_DB: dbFile,
  EKLAVYA_HOME: home,
  NO_COLOR: '1',
  ...env,
});

function runHook(script: string, input: Record<string, unknown>, env: Record<string, string> = {}): Result {
  const res = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env: baseEnv(env) });
  return parse(res.status, res.stdout ?? '');
}

/** Async, for a hook that talks to a server in this process: spawnSync would block it. */
function runHookAsync(script: string, input: Record<string, unknown>, env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: baseEnv(env) });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.on('error', reject);
    child.on('close', (code) => resolve(parse(code, stdout)));
    child.stdin.end(JSON.stringify(input));
  });
}

function configure(patch: Record<string, unknown>): void {
  const quiz = { only_on_changes: false, ...(patch.quiz as Record<string, unknown> | undefined) };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ min_minutes_between_quizzes: 0, ...patch, quiz }));
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function logConcepts(slugs: string[], session = SESSION): void {
  for (const slug of slugs) logSessionConcept(db, session, conceptBySlug(db, slug)!.id, `touched ${slug}`);
}

function answer(slug: string, session = SESSION): void {
  gradeConcept(db, {
    conceptId: conceptBySlug(db, slug)!.id,
    sessionId: session,
    question: 'q',
    answer: 'a',
    grade: 4,
    difficulty: 2,
    feedback: null,
    now: new Date(),
  });
}

const meta = (key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** A server on a free port that answers `/api/health` with `body`. */
async function healthServer(body: unknown): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-flow-')));
  home = path.join(tmp, 'home');
  cwd = path.join(tmp, 'cwd');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  dbFile = tempDbPath('hooks-flow');
  db = openDb(dbFile);
  configure({});
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('checkpoint-quiz', () => {
  const checkpoint = (extra: Record<string, unknown> = {}) =>
    runHook(CHECKPOINT, {
      session_id: SESSION,
      cwd,
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__eklavya__log_session_concepts',
      ...extra,
    });

  it('still asks when the activity stamp cannot be written', () => {
    configure({ min_minutes_between_checkpoints: 0 });
    logConcepts(['csrf']);
    db.exec(`CREATE TRIGGER no_activity BEFORE INSERT ON meta WHEN NEW.key LIKE 'activity:%'
             BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    const res = checkpoint();
    expect(res.status).toBe(0);
    expect(res.context).toMatch(/Concept: csrf/);
    expect(meta(`activity:${SESSION}`)).toBeUndefined();
  });

  it('with no tool name, says the work moved on rather than "you just logged"', () => {
    configure({ min_minutes_between_checkpoints: 0 });
    logConcepts(['csrf']);
    const res = checkpoint({ tool_name: undefined });
    expect(res.context).toMatch(/The work has moved on/);
  });

  it('with no tool name and only_on_changes, waits for a change', () => {
    configure({ min_minutes_between_checkpoints: 0, quiz: { only_on_changes: true } });
    logConcepts(['csrf']);
    expect(checkpoint({ tool_name: undefined }).context).toBe('');
  });

  it('asks under an enforced gate, from everything the session logged', () => {
    configure({ min_minutes_between_checkpoints: 0, quiz: { enforced: true } });
    logConcepts(['csrf']);
    expect(checkpoint().context).toMatch(/Concept: csrf/);
  });

  it('is paced by the last answer as well as the last checkpoint', () => {
    configure({ min_minutes_between_checkpoints: 10 });
    logConcepts(['csrf', 'pkce']);
    answer('csrf');
    expect(checkpoint().context).toBe('');
    db.prepare(`UPDATE attempts SET ts = datetime('now', '-60 minutes')`).run();
    expect(checkpoint().context).toMatch(/Concept: pkce/);
  });
});

describe('stop-quiz-check', () => {
  const stop = (extra: Record<string, unknown> = {}) =>
    runHook(STOP_CHECK, { session_id: SESSION, cwd, hook_event_name: 'Stop', ...extra });

  it('says nothing once the session budget is spent, even with work left', () => {
    configure({ max_questions_per_task: 1 });
    logConcepts(['csrf', 'pkce']);
    answer('csrf');
    db.prepare(`UPDATE attempts SET ts = datetime('now', '-60 minutes')`).run();
    expect(stop().context).toBe('');
  });

  it('fails open when filling a session that logged nothing throws', () => {
    fs.mkdirSync(path.join(cwd, '.git'));
    insertEntry(db, { project: cwd, sessionId: SESSION, title: 'Added CSRF token checks', narrative: 'csrf', occurredAt: new Date().toISOString() });
    db.exec('DROP TABLE learning_sources');
    const res = stop();
    expect(res.status).toBe(0);
    expect(res.context).toBe('');
    expect(db.prepare('SELECT count(*) AS n FROM session_concepts').get()).toEqual({ n: 0 });
  });
});

describe('prompt-submit-nudge', () => {
  const prompt = (text: string, env: Record<string, string> = {}) =>
    runHook(NUDGE, { session_id: SESSION, cwd, hook_event_name: 'UserPromptSubmit', prompt: text }, env);

  it('does nothing, not even the session pointer, with questions and memory both off', () => {
    configure({ quiz: { enabled: false }, memory: { enabled: false } });
    expect(prompt('hello there').status).toBe(0);
    expect(getCurrentSession(db, cwd)).toBeNull();
  });

  it("counts Eklavya's own slash commands for the usage ping", () => {
    prompt('/eklavya:quiz now please', { EKLAVYA_TELEMETRY: '', DO_NOT_TRACK: '' });
    const row = db.prepare(`SELECT n FROM usage_counts WHERE name = 'slash:quiz'`).get();
    expect(row).toEqual({ n: 1 });
  });

  it('treats an unreadable nudge row as a first prompt', () => {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(`prompt_nudge:${SESSION}`, '');
    expect(prompt('carry on').context).toBe('');
    expect(meta(`prompt_nudge:${SESSION}`)).toMatch(/^\d{4}-\d\d-\d\dT.*\|\|0$/);
  });

  it('carries on past a recall that throws', () => {
    fs.mkdirSync(path.join(cwd, '.git'));
    db.exec('DROP TABLE memory_vectors');
    const res = prompt('refactor the session token rotation in the auth middleware');
    expect(res.status).toBe(0);
    // The nudge half still ran: its first-seen clock started.
    expect(meta(`prompt_nudge:${SESSION}`)).toMatch(/\|\|0$/);
  });
});

describe('delegate-nudge', () => {
  const hook = (tool: string, toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) =>
    runHook(
      DELEGATE_NUDGE,
      { session_id: SESSION, cwd, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: toolInput, ...extra },
      env,
    );
  const bash = (command: unknown, env: Record<string, string> = {}) => hook('Bash', { command }, {}, env);
  const state = () => meta(`delegate_nudge:${SESSION}`);

  it('ignores an edit with an empty path', () => {
    expect(hook('Edit', { file_path: '' }).context).toBe('');
    expect(state()).toBeUndefined();
  });

  it('is silent without a database or a session id', () => {
    expect(hook('Edit', { file_path: 'a.ts' }, {}, { EKLAVYA_DB: path.join(tmp, 'none.db') }).context).toBe('');
    expect(hook('Edit', { file_path: 'a.ts' }, { session_id: undefined }).context).toBe('');
    expect(db.prepare(`SELECT count(*) AS n FROM meta WHERE key LIKE 'delegate_nudge:%'`).get()).toEqual({ n: 0 });
  });

  it('starts over from an unreadable state row', () => {
    const today = new Date().toISOString();
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(`delegate_nudge:${SESSION}`, `${today}|{not json`);
    expect(hook('Edit', { file_path: path.join(cwd, 'a.ts') }).context).toBe('');
    expect(hook('Edit', { file_path: path.join(cwd, 'b.ts') }).context).toMatch(/more than one file/);
  });

  describe('through Bash', () => {
    const write = (dir: string, file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);

    it('reads a non-string command as no command, and still snapshots the session tree', () => {
      git(cwd, 'init', '-q');
      write(cwd, 'a.ts', 'a');
      write(cwd, 'b.ts', 'b');
      expect(bash(42).context).toBe('');
      write(cwd, 'a.ts', 'a2');
      write(cwd, 'b.ts', 'b2');
      expect(bash(42).context).toMatch(/more than one file/);
    });

    it('follows a leading cd into a repository under ~', () => {
      const repo = path.join(tmp, 'proj');
      fs.mkdirSync(repo);
      git(repo, 'init', '-q');
      write(repo, 'a.ts', 'a');
      write(repo, 'b.ts', 'b');
      const env = { HOME: tmp, USERPROFILE: tmp };
      expect(bash('cd ~/proj && make', env).context).toBe('');
      write(repo, 'a.ts', 'a2');
      write(repo, 'b.ts', 'b2');
      expect(bash('cd ~/proj && make', env).context).toMatch(/more than one file/);
    });

    it('records a deleted tracked file as gone', () => {
      git(cwd, 'init', '-q');
      write(cwd, 'a.ts', 'a');
      git(cwd, 'add', 'a.ts');
      git(cwd, 'commit', '-q', '-m', 'a');
      fs.rmSync(path.join(cwd, 'a.ts'));
      write(cwd, 'new.ts', 'n');
      bash('ls');
      const snap = JSON.parse(state()!.slice(state()!.indexOf('|') + 1)) as { snaps: Record<string, Record<string, string>> };
      const files = Object.values(snap.snaps)[0]!;
      expect(files[path.join(cwd, 'a.ts')]).toBe('gone');
      expect(files[path.join(cwd, 'new.ts')]).toMatch(/^1:/);
    });

    it('reads a staged rename as one entry, skipping its source path', () => {
      git(cwd, 'init', '-q');
      write(cwd, 'old.ts', 'o');
      git(cwd, 'add', 'old.ts');
      git(cwd, 'commit', '-q', '-m', 'o');
      git(cwd, 'mv', 'old.ts', 'new.ts');
      bash('ls');
      const snap = JSON.parse(state()!.slice(state()!.indexOf('|') + 1)) as { snaps: Record<string, Record<string, string>> };
      expect(Object.keys(Object.values(snap.snaps)[0]!)).toEqual([path.join(cwd, 'new.ts')]);
    });

    it('takes no snapshot when git status fails', () => {
      git(cwd, 'init', '-q');
      write(cwd, 'a.ts', 'a');
      fs.writeFileSync(path.join(cwd, '.git', 'index'), 'not an index');
      expect(bash('ls').context).toBe('');
      expect(state()).toBeUndefined();
    });

    it('takes no snapshot of a tree with too many changed files', () => {
      git(cwd, 'init', '-q');
      for (let i = 0; i <= 2000; i++) write(cwd, `f${i}.txt`, '');
      expect(bash('ls').context).toBe('');
      expect(state()).toBeUndefined();
    });
  });
});

describe('session-start', () => {
  const start = (extra: Record<string, unknown> = {}, env: Record<string, string> = {}) =>
    runHook(SESSION_START, { session_id: SESSION, cwd, hook_event_name: 'SessionStart', source: 'startup', ...extra }, env);

  it('greets as usual when the update state cannot be read into a notice', () => {
    // An object `error` with a non-callable toString: the notice's template literal throws.
    fs.writeFileSync(path.join(home, 'update.json'), JSON.stringify({ error: { toString: 1 }, error_class: 'npm' }));
    const res = start();
    expect(res.status).toBe(0);
    expect(res.shown).toMatch(/^Eklavya active/);
    expect(res.shown).not.toMatch(/update/i);
  });

  it('tells a Cowork session that an enforced gate holds nothing there', () => {
    configure({ quiz: { enforced: true } });
    const res = start({}, { EKLAVYA_SURFACE: 'cowork' });
    expect(res.shown).toMatch(/this is a Cowork session/);
  });

  it('keeps logged work the usage ping has yet to count', () => {
    // A runtime install, and a ping 30 hours ago: nothing logged since then may go.
    const pkg = path.join(home, 'runtime', 'node_modules', 'eklavya');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    configure({ auto_update: false });
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    fs.writeFileSync(
      path.join(home, 'telemetry.json'),
      JSON.stringify({ announced_at: hoursAgo(100), sent_at: hoursAgo(30), attempt_at: new Date().toISOString() }),
    );
    logConcepts(['csrf'], 'older');
    logConcepts(['pkce'], 'oldest');
    db.prepare(`UPDATE session_concepts SET ts = ? WHERE session_id = 'older'`).run(hoursAgo(20));
    db.prepare(`UPDATE session_concepts SET ts = ? WHERE session_id = 'oldest'`).run(hoursAgo(40));

    expect(start({}, { CI: '', EKLAVYA_RUNTIME: '', EKLAVYA_TELEMETRY: '', DO_NOT_TRACK: '' }).status).toBe(0);
    const left = db.prepare('SELECT DISTINCT session_id AS s FROM session_concepts').all();
    expect(left).toEqual([{ s: 'older' }]);
  });

  it('announces the usage ping once, and keeps a day of logged work before any ping', () => {
    // A runtime install that can send but has never pinged. `CI` is cleared
    // explicitly: GitHub sets it, and it switches sending off.
    const pkg = path.join(home, 'runtime', 'node_modules', 'eklavya');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    configure({ auto_update: false });
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    logConcepts(['csrf'], 'older');
    logConcepts(['pkce'], 'oldest');
    db.prepare(`UPDATE session_concepts SET ts = ? WHERE session_id = 'older'`).run(hoursAgo(20));
    db.prepare(`UPDATE session_concepts SET ts = ? WHERE session_id = 'oldest'`).run(hoursAgo(40));
    const sending = { CI: '', EKLAVYA_RUNTIME: '', EKLAVYA_TELEMETRY: '', DO_NOT_TRACK: '' };

    const first = start({}, sending);
    expect(first.shown).toMatch(/now sends anonymous daily usage counts/);
    // No ping yet: the window is the last day, not the usual 12 hours.
    expect(db.prepare('SELECT DISTINCT session_id AS s FROM session_concepts').all()).toEqual([{ s: 'older' }]);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'telemetry.json'), 'utf8')).announced_at).toEqual(expect.any(String));

    expect(start({}, sending).shown).not.toMatch(/usage counts/);
  });

  it('still starts the session when pruning unasked work fails', () => {
    logConcepts(['csrf'], 'old');
    db.prepare(`UPDATE session_concepts SET ts = datetime('now', '-2 days')`).run();
    db.exec(`CREATE TRIGGER keep BEFORE DELETE ON session_concepts BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    const res = start();
    expect(res.context).toMatch(/log_session_concepts/);
    expect(db.prepare('SELECT count(*) AS n FROM session_concepts').get()).toEqual({ n: 1 });
  });

  describe('a moved checkout', () => {
    beforeEach(() => {
      git(cwd, 'init', '-q');
      git(cwd, 'commit', '-q', '--allow-empty', '-m', 'first');
    });
    const rootCommit = () => git(cwd, 'rev-list', '--max-parents=0', 'HEAD').trim();

    it('names how many moved folders share this history when there is more than one', () => {
      const root = rootCommit();
      for (const gone of ['/nowhere/a', '/nowhere/b']) {
        db.prepare('INSERT INTO project_roots (project, root_commit) VALUES (?, ?)').run(gone, root);
      }
      expect(start().shown).toContain("Memory · this repo's history is under 2 moved folders · eklavya memory move");
    });

    it('fails open when the roots cannot be recorded', () => {
      db.exec(`CREATE TRIGGER no_roots BEFORE INSERT ON project_roots BEGIN SELECT RAISE(ABORT, 'injected'); END`);
      const res = start();
      expect(res.shown).toMatch(/^Eklavya active/);
      expect(res.shown).not.toMatch(/Memory · /);
    });

    it('shortens a moved-from path under home to ~', () => {
      start({ session_id: 's1' });
      insertEntry(db, { project: cwd, title: 'Built the flip clock', narrative: 'n', occurredAt: new Date().toISOString() });
      const moved = path.join(tmp, 'moved');
      fs.renameSync(cwd, moved);
      const res = start({ session_id: 's2', cwd: moved }, { HOME: tmp, USERPROFILE: tmp });
      expect(res.shown).toContain('Memory · moved from ~/cwd · 1 entries re-filed');
    });
  });

  describe('the dashboard line', () => {
    it('links the dashboard when something answers its port', async () => {
      const srv = await healthServer({ app: 'not-eklavya' });
      try {
        const res = await runHookAsync(SESSION_START, { session_id: SESSION, cwd }, { EKLAVYA_DASHBOARD_PORT: String(srv.port) });
        expect(res.shown).toContain(`Dashboard http://127.0.0.1:${srv.port} · Observations http://127.0.0.1:${srv.port}/#/memory`);
      } finally {
        await srv.close();
      }
    });

    // Outside a test run the hook keeps a dashboard going itself.
    const live = { VITEST: '', CI: '' };

    it('reports one already serving this database as live', async () => {
      configure({ dashboard_autostart: true });
      const srv = await healthServer({ app: 'eklavya', version: '999.0.0', pid: 1, db: dbFile });
      try {
        const res = await runHookAsync(SESSION_START, { session_id: SESSION, cwd }, { ...live, EKLAVYA_DASHBOARD_PORT: String(srv.port) });
        expect(res.shown).toContain(`Dashboard http://127.0.0.1:${srv.port} · Observations`);
      } finally {
        await srv.close();
      }
    });

    it('leaves a port held by something else alone, and still links it', async () => {
      configure({ dashboard_autostart: true });
      const srv = await healthServer({ app: 'eklavya', version: '999.0.0', pid: 1, db: path.join(tmp, 'other.db') });
      try {
        const res = await runHookAsync(SESSION_START, { session_id: SESSION, cwd }, { ...live, EKLAVYA_DASHBOARD_PORT: String(srv.port) });
        expect(res.shown).toContain(`Dashboard http://127.0.0.1:${srv.port} · Observations`);
      } finally {
        await srv.close();
      }
    });

    it('starts one when nothing answers, and says how to turn that off', async () => {
      configure({ dashboard_autostart: true });
      const port = await freePort();
      const res = await runHookAsync(SESSION_START, { session_id: SESSION, cwd }, { ...live, EKLAVYA_DASHBOARD_PORT: String(port) });
      try {
        expect(res.shown).toContain(`Dashboard http://127.0.0.1:${port} started in the background`);
      } finally {
        // The detached dashboard it spawned: stop it once it answers.
        for (let i = 0; i < 50; i++) {
          const probe = await probeDashboard(port, 100);
          if (probe.kind === 'eklavya') {
            process.kill(probe.health.pid, 'SIGTERM');
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    });
  });
});
