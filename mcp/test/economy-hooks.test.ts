import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { openSession } from '../src/ledger-pending.js';
import { cleanup, tempDbPath } from './helpers.js';

// The built hooks, spawned the way Claude Code runs them.
const hooksDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'hooks');
const CAPTURE = path.join(hooksDir, 'capture-tool.js');
const SESSION_END = path.join(hooksDir, 'session-end.js');
const SESSION_START = path.join(hooksDir, 'session-start.js');

let dbFile = '';
let db: DB;
let home = '';
let repo = '';

beforeEach(() => {
  dbFile = tempDbPath('eklavya-econhooks');
  db = openDb(dbFile);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-econhooks-home-'));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-econhooks-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

function hook(script: string, input: unknown, env: Record<string, string> = {}, db = dbFile) {
  const e: NodeJS.ProcessEnv = { ...process.env, EKLAVYA_DB: db, EKLAVYA_HOME: home, EKLAVYA_DASHBOARD_PORT: '1', ...env };
  delete e.EKLAVYA_SESSION_ID;
  delete e.EKLAVYA_ECONOMY;
  if (env.EKLAVYA_ECONOMY) e.EKLAVYA_ECONOMY = env.EKLAVYA_ECONOMY;
  const res = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env: e });
  return { status: res.status, stdout: res.stdout ?? '' };
}

const writeConfig = (raw: Record<string, unknown>) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(raw));

const errors = () =>
  db.prepare("SELECT body FROM evidence_events WHERE kind = 'tool_error' ORDER BY id").all() as { body: string }[];

describe('failure capture', () => {
  const base = { session_id: 's1', cwd: repo, tool_name: 'Bash', tool_input: { command: 'ls /nope' } };

  it('stores one failure once, whether PostToolUse, PostToolUseFailure or both report it', () => {
    hook(CAPTURE, { ...base, hook_event_name: 'PostToolUse', tool_use_id: 'tu1', tool_response: { is_error: true, stderr: 'ls: cannot access' } });
    hook(CAPTURE, { ...base, hook_event_name: 'PostToolUseFailure', tool_use_id: 'tu1', error: 'ls: cannot access' });
    expect(errors()).toHaveLength(1);
    expect(errors()[0]!.body).toContain('cannot access');
  });

  it('records an interrupt and a structured error, and two calls without ids as two', () => {
    hook(CAPTURE, { ...base, hook_event_name: 'PostToolUseFailure', tool_use_id: 'tu2', error: 'stopped', is_interrupt: true });
    hook(CAPTURE, { ...base, hook_event_name: 'PostToolUseFailure', tool_use_id: 'tu3', error: { code: 2 } });
    hook(CAPTURE, { ...base, hook_event_name: 'PostToolUseFailure' });
    const bodies = errors().map((e) => e.body);
    expect(bodies.some((b) => b.includes('(interrupted) stopped'))).toBe(true);
    expect(bodies.some((b) => b.includes('{"code":2}'))).toBe(true);
    expect(bodies).toHaveLength(3);
  });
});

