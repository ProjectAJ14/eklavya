import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../src/db.js';
import { tempDbPath, cleanup } from './helpers.js';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'hooks', 'ask-label.js');

let dbFile = '';

function ask(entrypoint: string, questions: unknown[], extra: Record<string, unknown> = {}) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: { questions }, ...extra }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: entrypoint, EKLAVYA_SURFACE: '', ...(dbFile ? { EKLAVYA_DB: dbFile } : {}) },
  });
  expect(r.status).toBe(0);
  return r.stdout;
}

const unsigned = { header: 'Eklavya', question: 'What does const buy you?' };

describe('ask-label', () => {
  it('denies an unsigned Eklavya question on a card host', () => {
    expect(JSON.parse(ask('claude-desktop', [unsigned])).hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('lets a signed one, another header, a terminal and a subagent through', () => {
    expect(ask('claude-desktop', [{ ...unsigned, question: '[Eklavya]\nWhat?' }])).toBe('');
    expect(ask('claude-desktop', [{ header: 'Plan', question: 'Which?' }])).toBe('');
    expect(ask('cli', [unsigned])).toBe('');
    expect(ask('claude-desktop', [unsigned], { agent_id: 'a1' })).toBe('');
    expect(ask('claude-desktop', [{ header: 'Eklavya', question: ' [eklavya] What?' }])).toBe('');
  });
  it('ignores other tools and malformed input, and treats Cowork as a card host', () => {
    expect(ask('claude-desktop', [unsigned], { tool_name: 'Bash' })).toBe('');
    expect(ask('claude-desktop', 'nope' as any)).toBe('');
    expect(ask('claude-desktop', [null, { header: 'Eklavya' }])).toBe('');
    expect(JSON.parse(ask('local-agent', [unsigned])).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('ask-label: conspicuous options', () => {
  const opt = (label: string, description: string) => ({ label, description });
  const lopsided = (stem: string) => ({
    header: 'Eklavya',
    question: stem,
    options: [
      opt('Compares a value', 'Checks a header'),
      opt('Checks a value the browser adds itself and a page cannot set', 'A forged cross-site request then carries a different origin and fails'),
      opt('Signs a value', 'Adds a signature'),
      opt('Hashes a value', 'Adds a digest'),
    ],
  });
  it('denies once, then lets the same stem through', () => {
    const q = lopsided(`Why compare the Origin header? ${Date.now()}`);
    const sid = { session_id: `s-${Date.now()}` };
    expect(JSON.parse(ask('cli', [q], sid)).hookSpecificOutput.permissionDecisionReason).toMatch(/option 2 is/);
    expect(ask('cli', [q], sid)).toBe('');
  });
  it('leaves other headers and balanced questions alone', () => {
    expect(ask('cli', [{ ...lopsided('Which?'), header: 'Plan' }])).toBe('');
    const balanced = { header: 'Eklavya', question: 'Balanced?', options: ['a', 'b', 'c', 'd'].map((x) => opt(`Option ${x}`, 'Same length here')) };
    expect(ask('cli', [balanced])).toBe('');
  });
});

describe('ask-label: option check record', () => {
  const opt = (label: string, description: string) => ({ label, description });
  const lopsided = (stem: string) => ({
    header: 'Eklavya',
    question: stem,
    options: [
      opt('Compares a value', 'Checks a header'),
      opt('Checks a value the browser adds itself and a page cannot set', 'A forged cross-site request then carries a different origin and fails'),
      opt('Signs a value', 'Adds a signature'),
      opt('Hashes a value', 'Adds a digest'),
    ],
  });
  const balanced = (stem: string) => ({ header: 'Eklavya', question: stem, options: ['a', 'b', 'c', 'd'].map((x) => opt(`Option ${x}`, 'Same length here')) });
  const rows = () => {
    const db = openDb(dbFile);
    try {
      return db.prepare('SELECT session_id, surface, outcome FROM option_checks ORDER BY id').all();
    } finally {
      db.close();
    }
  };
  beforeEach(() => {
    dbFile = tempDbPath('ask-label');
    openDb(dbFile).close();
  });
  afterEach(() => {
    cleanup(dbFile);
    dbFile = '';
  });

  it('counts the send-back, then an unchanged retry once, and a third sight not at all', () => {
    const stem = `Why compare the Origin header? ${Math.random()}`;
    const sid = { session_id: `s-${Math.random()}` };
    ask('cli', [lopsided(stem)], sid);
    ask('cli', [lopsided(stem)], sid);
    ask('cli', [lopsided(stem)], sid);
    expect(rows()).toEqual([
      { session_id: sid.session_id, surface: 'card', outcome: 'sent_back' },
      { session_id: sid.session_id, surface: 'card', outcome: 'unchanged' },
    ]);
  });
  it('counts a rewrite that fixed it, and nothing for a question that was balanced first time', () => {
    const stem = `Why compare the Origin header? ${Math.random()}`;
    const sid = { session_id: `s-${Math.random()}` };
    ask('cli', [lopsided(stem)], sid);
    ask('cli', [balanced(stem)], sid);
    ask('cli', [balanced(`Another ${Math.random()}`)], sid);
    expect(rows().map((r: any) => r.outcome)).toEqual(['sent_back', 'rewritten']);
  });
  it('files a question from a host that sent no session under "unknown"', () => {
    ask('cli', [lopsided(`No session ${Math.random()}`)]);
    expect(rows()).toEqual([{ session_id: 'unknown', surface: 'card', outcome: 'sent_back' }]);
  });
  it('still denies when there is no database to count in', () => {
    dbFile = path.join(path.dirname(dbFile), 'missing', 'x.db');
    const out = ask('cli', [lopsided(`Stem ${Math.random()}`)], { session_id: `s-${Math.random()}` });
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
