import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { dashboardState, WRITES } from '../src/dashboard.js';
import { startDashboard as startBuilt } from '../dist/dashboard.js';
import { acknowledgeFeedback, insertFeedback, type NewFeedback } from '../src/feedback.js';
import { cleanup, tempDbPath } from './helpers.js';

let dbFile = '';
let db: DB;
let home = '';
const saved = process.env.EKLAVYA_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-dashfb-'));
  process.env.EKLAVYA_HOME = home;
  dbFile = tempDbPath('dashfb');
  db = openDb(dbFile);
});
afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  if (saved === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = saved;
});

const SECRET = 'the secret login prompt about /Users/x/payroll';
const item = (over: Partial<NewFeedback> = {}): NewFeedback => ({
  session_id: 's1',
  project: '/work/app',
  event_id: null,
  prompt: SECRET,
  review: { worked: 'ok', gaps: [{ area: 'outcome', missing: 'No goal.' }, { area: 'check', missing: 'No test.' }] },
  better: 'Fix the login bug in [the file].',
  tips: ['Say what fixed looks like'],
  model: 'sonnet',
  ...over,
});
const writeConfig = (c: Record<string, unknown>) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(c));

describe('the state payload', () => {
  const fb = () => (dashboardState(db) as any).feedback;

  it('says what is configured, what is pending and how many were acknowledged, never the prompt', () => {
    expect(fb()).toEqual({ enabled: false, memory: true, observer: false, pending: null, notify: false, acknowledged: 0, failed: false });
    writeConfig({ feedback: { enabled: true }, providers: { observer: { kind: 'anthropic', model: 'm' } } });
    const id = insertFeedback(db, item())!;
    expect(fb()).toEqual({ enabled: true, memory: true, observer: true, pending: { id }, notify: true, acknowledged: 0, failed: false });
    expect(JSON.stringify(dashboardState(db))).not.toContain('payroll');
    acknowledgeFeedback(db, id);
    expect(fb()).toMatchObject({ pending: null, acknowledged: 1 });
  });

  it('asks for attention only while feedback and memory are both on: a stale item stays quiet', () => {
    const id = insertFeedback(db, item())!;
    expect(fb()).toMatchObject({ pending: { id }, notify: false });
    writeConfig({ feedback: { enabled: true } });
    expect(fb().notify).toBe(true);
    writeConfig({ feedback: { enabled: true }, memory: { enabled: false } });
    expect(fb()).toMatchObject({ pending: { id }, notify: false });
  });

  it('reports memory off and a failed last review', () => {
    writeConfig({ memory: { enabled: false } });
    expect(fb().memory).toBe(false);
    db.prepare("INSERT INTO feedback_reviewed (session_id, outcome, reviewed_at) VALUES ('a', 'failed', '2026-01-01 00:00:00')").run();
    expect(fb().failed).toBe(true);
    db.prepare("INSERT INTO feedback_reviewed (session_id, outcome, reviewed_at) VALUES ('b', 'nothing', '2026-01-02 00:00:00')").run();
    expect(fb().failed).toBe(false);
  });

  it('is an older database without the table: nothing pending, no throw', () => {
    db.exec('DROP TABLE feedback_items; DROP TABLE feedback_reviewed;');
    expect(fb()).toMatchObject({ pending: null, acknowledged: 0, failed: false });
  });
});

const post = (port: number, route: string, body: unknown, headers: Record<string, string>) =>
  new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += String(c)));
      res.on('end', () => {
        let parsed: any = text;
        try { parsed = JSON.parse(text); } catch { /* plain text */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });

async function withServer(fn: (port: number, token: string, url: string) => Promise<void>) {
  const { url, close } = await startBuilt(db, { port: 0 });
  try {
    const html = await (await fetch(url)).text();
    const token = /name="eklavya-token" content="([0-9a-f]+)"/.exec(html)?.[1] ?? '';
    await fn(Number(new URL(url).port), token, url);
  } finally {
    close();
  }
}
const hdr = (port: number, token: string) => ({
  host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-eklavya-token': token,
});
const get = async (url: string, p: string) => {
  const r = await fetch(`${url}${p}`);
  return { status: r.status, body: await r.json() };
};

describe('POST /api/feedback/opened', () => {
  const uses = () =>
    Object.fromEntries(
      (db.prepare("SELECT name, SUM(n) AS n FROM usage_counts WHERE name LIKE 'feedback:%' GROUP BY name").all() as { name: string; n: number }[]).map((r) => [r.name, r.n]),
    );
  const noTelemetryEnv = () => {
    delete process.env.EKLAVYA_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
  };

  it('counts how a pending item was reached, from a closed list, and anything else is direct', async () => {
    noTelemetryEnv();
    insertFeedback(db, item());
    await withServer(async (port, token) => {
      const h = hdr(port, token);
      for (const via of ['greeting', 'badge', 'direct', 'nonsense', undefined, 42, 'greeting; DROP']) {
        const r = await post(port, '/api/feedback/opened', { via }, h);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ok: true });
      }
    });
    expect(uses()).toEqual({ 'feedback:opened_greeting': 1, 'feedback:opened_badge': 1, 'feedback:opened_direct': 5 });
  });

  it('counts nothing with no item pending, and refuses a body that is not an object', async () => {
    noTelemetryEnv();
    await withServer(async (port, token) => {
      const h = hdr(port, token);
      expect((await post(port, '/api/feedback/opened', { via: 'badge' }, h)).status).toBe(200);
      expect((await post(port, '/api/feedback/opened', [1], h)).status).toBe(400);
    });
    expect(uses()).toEqual({});
  });

  it('counts nothing when the usage ping is off', async () => {
    process.env.EKLAVYA_TELEMETRY = '0';
    insertFeedback(db, item());
    try {
      await withServer(async (port, token) => {
        await post(port, '/api/feedback/opened', { via: 'badge' }, hdr(port, token));
      });
    } finally {
      delete process.env.EKLAVYA_TELEMETRY;
    }
    expect(uses()).toEqual({});
  });
});

