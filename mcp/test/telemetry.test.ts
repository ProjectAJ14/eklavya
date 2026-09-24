import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { countUse, disabledReason, readState } from '../src/telemetry.js';
import { assertSafe, buildEvents, sendNow } from '../src/telemetry-send.js';

const ENV = ['EKLAVYA_HOME', 'EKLAVYA_DB', 'EKLAVYA_TELEMETRY', 'DO_NOT_TRACK'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let tmp = '';
let db: DB;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-telemetry-'));
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

describe('usage ping', () => {
  it('is on by default and off by config, EKLAVYA_TELEMETRY or DO_NOT_TRACK', () => {
    expect(disabledReason()).toBeNull();
    process.env.EKLAVYA_TELEMETRY = '0';
    expect(disabledReason()).toMatch(/EKLAVYA_TELEMETRY/);
    delete process.env.EKLAVYA_TELEMETRY;
    process.env.DO_NOT_TRACK = '1';
    expect(disabledReason()).toMatch(/DO_NOT_TRACK/);
    delete process.env.DO_NOT_TRACK;
    fs.writeFileSync(path.join(process.env.EKLAVYA_HOME!, 'config.json'), '{"telemetry": false}');
    expect(disabledReason()).toBe('telemetry is false');
  });

  it('carries counts and setting values, never a path, name or text', () => {
    const secret = '/Users/someone/private-repo';
    const c = db.prepare("INSERT INTO concepts (slug, name, domain) VALUES ('secret-concept', 'Secret concept', 'x')").run();
    db.prepare('INSERT INTO session_concepts (session_id, concept_id, context) VALUES (?, ?, ?)').run('s1', c.lastInsertRowid, secret);
    db.prepare("INSERT INTO attempts (concept_id, session_id, question, answer, grade, difficulty, outcome) VALUES (?, 's1', ?, ?, 4, 1, 'answered')")
      .run(c.lastInsertRowid, 'What does my secret code do?', secret);
    db.prepare("INSERT INTO gates (session_id, mode, repo) VALUES ('s1', 'enforced', ?)").run(secret);
    countUse(db, 'cli:doctor');
    db.prepare("UPDATE usage_counts SET day = '2000-01-01'").run();

    const events = buildEvents(db);
    expect(() => assertSafe(events)).not.toThrow();
    const text = JSON.stringify(events);
    for (const leak of ['someone', 'private-repo', 'secret']) expect(text).not.toContain(leak);

    const learning = events.find((e) => e.name === 'learning')!.params;
    expect(learning.questions_new).toBe(1);
    expect(learning.passed_new).toBe(1);
    expect(events.find((e) => e.name === 'settings')!.params.projects_known).toBe(1);
    expect(events).toContainEqual({ name: 'feature_use', params: { kind: 'cli', feature: 'doctor', count: 1 } });
  });

  it('refuses free text anywhere in an event', () => {
    expect(() => assertSafe([{ name: 'settings', params: { focus: 'concept' } }])).not.toThrow();
    expect(() => assertSafe([{ name: 'settings', params: { topic: 'my secret topic' } }])).toThrow();
    expect(() => assertSafe([{ name: 'settings', params: { where: '/Users/x' } }])).toThrow();
  });

  it('counts feature use per day, and not at all when off', () => {
    countUse(db, 'tool:record_attempt');
    countUse(db, 'tool:record_attempt');
    expect(db.prepare('SELECT n FROM usage_counts').get()).toEqual({ n: 2 });
    process.env.DO_NOT_TRACK = '1';
    countUse(db, 'tool:record_attempt');
    expect(db.prepare('SELECT n FROM usage_counts').get()).toEqual({ n: 2 });
  });

  it('sends nothing without a runtime or a property, and keeps its window', async () => {
    expect(await sendNow(db)).toBe(false);
    expect(readState().sent_at).toBeUndefined();
  });
});