describe('the ledger hooks', () => {
  const ledgerRows = () => db.prepare('SELECT session_id, project, transcript_path, folded_at FROM econ_sessions').all();

  it('SessionEnd opens the row with its transcript and exits 0', () => {
    const r = hook(SESSION_END, { session_id: 'end1', cwd: repo, hook_event_name: 'SessionEnd', reason: 'other', transcript_path: '/t/end1.jsonl' });
    expect(r.status).toBe(0);
    expect(ledgerRows()).toEqual([{ session_id: 'end1', project: repo, transcript_path: '/t/end1.jsonl', folded_at: null }]);
    hook(SESSION_END, { session_id: 'end2', cwd: repo, hook_event_name: 'SessionEnd', transcript_path: '' });
    expect(ledgerRows()).toHaveLength(2);
  });

  it('SessionEnd does nothing with the ledger off, the economy off for the session, no session, or no database', () => {
    writeConfig({ economy: { ledger: false } });
    hook(SESSION_END, { session_id: 'off1', cwd: repo });
    fs.rmSync(path.join(home, 'config.json'));
    hook(SESSION_END, { session_id: 'off2', cwd: repo }, { EKLAVYA_ECONOMY: 'off' });
    hook(SESSION_END, { cwd: repo });
    expect(ledgerRows()).toEqual([]);
    expect(hook(SESSION_END, { session_id: 'x', cwd: repo }, {}, path.join(home, 'missing', 'k.db')).status).toBe(0);
  });

  it('SessionStart opens this session and sweeps a quiet earlier one', () => {
    const old = path.join(home, 'old.jsonl');
    fs.writeFileSync(old, '');
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(old, past, past);
    openSession(db, { sessionId: 'old', project: repo, transcriptPath: old });
    const r = hook(SESSION_START, { session_id: 'start1', cwd: repo, hook_event_name: 'SessionStart', source: 'startup', transcript_path: '/t/start1.jsonl' });
    expect(r.status).toBe(0);
    expect(ledgerRows()).toContainEqual({ session_id: 'start1', project: repo, transcript_path: '/t/start1.jsonl', folded_at: null });
    hook(SESSION_START, { session_id: 'start2', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' });
    expect(ledgerRows()).toContainEqual({ session_id: 'start2', project: repo, transcript_path: null, folded_at: null });
    // A ledger that cannot write never stops a session.
    db.exec('DROP TABLE econ_sessions');
    expect(hook(SESSION_START, { session_id: 'start3', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }).status).toBe(0);
  });

  it('SessionStart outside a checkout files the row under no project, and leaves it with the ledger off', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-econhooks-out-'));
    try {
      hook(SESSION_START, { session_id: 'loose', cwd: outside, hook_event_name: 'SessionStart', source: 'startup' });
      expect(ledgerRows()).toContainEqual({ session_id: 'loose', project: null, transcript_path: null, folded_at: null });
      writeConfig({ economy: { ledger: false } });
      hook(SESSION_START, { session_id: 'quiet', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' });
      expect(ledgerRows()).not.toContainEqual(expect.objectContaining({ session_id: 'quiet' }));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

const PROMPT = path.join(hooksDir, 'prompt-submit-nudge.js');
const STOP = path.join(hooksDir, 'stop-quiz-check.js');
const SUBAGENT = path.join(hooksDir, 'subagent-start.js');
const CLI = path.join(path.dirname(hooksDir), 'cli.js');

describe('the loop guard through the hooks', () => {
  const seedEnvelope = () => {
    for (let i = 0; i < 5; i++) db.prepare(`INSERT INTO econ_envelope (project, calls, recorded_at) VALUES (?, 8, 'x')`).run(repo);
  };
  const spin = (n: number, extra: Record<string, string> = {}) => {
    const outs: string[] = [];
    for (let i = 0; i < n; i++) {
      outs.push(hook(CAPTURE, { session_id: 'g1', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' }, tool_response: { success: true } }, extra).stdout);
      outs.push(hook(CAPTURE, { session_id: 'g1', cwd: repo, hook_event_name: 'PostToolUseFailure', tool_use_id: `f${i}`, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'AssertionError: expected 1 to be 2' }, extra).stdout);
    }
    return outs.filter(Boolean);
  };

  it('opens a turn at the prompt, redirects once as additional context, then notices, and closes at Stop', () => {
    writeConfig({ quiz: { enabled: false }, memory: { enabled: false }, economy: { loopguard: 'nudge' } });
    seedEnvelope();
    hook(PROMPT, { session_id: 'g1', cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: 'make the tests pass please' });
    hook(CAPTURE, { session_id: 'g1', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'x' }, tool_response: null });
    expect(spin(9)).toEqual([]);
    // The edit that tips it over gets the one redirect.
    const redirect = JSON.parse(hook(CAPTURE, { session_id: 'g1', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' }, tool_response: { success: true } }).stdout);
    expect(redirect.hookSpecificOutput).toMatchObject({ hookEventName: 'PostToolUse', additionalContext: expect.stringContaining('[Eklavya loop check] So far') });
    // The next stuck call comes with no event name and no input: the one notice still answers, as PostToolUse.
    const notice = JSON.parse(hook(CAPTURE, { session_id: 'g1', cwd: repo, tool_name: 'Bash', tool_response: { is_error: true, error: 'AssertionError: expected 1 to be 2' } }).stdout);
    expect(notice.hookSpecificOutput).toMatchObject({ hookEventName: 'PostToolUse', additionalContext: expect.stringContaining('Tell the developer') });
    // Then the guard is quiet for the rest of the turn.
    expect(spin(3)).toEqual([]);
    // A call without an event name or input is still folded, and answers as PostToolUse.
    const bare = hook(CAPTURE, { session_id: 'g1', cwd: repo, tool_name: 'Bash', tool_response: { is_error: true, error: 'AssertionError: expected 1 to be 2' } });
    expect(bare.status).toBe(0);
    hook(STOP, { session_id: 'g1', cwd: repo, hook_event_name: 'Stop' });
    expect(db.prepare('SELECT outcome FROM econ_turns').get()).toEqual({ outcome: 'red' });
  });

  it('asks a judge when one is configured, and stops only a headless run in stop mode', () => {
    writeConfig({ economy: { loopguard: 'stop', nudges: 0 }, providers: { judge: { kind: 'anthropic', model: 'claude-haiku-4-5' } } });
    hook(PROMPT, { session_id: 'g1', cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: 'make the tests pass please' });
    spin(10);
    expect(db.prepare(`SELECT kind FROM econ_guard_events`).all()).toEqual([{ kind: 'judge' }]);
    writeConfig({ economy: { loopguard: 'stop', nudges: 0 } });
    seedEnvelope();
    hook(PROMPT, { session_id: 'g1', cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: 'make the tests pass please' });
    const outs = spin(10, { CLAUDE_CODE_SESSION_ATTENDED: '0' });
    expect(JSON.parse(outs[0]!)).toMatchObject({ continue: false });
  });

  it('opens a subagent turn, and every guard hook fails open without its tables', () => {
    writeConfig({ economy: { loopguard: 'nudge' } });
    hook(SUBAGENT, { session_id: 'g1', cwd: repo, hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'general-purpose' });
    expect(db.prepare(`SELECT agent_id FROM econ_turns`).get()).toEqual({ agent_id: 'ag1' });
    writeConfig({ quiz: { enabled: false }, memory: { enabled: false }, economy: { loopguard: 'nudge' } });
    hook(SUBAGENT, { session_id: 'g1', cwd: repo, hook_event_name: 'SubagentStart', agent_id: 'ag2' });
    db.exec('DROP TABLE econ_turns');
    for (const [script, input] of [
      [PROMPT, { session_id: 'g1', cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: 'make the tests pass please' }],
      [CAPTURE, { session_id: 'g1', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'x' } }],
      [STOP, { session_id: 'g1', cwd: repo, hook_event_name: 'Stop' }],
      [SUBAGENT, { session_id: 'g1', cwd: repo, hook_event_name: 'SubagentStart', agent_id: 'ag3' }],
    ] as const) {
      expect(hook(script, input).status).toBe(0);
    }
  });
});

describe('where the developer sees it', () => {
  it('the session banner names the last priced session', () => {
    openSession(db, { sessionId: 'old', project: repo, transcriptPath: null });
    db.prepare(`UPDATE econ_sessions SET folded_at = 'x', requests = 3, effective = 1500, model = 'claude-opus-4-6' WHERE session_id = 'old'`).run();
    const r = hook(SESSION_START, { session_id: 'new', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' });
    expect(r.stdout).toContain('Last session · 1.5k effective tokens on claude-opus-4-6');
    writeConfig({ quiz: { enabled: false } });
    expect(hook(SESSION_START, { session_id: 'new2', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }).stdout).toContain('Last session');
    db.exec('DROP TABLE econ_guard_events');
    expect(hook(SESSION_START, { session_id: 'new3', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }).stdout).not.toContain('Last session');
  });

  it('the status line carries the guard\'s note', () => {
    writeConfig({ economy: { loopguard: 'nudge' } });
    db.prepare(`INSERT INTO econ_turns (session_id, agent_id, project, opened_at, state, noticed) VALUES ('sl', '', ?, 'x', '{}', 1)`).run(repo);
    const res = spawnSync(process.execPath, [CLI, 'statusline', '--no-color'], {
      input: JSON.stringify({ session_id: 'sl', cwd: repo }),
      encoding: 'utf8',
      env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home },
    });
    expect(res.stdout).toContain('loop guard: this turn looks stuck');
  });

  it('the CLI dispatches every cost command', () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home, CLAUDE_CONFIG_DIR: home } });
    expect(run('cost').stdout).toContain('Cost of recent sessions here');
    expect(run('fold', '--pending').status).toBe(0);
    expect(run('judge', '1').stdout).toContain('No turn 1.');
    expect(run('toolprune').stdout).toContain('Tool pruning');
    expect(run('experiment', 'memory', '--report').stdout).toContain('memory on:');
    expect(run('memory', 'facts').stdout).toContain('Pinned facts');
  });
});
