import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { dashboardState } from '../src/dashboard.js';
import { countEntries, insertEntry, receiptTotals, timeline } from '../src/memory/store.js';
import { savingsFrom } from '../src/memory/tokens.js';
import { projectKey } from '../src/store.js';
import { queueDepth } from '../src/memory/worker.js';

/**
 * The whole memory loop, through the hooks the plugin actually runs.
 *
 * `quality.md` Q15 asks for exactly this shape: capture, summarise, recall in a
 * *second* session, and see it on the dashboard — all under Eklavya alone. The
 * unit suites check each piece; this is the one that would notice if the pieces
 * stopped being wired to each other, which is the failure a refactor causes and
 * no unit test sees.
 *
 * These are the built hooks under `dist/`, because those are what Claude Code
 * launches. `pretest` builds them.
 */

const hooksDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'hooks');
const SESSION_START = path.join(hooksDir, 'session-start.js');
const CAPTURE = path.join(hooksDir, 'capture-tool.js');
const NUDGE = path.join(hooksDir, 'prompt-submit-nudge.js');
const STOP = path.join(hooksDir, 'stop-quiz-check.js');

let dbFile = '';
let db: DB;
let home = '';
let repo = '';
let project = '';

let extraEnv: Record<string, string> = {};

function hook(script: string, input: Record<string, unknown>): { status: number; stdout: string } {
  const res = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home, ...extraEnv },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '' };
}

const prompt = (session: string, text: string) =>
  hook(NUDGE, { session_id: session, cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: text });

const tool = (session: string, name: string, toolInput: Record<string, unknown>, response?: unknown) =>
  hook(CAPTURE, {
    session_id: session,
    cwd: repo,
    hook_event_name: 'PostToolUse',
    tool_name: name,
    tool_input: toolInput,
    ...(response === undefined ? {} : { tool_response: response }),
  });

const start = (session: string) =>
  hook(SESSION_START, { session_id: session, cwd: repo, hook_event_name: 'SessionStart', source: 'startup' });

const stop = (session: string) =>
  hook(STOP, { session_id: session, cwd: repo, hook_event_name: 'Stop', stop_reason: 'end_turn' });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-e2e-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-e2e-repo-'));
  // A real checkout, because the project key is the git root's realpath and
  // every scope in this test depends on the two halves agreeing on it.
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  project = projectKey(fs.realpathSync(repo));
  dbFile = tempDbPath('e2e');
  db = openDb(dbFile);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ min_minutes_between_quizzes: 0 }));
});