describe('the feedback routes', () => {
  it('registers the writes with a size cap', () => {
    expect(WRITES['/api/feedback/acknowledge']!.maxBytes).toBe(16 * 1024);
    expect(WRITES['/api/feedback/delete']!.maxBytes).toBe(16 * 1024);
    expect(WRITES['/api/feedback/opened']!.maxBytes).toBe(16 * 1024);
  });

  it('GET /api/feedback returns the pending item, and viewing it never acknowledges it', async () => {
    const id = insertFeedback(db, item())!;
    await withServer(async (_port, _t, url) => {
      for (let i = 0; i < 3; i++) {
        const r = await get(url, '/api/feedback');
        expect(r.status).toBe(200);
        expect(r.body.item).toMatchObject({ id, prompt: SECRET, better: 'Fix the login bug in [the file].', tips: ['Say what fixed looks like'], acknowledged_at: null });
        expect(r.body.item.review.gaps[0].area).toBe('outcome');
        expect((await get(url, `/api/feedback?id=${id}`)).body.item.id).toBe(id);
      }
      expect(db.prepare('SELECT acknowledged_at FROM feedback_items').get()).toEqual({ acknowledged_at: null });
    });
  });

  it('GET /api/feedback is null with nothing pending, and 404 for an unknown id', async () => {
    await withServer(async (_port, _t, url) => {
      expect(await get(url, '/api/feedback')).toEqual({ status: 200, body: { item: null } });
      expect((await get(url, '/api/feedback?id=999')).status).toBe(404);
      expect((await get(url, '/api/feedback?id=abc')).status).toBe(404);
    });
  });

  it('POST acknowledge sets it once, answers already for a repeat, 404 for an unknown id', async () => {
    const id = insertFeedback(db, item())!;
    await withServer(async (port, token) => {
      const h = hdr(port, token);
      const first = await post(port, '/api/feedback/acknowledge', { id }, h);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ ok: true, result: 'acknowledged' });
      expect(first.body.state).toMatchObject({ pending: null, acknowledged: 1 });
      const again = await post(port, '/api/feedback/acknowledge', { id }, h);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ ok: true, result: 'already' });
      expect((await post(port, '/api/feedback/acknowledge', { id: 999 }, h)).status).toBe(404);
      expect((await post(port, '/api/feedback/acknowledge', { id: 999 }, h)).body.error).toBe('not_found');
      expect((await post(port, '/api/feedback/acknowledge', { id: 'x' }, h)).status).toBe(400);
      expect((await post(port, '/api/feedback/acknowledge', [1], h)).status).toBe(400);
    });
  });

  it('POST delete removes the item, unblocks the next, and does not count as acknowledged', async () => {
    const id = insertFeedback(db, item())!;
    await withServer(async (port, token) => {
      const h = hdr(port, token);
      const r = await post(port, '/api/feedback/delete', { id }, h);
      expect(r.status).toBe(200);
      expect(r.body.state).toMatchObject({ pending: null, acknowledged: 0 });
      expect((await post(port, '/api/feedback/delete', { id }, h)).status).toBe(404);
      expect((await post(port, '/api/feedback/delete', { id: 0 }, h)).status).toBe(400);
      expect(insertFeedback(db, item())).not.toBeNull();
    });
  });

  it('a GET on a write route is refused, and nothing is acknowledged', async () => {
    const id = insertFeedback(db, item())!;
    await withServer(async (_p, _t, url) => {
      const r = await fetch(`${url}/api/feedback/acknowledge?id=${id}`);
      expect(r.status).toBe(404);
      const w = await fetch(`${url}/api/feedback/acknowledge`, { method: 'PUT' });
      expect(w.status).toBe(405);
    });
    expect(db.prepare('SELECT acknowledged_at FROM feedback_items').get()).toEqual({ acknowledged_at: null });
  });

  it('lists acknowledged items only, newest first, paged, with the first 80 characters and the gap areas', async () => {
    const a = insertFeedback(db, item({ prompt: 'a'.repeat(200), session_id: 'a' }))!;
    acknowledgeFeedback(db, a);
    const b = insertFeedback(db, item({ project: '/work/other', session_id: 'b' }))!;
    acknowledgeFeedback(db, b);
    insertFeedback(db, item({ session_id: 'c' }));
    await withServer(async (_p, _t, url) => {
      const r = await get(url, '/api/feedback/list');
      expect(r.body.total).toBe(2);
      expect(r.body.items.map((i: any) => i.id)).toEqual([b, a]);
      expect(r.body.items[1].prompt.length).toBe(80);
      expect(r.body.items[1].areas).toEqual(['outcome', 'check']);
      expect(JSON.stringify(r.body)).not.toContain('Fix the login');
      const scoped = await get(url, `/api/feedback/list?project=${encodeURIComponent('/work/other')}`);
      expect(scoped.body.items.map((i: any) => i.id)).toEqual([b]);
      const paged = await get(url, '/api/feedback/list?per=1&page=2');
      expect(paged.body).toMatchObject({ total: 2, page: 2, pages: 2 });
      expect(paged.body.items.map((i: any) => i.id)).toEqual([a]);
      expect((await get(url, '/api/feedback/list?per=1&page=99')).body.page).toBe(2);
    });
  });
});
