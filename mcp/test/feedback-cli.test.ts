import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { identityFor } from '../src/memory/identity.js';
import { feedbackPending } from '../src/feedback.js';

const posix = process.platform !== 'win32';
const cliPath = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'cli.js');

let home = '';
let repo = '';
let bin = '';
let dbFile = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-fbcli-home-'));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-fbcli-repo-')));
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-fbcli-bin-'));
  fs.mkdirSync(path.join(repo, '.git'));
  dbFile = path.join(home, 'knowledge.db');
});
afterEach(() => {
  for (const d of [home, repo, bin]) fs.rmSync(d, { recursive: true, force: true });
});

const writeConfig = (c: Record<string, unknown>) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(c));
const ON = { feedback: { enabled: true }, providers: { observer: { kind: 'anthropic', model: 'sonnet' } } };

function seed(): string {
  const db = openDb(dbFile);
  const project = identityFor({ cwd: repo, sessionId: 's' }).project;
  const at = new Date(Date.now() - 3 * 86_400_000).toISOString();
  db.prepare("INSERT INTO evidence_events (event_uid, project, session_id, kind, body, occurred_at) VALUES ('a', ?, 'old', 'prompt', 'fix the login bug, users cannot sign in', ?)").run(project, at);
  db.close();
  return at.slice(0, 10);
}

function standIn(): void {
  const out = {
    chosen: 1,
    review: {
      delegation: { status: 'mixed', note: 'ok' },
      description: { status: 'missing', note: 'No goal.' },
      discernment: { status: 'not_visible', note: '' },
      diligence: { status: 'not_visible', note: '' },
      judged_from: 'prompt',
    },
    better: 'Fix the login bug in [the file].',
    tips: ['Say what fixed looks like'],
  };
  fs.writeFileSync(path.join(bin, 'out.json'), JSON.stringify({ subtype: 'success', is_error: false, structured_output: out }));
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ncat > /dev/null\ncat "${bin}/out.json"\n`, { mode: 0o755 });
}

function feedback(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [cliPath, 'feedback', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      EKLAVYA_HOME: home,
      EKLAVYA_DB: dbFile,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      ...env,
    },
  });
  return { status: res.status, out: res.stdout, err: res.stderr };
}

describe('eklavya feedback generate', () => {
  it('says off when the switch is off', () => {
    expect(feedback(['generate'])).toMatchObject({ status: 0, out: 'off\n' });
  });

  it('says needs memory, then needs providers.observer', () => {
    writeConfig({ feedback: { enabled: true }, memory: { enabled: false } });
    expect(feedback(['generate']).out).toBe('needs memory\n');
    writeConfig({ feedback: { enabled: true } });
    expect(feedback(['generate']).out).toBe('needs providers.observer\n');
  });

  it('says nothing to review on an empty history', () => {
    writeConfig(ON);
    expect(feedback(['generate'])).toMatchObject({ status: 0, out: 'nothing to review\n' });
  });

  it.skipIf(!posix)('reviews one prompt, then says an item is waiting', () => {
    writeConfig(ON);
    const date = seed();
    standIn();
    expect(feedback(['generate'])).toMatchObject({ status: 0, out: `reviewed 1 prompt from ${date}\n` });
    expect(feedback(['generate']).out).toBe('a feedback item is waiting: acknowledge it first\n');
    const db = openDb(dbFile);
    expect(feedbackPending(db)?.better).toBe('Fix the login bug in [the file].');
    db.close();
  });

  it.skipIf(!posix)('--background prints nothing, even when it does the work', () => {
    writeConfig(ON);
    seed();
    standIn();
    expect(feedback(['generate', '--background'])).toMatchObject({ status: 0, out: '', err: '' });
    const db = openDb(dbFile);
    expect(feedbackPending(db)).not.toBeNull();
    db.close();
  });

  it.skipIf(!posix)('says it will try again when the model is not available, and still exits 0', () => {
    writeConfig(ON);
    seed();
    expect(feedback(['generate'], { PATH: `${bin}-nowhere` })).toMatchObject({
      status: 0,
      out: "couldn't review right now: it will try again at a later start\n",
    });
  });

  it('exits 0 and stays quiet in the background when the database cannot be opened', () => {
    writeConfig(ON);
    fs.mkdirSync(dbFile);
    expect(feedback(['generate', '--background'])).toMatchObject({ status: 0, out: '', err: '' });
    expect(feedback(['generate']).status).toBe(0);
  });

  it('refuses an unknown subcommand with usage', () => {
    expect(feedback(['nope'])).toMatchObject({ status: 1 });
    expect(feedback([]).err).toMatch(/Usage: eklavya feedback generate/);
  });
});
