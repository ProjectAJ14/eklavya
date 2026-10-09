import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../src/db.js';
import { insertFeedback } from '../src/feedback.js';

const hooksDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'hooks');
const SESSION_START = path.join(hooksDir, 'session-start.js');

let home = '';
let cwd = '';
let dbFile = '';
let db: DB;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-fbhook-home-'));
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-fbhook-cwd-')));
  dbFile = path.join(home, 'knowledge.db');
  db = openDb(dbFile);
});
afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const writeConfig = (c: Record<string, unknown>) =>
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ quiz: { only_on_changes: false }, auto_update: false, telemetry: false, dashboard_autostart: false, ...c }));
const ON = { feedback: { enabled: true }, providers: { observer: { kind: 'anthropic', model: 'sonnet' } } };

function sessionStart(env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [SESSION_START], {
    input: JSON.stringify({ session_id: 'fb-session', cwd, hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
    // The config turns off auto-update, the ping and the dashboard: each is a real detached process.
    env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home, EKLAVYA_RUNTIME: '', ...env },
  });
  let shown = '';
  try {
    shown = (JSON.parse(res.stdout) as { systemMessage?: string }).systemMessage ?? '';
  } catch {
    /* no output */
  }
  return { status: res.status, stdout: res.stdout, shown };
}

/** A runtime whose cli leaves a marker, so a spawned `feedback generate` is observable. */
function stubRuntime(): string {
  const dist = path.join(home, 'runtime', 'node_modules', 'eklavya', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const marker = path.join(home, 'feedback-started');
  fs.writeFileSync(path.join(dist, 'cli.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));\n`);
  return marker;
}
async function appears(file: string, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('SessionStart starts the feedback review without waiting', () => {
  it('spawns `feedback generate --background` detached, and exits 0', async () => {
    writeConfig(ON);
    const marker = stubRuntime();
    const res = sessionStart({ CI: '', VITEST: '', EKLAVYA_DASHBOARD_PORT: '41731' });
    expect(res.status).toBe(0);
    expect(await appears(marker)).toBe(true);
    expect(fs.readFileSync(marker, 'utf8')).toBe('feedback generate --background');
  });

  it('starts nothing while an item is pending, or with feedback off, or under a test runner', async () => {
    const marker = stubRuntime();
    writeConfig({});
    expect(sessionStart({ CI: '', VITEST: '' }).status).toBe(0);
    writeConfig(ON);
    expect(sessionStart().status).toBe(0);
    insertFeedback(db, {
      session_id: 's', project: 'p', event_id: null, prompt: 'x', review: {} as never, better: 'b', tips: ['t'], model: 'm',
    });
    expect(sessionStart({ CI: '', VITEST: '' }).status).toBe(0);
    expect(await appears(marker, 800)).toBe(false);
  });

  it('starts it even with questions off, since feedback is its own switch', async () => {
    writeConfig({ ...ON, quiz: { enabled: false } });
    const marker = stubRuntime();
    expect(sessionStart({ CI: '', VITEST: '' }).status).toBe(0);
    expect(await appears(marker)).toBe(true);
  });
});
