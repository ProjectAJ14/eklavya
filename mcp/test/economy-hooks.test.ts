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
