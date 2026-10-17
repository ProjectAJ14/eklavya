import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { countUse } from '../src/telemetry.js';
import { assertSafe, buildEvents } from '../src/telemetry-send.js';
import { registerTools } from '../src/tools/index.js';
import { updateSetting, usageEvent, USAGE_EVENTS } from '../src/dashboard.js';

const ENV = ['EKLAVYA_HOME', 'EKLAVYA_DB', 'EKLAVYA_TELEMETRY', 'DO_NOT_TRACK'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let tmp = '';
let db: DB;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-usage-'));
  process.env.EKLAVYA_HOME = path.join(tmp, 'home');
  process.env.EKLAVYA_DB = path.join(tmp, 'home', 'knowledge.db');
  delete process.env.EKLAVYA_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  db = openDb();
});
afterEach(() => {
  db.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const counts = () =>
  Object.fromEntries((db.prepare('SELECT name, n FROM usage_counts').all() as { name: string; n: number }[]).map((r) => [r.name, r.n]));

describe('dashboard usage events', () => {
  it('counts a named event and refuses anything else', () => {
    expect(usageEvent(db, { name: 'explainer:depth_50' }).status).toBe(200);
    expect(usageEvent(db, { name: 'explainer:depth_50' }).status).toBe(200);
    for (const bad of [{ name: '/Users/x/secret' }, { name: 'dash:view_../x' }, { name: 5 }, {}, null, []]) {
      expect(usageEvent(db, bad).status).toBe(400);
    }
    expect(counts()).toEqual({ 'explainer:depth_50': 2 });
  });

  it('counts nothing when the ping is off', () => {
    process.env.EKLAVYA_TELEMETRY = '0';
    usageEvent(db, { name: 'dash:opened' });
    expect(counts()).toEqual({});
  });

  it('every allowed name passes the ping safety check', () => {
    for (const name of USAGE_EVENTS) countUse(db, name);
    const events = buildEvents(db, Date.now() + 2 * 86_400_000, {});
    expect(() => assertSafe(events)).not.toThrow();
    expect(events.filter((e) => e.name === 'feature_use')).toHaveLength(USAGE_EVENTS.size);
  });

  it('never stores a name the ping would refuse', () => {
    countUse(db, 'settings:dashboard:' + 'x'.repeat(41));
    countUse(db, 'no colon');
    countUse(db, 'a:b c');
    expect(counts()).toEqual({});
  });

  it('the page only reports names the server allows', () => {
    const page = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'dashboard.html'), 'utf8');
    const literal = [...page.matchAll(/send\('([^']+)'\)/g)].map((m) => m[1]!);
    expect(literal.length).toBeGreaterThan(0);
    for (const n of literal) expect(USAGE_EVENTS.has(n), n).toBe(true);
    const block = page.slice(page.indexOf('const WORKFLOWS = {'));
    for (const w of ['learning', 'memory', 'artifacts', 'feedback', 'settings']) {
      expect(block, w).toMatch(new RegExp(`^  ${w}: \\{$`, 'm'));
      expect(USAGE_EVENTS.has(`dash:view_${w}`)).toBe(true);
    }
  });
});

describe('settings source', () => {
  it('a dashboard change is counted under its key, never its value', () => {
    const r = updateSetting(db, { scope: 'user', key: 'cadence', value: 'end' });
    expect(r.status).toBe(200);
    expect(counts()).toEqual({ 'settings:dashboard:cadence': 1 });
  });

  it('a refused change is not counted', () => {
    expect(updateSetting(db, { scope: 'user', key: 'nope', value: 1 }).status).toBe(400);
    expect(counts()).toEqual({});
  });
});

describe('tool errors', () => {
  it('a tool that answers with an error is counted beside its use', async () => {
    const handlers = new Map<string, (a: unknown) => Promise<{ isError: boolean }>>();
    registerTools({ registerTool: (n: string, _c: unknown, h: never) => void handlers.set(n, h) } as never, db);
    expect((await handlers.get('memory_get')!({})).isError).toBe(true);
    expect((await handlers.get('get_config')!({})).isError).toBe(false);
    expect(counts()).toEqual({ 'tool:memory_get': 1, 'tool_error:memory_get': 1, 'tool:get_config': 1 });
  });
});
