import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { FEEDBACK_CLAIM_MS, insertFeedback, startBackgroundFeedback } from '../src/feedback.js';
import { runtimeCli } from '../src/update.js';
import { cleanup, tempDbPath } from './helpers.js';

const ON: EklavyaConfig = {
  ...DEFAULT_CONFIG,
  feedback: { enabled: true },
  providers: { observer: { kind: 'anthropic', model: 'sonnet' }, embeddings: null },
};

let db: Database;
let dbFile = '';
const saved = { CI: process.env.CI, VITEST: process.env.VITEST };

beforeEach(() => {
  dbFile = tempDbPath('feedback-bg');
  db = openDb(dbFile);
  // The hook never spawns under CI or a test runner; these tests are about the
  // other conditions, so they step out of both and put them back.
  delete process.env.CI;
  delete process.env.VITEST;
});
afterEach(() => {
  db.close();
  cleanup(dbFile);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

type Call = { cmd: string; args: string[]; opts: Record<string, unknown> };
function fake() {
  const calls: Call[] = [];
  let unrefs = 0;
  const spawn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    return { on: () => {}, unref: () => void unrefs++ };
  }) as never;
  return { calls, spawn, unrefs: () => unrefs };
}
const claim = () => db.prepare("SELECT value FROM meta WHERE key = 'feedback_attempt_at'").get() as { value: string } | undefined;
const pend = () =>
  insertFeedback(db, {
    session_id: 's', project: 'p', event_id: null, prompt: 'x', review: {} as never, better: 'b', tips: ['t'], model: 'm',
  });

describe('startBackgroundFeedback', () => {
  it('starts one detached review with the exact arguments, claiming first', () => {
    const f = fake();
    startBackgroundFeedback(db, ON, { cwd: '/work/app', spawn: f.spawn, now: 1_000 });
    expect(f.calls).toEqual([
      {
        cmd: process.execPath,
        args: [runtimeCli(), 'feedback', 'generate', '--background'],
        opts: { detached: true, stdio: 'ignore', windowsHide: true, cwd: '/work/app' },
      },
    ]);
    expect(f.unrefs()).toBe(1);
    expect(claim()?.value).toBe(new Date(1_000).toISOString());
  });

  it('does nothing when feedback is off, memory is off or no observer is set', () => {
    const f = fake();
    startBackgroundFeedback(db, { ...ON, feedback: { enabled: false } }, { cwd: '/w', spawn: f.spawn, now: 5_000_000 });
    startBackgroundFeedback(db, { ...ON, memory: { ...ON.memory, enabled: false } }, { cwd: '/w', spawn: f.spawn, now: 5_000_000 });
    startBackgroundFeedback(db, { ...ON, providers: { observer: null, embeddings: null } }, { cwd: '/w', spawn: f.spawn, now: 5_000_000 });
    expect(f.calls).toEqual([]);
    expect(claim()).toBeUndefined();
  });

  it('does nothing while an item is pending', () => {
    pend();
    const f = fake();
    startBackgroundFeedback(db, ON, { cwd: '/w', spawn: f.spawn, now: 5_000_000 });
    expect(f.calls).toEqual([]);
  });

  it('does nothing under CI or a test runner', () => {
    const f = fake();
    process.env.CI = '1';
    startBackgroundFeedback(db, ON, { cwd: '/w', spawn: f.spawn, now: 5_000_000 });
    delete process.env.CI;
    process.env.VITEST = 'true';
    startBackgroundFeedback(db, ON, { cwd: '/w', spawn: f.spawn, now: 5_000_000 });
    expect(f.calls).toEqual([]);
  });

  it('keeps a 30-minute claim, so two session starts do not both spawn', () => {
    expect(FEEDBACK_CLAIM_MS).toBe(30 * 60_000);
    const f = fake();
    startBackgroundFeedback(db, ON, { cwd: '/w', spawn: f.spawn, now: 1_000_000 });
    startBackgroundFeedback(db, ON, { cwd: '/w', spawn: f.spawn, now: 1_000_000 + FEEDBACK_CLAIM_MS - 1 });
    expect(f.calls).toHaveLength(1);
    startBackgroundFeedback(db, ON, { cwd: '/w', spawn: f.spawn, now: 1_000_000 + FEEDBACK_CLAIM_MS });
    expect(f.calls).toHaveLength(2);
  });

  it('reads an unreadable claim as free', () => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('feedback_attempt_at', 'garbage')").run();
    const f = fake();
    startBackgroundFeedback(db, ON, { cwd: '/w', spawn: f.spawn, now: 5_000_000 });
    expect(f.calls).toHaveLength(1);
  });

  it('returns quietly when spawn throws, and when the database cannot be read', () => {
    const throwing = (() => {
      throw new Error('EAGAIN');
    }) as never;
    expect(() => startBackgroundFeedback(db, ON, { cwd: '/w', spawn: throwing, now: 5_000_000 })).not.toThrow();
    const f = fake();
    db.close();
    expect(() => startBackgroundFeedback(db, ON, { cwd: '/w', spawn: f.spawn, now: 5_000_000 })).not.toThrow();
    expect(f.calls).toEqual([]);
    db = openDb(dbFile);
  });
});