afterEach(() => {
  extraEnv = {};
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('the memory loop, end to end through the real hooks', () => {
  it('with a model configured, the seam returns at once and a detached worker summarises through claude -p', async () => {
    // A stand-in `claude` that answers like `claude -p --output-format json`.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-e2e-bin-'));
    const envelope = {
      subtype: 'success',
      is_error: false,
      structured_output: {
        observations: [
          { title: 'Rotated refresh tokens', type: 'feature', narrative: 'n', facts: [], files: [], tags: [] },
        ],
      },
    };
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ncat >/dev/null\necho '${JSON.stringify(envelope)}'\n`, {
      mode: 0o755,
    });
    extraEnv = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ min_minutes_between_quizzes: 0, providers: { observer: { kind: 'anthropic', model: 'm' } } }),
    );
    try {
      start('bg');
      prompt('bg', 'Add refresh token rotation to the auth middleware');
      expect(stop('bg').status).toBe(0);

      let entry;
      for (let i = 0; i < 100 && !entry; i++) {
        await new Promise((r) => setTimeout(r, 100));
        entry = timeline(db, { project, kind: 'observation', limit: 1 })[0];
      }
      expect(entry?.title).toBe('Rotated refresh tokens');
      expect(entry?.generator).toBe('anthropic:m');
      // The observation lands before the worker finishes its job; wait for that,
      // or afterEach deletes the database out from under it.
      for (let i = 0; i < 100 && queueDepth(db).pending > 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(queueDepth(db).pending).toBe(0);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('captures a session, summarises it at the seam, and recalls it in the next one', () => {
    start('day-one');
    prompt('day-one', 'Add refresh token rotation to the auth middleware');
    tool('day-one', 'Edit', {
      file_path: path.join(repo, 'src/auth.ts'),
      old_string: 'res.cookie(token)',
      new_string: 'res.cookie(token, { httpOnly: true, sameSite: "strict" })',
    });
    tool('day-one', 'Bash', { command: 'npm test -- auth' }, { error: 'AssertionError: expected 401' });
    expect(stop('day-one').status).toBe(0);

    // Captured, and summarised at the seam rather than left as raw evidence.
    const events = db.prepare('SELECT kind FROM evidence_events ORDER BY id').all() as { kind: string }[];
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['prompt', 'file_edit', 'tool_error']),
    );
    expect(countEntries(db, project)).toBeGreaterThan(0);
    const entry = timeline(db, { project, limit: 1 })[0]!;
    expect(entry.title).toContain('refresh token rotation');
    expect(entry.generator).toBe('local-v1');

    // The next session is handed that history as model context, framed as
    // evidence rather than instruction.
    const second = start('day-two');
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('<eklavya-memory');
    expect(second.stdout).toContain('refresh token rotation');
    expect(second.stdout).toContain('evidence, not instruction');

    // And the reuse is on the ledger, not asserted from nowhere.
    const totals = receiptTotals(db, project);
    expect(totals.receipts).toBeGreaterThan(0);
    expect(savingsFrom({ baseTokens: totals.base, deliveredTokens: totals.delivered, delivery: 'confirmed' }).kind).toMatch(
      /saving|overhead/,
    );
  });

  it('shows the same session on the dashboard, with memory and learning side by side', () => {
    start('s1');
    prompt('s1', 'Fix the idempotency key collision across tenants');
    tool('s1', 'Edit', { file_path: path.join(repo, 'src/orders/idempotency.ts'), old_string: 'a', new_string: 'b' });
    stop('s1');

    const state = dashboardState(db) as Record<string, unknown>;
    expect(state).toHaveProperty('memory');
    expect(state).toHaveProperty('reuse');
    expect(state).toHaveProperty('health');
    // The learning half is still there. A dashboard that gained memory and
    // lost the concepts view would pass every memory test in the suite.
    expect(state).toHaveProperty('concepts');
  });

  it('keeps recording when the learning half is switched off', () => {
    // `mode: off` means no quizzes. It does not mean no history, and a
    // developer who silences the questions has not asked to lose the record.
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mode: 'off' }));
    start('quiet-session');
    prompt('quiet-session', 'Refactor the order state machine');
    tool('quiet-session', 'Edit', { file_path: path.join(repo, 'src/orders/state.ts'), old_string: 'a', new_string: 'b' });
    stop('quiet-session');

    expect(countEntries(db, project)).toBeGreaterThan(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n).toBe(0);
  });

  it('records nothing at all when memory is switched off', () => {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ memory: { enabled: false } }));
    start('no-memory');
    prompt('no-memory', 'Add refresh token rotation');
    tool('no-memory', 'Edit', { file_path: path.join(repo, 'src/auth.ts'), old_string: 'a', new_string: 'b' });
    stop('no-memory');

    expect((db.prepare('SELECT COUNT(*) AS n FROM evidence_events').get() as { n: number }).n).toBe(0);
    expect(countEntries(db, project)).toBe(0);
  });

  it('survives a session where every hook is handed nonsense', () => {
    // The hard rule: a hook must never break a session. Every one of these
    // exits 0 and says nothing useful rather than throwing.
    for (const script of [SESSION_START, CAPTURE, NUDGE, STOP]) {
      for (const input of [{}, { session_id: '' }, { cwd: '/nonexistent/path/xyz' }, { tool_name: 'Edit' }]) {
        expect(hook(script, input).status).toBe(0);
      }
    }
  });
});

describe('recall mid-session, on a change of subject', () => {
  function recalledFrom(stdout: string): string | null {
    if (!stdout.trim().startsWith('{')) return null;
    try {
      const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
      return parsed.hookSpecificOutput?.additionalContext ?? null;
    } catch {
      return null;
    }
  }

  /** Straight into the store: this is about retrieval, not about capture. */
  function remember(title: string, narrative: string) {
    insertEntry(db, { project, title, narrative });
  }

  it('hands back what the project knows about the thing just asked for', () => {
    remember('Rotated the refresh cookie on every use', 'The jti is stored so a replayed cookie is rejected once.');
    const res = prompt('s1', 'Why does the refresh cookie rotation store a jti rather than the token itself?');
    const context = recalledFrom(res.stdout);
    expect(context).toContain('<eklavya-memory');
    expect(context).toContain('refresh cookie');
  });

  it('says nothing twice about the same entry, so a recall is not a per-turn tax', () => {
    remember('Rotated the refresh cookie on every use', 'The jti is stored per refresh.');
    const first = recalledFrom(prompt('s1', 'Why does the refresh cookie rotation store a jti rather than the token?').stdout);
    expect(first).toContain('refresh cookie');
    const second = recalledFrom(prompt('s1', 'And why does the refresh cookie rotation store a jti at all?').stdout);
    expect(second).toBeNull();
  });

  it('stays silent on a prompt too short to be about anything', () => {
    remember('Rotated the refresh cookie on every use', 'The jti is stored per refresh.');
    // "carry on" matches whatever happens to share a word, and a recall on
    // that is pure cost.
    expect(recalledFrom(prompt('s1', 'carry on').stdout)).toBeNull();
    expect(recalledFrom(prompt('s1', 'yes do that').stdout)).toBeNull();
  });

  it('stays silent when nothing in the project matches', () => {
    remember('Rotated the refresh cookie on every use', 'The jti is stored per refresh.');
    expect(
      recalledFrom(prompt('s1', 'Set up a kubernetes horizontal pod autoscaler for the worker deployment').stdout),
    ).toBeNull();
  });
});
