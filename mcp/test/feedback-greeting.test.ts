import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../src/db.js';
import { insertFeedback } from '../src/feedback.js';

const SESSION_START = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'hooks', 'session-start.js');
const RED = (t: string) => `\u001b[38;5;196m${t}\u001b[0m`;

let home = '';
let cwd = '';
let dbFile = '';
let db: DB;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-fbgreet-home-'));
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-fbgreet-cwd-')));
  dbFile = path.join(home, 'knowledge.db');
  db = openDb(dbFile);
});
afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const config = (c: Record<string, unknown> = {}) =>
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ quiz: { only_on_changes: false }, auto_update: false, telemetry: false, dashboard_autostart: false, feedback: { enabled: true }, ...c }),
  );
const pend = () =>
  insertFeedback(db, {
    session_id: 's', project: 'p', event_id: null, prompt: 'x', review: {} as never, better: 'b', tips: ['t'], model: 'm',
  });

/** Something that answers the dashboard port, so the greeting believes it is live. */
async function live(): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = http.createServer((_q, res) => res.end(JSON.stringify({ app: 'not-eklavya' })));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { port: (srv.address() as net.AddressInfo).port, close: () => new Promise((r) => srv.close(() => r())) };
}
async function freePort(): Promise<number> {
  const s = await live();
  await s.close();
  return s.port;
}

function greet(port: number, env: Record<string, string | undefined> = {}): Promise<{ status: number | null; shown: string; lines: string[] }> {
  return new Promise((resolve) => {
    const e: NodeJS.ProcessEnv = { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home, EKLAVYA_DASHBOARD_PORT: String(port), ...env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
    const child = spawn(process.execPath, [SESSION_START], { env: e });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stdin.end(JSON.stringify({ session_id: 'greet', cwd, hook_event_name: 'SessionStart', source: 'startup' }));
    child.on('close', (status) => {
      let shown = '';
      try {
        shown = (JSON.parse(out) as { systemMessage?: string }).systemMessage ?? '';
      } catch {
        /* no output */
      }
      resolve({ status, shown, lines: shown.split('\n') });
    });
  });
}
const coloured = { NO_COLOR: undefined };

describe('the greeting when feedback is waiting', () => {
  it('puts the dim dashboard link and the red feedback link on one line, with no memory link', async () => {
    config();
    pend();
    const srv = await live();
    try {
      const res = await greet(srv.port, coloured);
      const url = `http://127.0.0.1:${srv.port}`;
      expect(res.status).toBe(0);
      expect(res.lines).toContain(`\u001b[2mDashboard ${url} · \u001b[0m${RED(`Feedback waiting ${url}/#/feedback/dashboard?via=greeting`)}`);
      expect(res.shown).not.toContain('Observations');
    } finally {
      await srv.close();
    }
  });

  it('prefixes the feedback text with "! " and uses no escapes when colour is off', async () => {
    config();
    pend();
    const srv = await live();
    try {
      const res = await greet(srv.port, { NO_COLOR: '1' });
      const url = `http://127.0.0.1:${srv.port}`;
      expect(res.lines).toContain(`Dashboard ${url} · ! Feedback waiting ${url}/#/feedback/dashboard?via=greeting`);
      expect(res.shown).not.toContain('\u001b');
    } finally {
      await srv.close();
    }
  });

  it('names the command instead of a dead link when the dashboard is down', async () => {
    config();
    pend();
    const res = await greet(await freePort(), coloured);
    expect(res.lines).toContain(RED('Feedback waiting · run: eklavya dashboard'));
    expect(res.shown).not.toContain('Dashboard & observations');
    expect(res.shown).not.toContain('http://');
    const plain = await greet(await freePort(), { NO_COLOR: '1' });
    expect(plain.lines).toContain('! Feedback waiting · run: eklavya dashboard');
  });

  it('also greets with questions off, since memory is on', async () => {
    config({ quiz: { enabled: false } });
    pend();
    const res = await greet(await freePort(), coloured);
    expect(res.lines).toContain(RED('Feedback waiting · run: eklavya dashboard'));
  });

  it('says nothing about it when quiet is set: the greeting is suppressed by design', async () => {
    config({ quiet: true });
    pend();
    const res = await greet(await freePort(), coloured);
    expect(res.status).toBe(0);
    expect(res.shown).not.toContain('Feedback');
  });

  it('is byte-identical to today with nothing waiting', async () => {
    config();
    const srv = await live();
    try {
      const without = await greet(srv.port, coloured);
      expect(without.lines).toContain(`\u001b[2mDashboard http://127.0.0.1:${srv.port} · Observations http://127.0.0.1:${srv.port}/#/memory\u001b[0m`);
      expect(without.shown).not.toMatch(/Feedback|! /);
      // Acknowledged items do not count as waiting.
      db.prepare("INSERT INTO feedback_items (session_id, project, prompt, review, better, tips, rubric, model, acknowledged_at) VALUES ('s','p','x','{}','b','[]',1,'m',datetime('now'))").run();
      expect((await greet(srv.port, coloured)).shown).toBe(without.shown);
    } finally {
      await srv.close();
    }
  });

  it('says nothing while feedback or memory is off, even with an item stored', async () => {
    pend();
    const srv = await live();
    try {
      config({ feedback: { enabled: false } });
      expect((await greet(srv.port, coloured)).shown).not.toContain('Feedback');
      config({ memory: { enabled: false } });
      expect((await greet(srv.port, coloured)).shown).not.toContain('Feedback');
    } finally {
      await srv.close();
    }
  });

  it('prints no feedback line and exits 0 on a database from before the table', async () => {
    config();
    pend();
    db.exec('DROP TABLE feedback_items');
    const srv = await live();
    try {
      const res = await greet(srv.port, coloured);
      expect(res.status).toBe(0);
      expect(res.shown).toMatch(/^Eklavya active/);
      expect(res.shown).not.toContain('Feedback');
    } finally {
      await srv.close();
    }
  });
});
