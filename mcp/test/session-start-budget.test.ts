import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../src/db.js';
import { insertEntry } from '../src/memory/store.js';
import { tempDbPath, cleanup } from './helpers.js';

/**
 * The session-start hook is killed by the host after 10 seconds, and a kill
 * shows nothing. A detail that cannot finish inside the budget is left out and
 * the rest is shown. `EKLAVYA_TEST_STALL` blocks the details child on one
 * detail, standing in for a slow query that a timer could not interrupt.
 */
const SESSION_START = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'hooks', 'session-start.js');
const BUDGET = '2500';

let tmp = '';
let cwd = '';
let dbFile = '';
let db: DB;

function start(env: Record<string, string> = {}) {
  const t = Date.now();
  const res = spawnSync(process.execPath, [SESSION_START], {
    input: JSON.stringify({ session_id: 'budget', cwd, hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
    env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: path.join(tmp, 'home'), NO_COLOR: '1', EKLAVYA_SESSION_START_BUDGET_MS: BUDGET, ...env },
  });
  const out = res.stdout.trim() ? JSON.parse(res.stdout) : {};
  return {
    status: res.status,
    ms: Date.now() - t,
    shown: (out.systemMessage ?? '') as string,
    context: (out.hookSpecificOutput?.additionalContext ?? '') as string,
  };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-budget-')));
  fs.mkdirSync(path.join(tmp, 'home'));
  cwd = path.join(tmp, 'cwd');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  dbFile = tempDbPath('session-budget');
  db = openDb(dbFile);
  insertEntry(db, { project: cwd, sessionId: 'older', title: 'Added CSRF token checks', narrative: 'csrf', occurredAt: new Date().toISOString() });
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('session-start time budget', () => {
  it('shows every detail when none is slow', () => {
    const res = start();
    expect(res.status).toBe(0);
    expect(res.shown).toMatch(/^Eklavya active/);
    expect(res.shown).toMatch(/Learning \d+ · Mastered \d+ · Due \d+/);
    expect(res.context).toContain('Added CSRF token checks');
  });

  it.each([
    ['health', /Learning \d/, 'Added CSRF token checks'],
    ['recall', /Learning \d/, null],
    ['counts', /Eklavya active/, 'Added CSRF token checks'],
    ['level', /Eklavya active · v\S+ · .*auto/, 'Added CSRF token checks'],
  ])('drops a stalled %s detail and still greets with the rest', (detail, shownMatch, inContext) => {
    const res = start({ EKLAVYA_TEST_STALL: detail });
    expect(res.status).toBe(0);
    expect(res.ms).toBeLessThan(Number(BUDGET) + 4000);
    expect(res.shown).toMatch(shownMatch);
    if (detail === 'counts') expect(res.shown).not.toMatch(/Learning \d/);
    if (inContext) expect(res.context).toContain(inContext);
    else expect(res.context).not.toContain('CSRF');
    // The standing directive never depends on a detail.
    expect(res.context).toContain('log_session_concepts');
  });

  it('skips the details altogether once the budget is already spent', () => {
    const res = start({ EKLAVYA_SESSION_START_BUDGET_MS: '1' });
    expect(res.status).toBe(0);
    expect(res.shown).toMatch(/^Eklavya active/);
    expect(res.shown).not.toMatch(/Learning \d/);
    expect(res.context).not.toContain('CSRF');
  });

  it('reads an unusable budget setting as the default', () => {
    expect(start({ EKLAVYA_SESSION_START_BUDGET_MS: 'soon' }).shown).toMatch(/Learning \d/);
  });
});
