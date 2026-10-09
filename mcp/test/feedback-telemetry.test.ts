import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { countUse } from '../src/telemetry.js';
import { assertSafe, buildEvents, type TelemetryEvent } from '../src/telemetry-send.js';
import { acknowledgeFeedback, insertFeedback } from '../src/feedback.js';

const ENV = ['EKLAVYA_HOME', 'EKLAVYA_DB', 'EKLAVYA_TELEMETRY', 'DO_NOT_TRACK'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let tmp = '';
let db: DB;
const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const state = { sent_at: '2026-10-07T12:00:00.000Z' };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-fbtel-'));
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

const events = (now = NOW) => buildEvents(db, now, state);
const named = (es: TelemetryEvent[], name: string) => es.filter((e) => e.name === name);
const writeConfig = (c: Record<string, unknown>) => {
  fs.mkdirSync(process.env.EKLAVYA_HOME!, { recursive: true });
  fs.writeFileSync(path.join(process.env.EKLAVYA_HOME!, 'config.json'), JSON.stringify(c));
};
const SECRET_PROMPT = 'fix the payroll bug in /Users/x/secret/payroll.ts using hunter2-token';
const add = (over: Record<string, unknown> = {}) => {
  const id = insertFeedback(db, {
    session_id: 'session-abc-123',
    project: '/Users/x/secret',
    event_id: null,
    prompt: SECRET_PROMPT,
    review: {
      delegation: { status: 'mixed', note: 'note about payroll' },
      description: { status: 'missing', note: 'no goal' },
      discernment: { status: 'not_visible', note: '' },
      diligence: { status: 'not_visible', note: '' },
      judged_from: 'prompt',
    } as never,
    better: 'Fix the payroll bug in [the file] rewrite text',
    tips: ['Name the file tip text'],
    model: 'claude-secret-model',
    ...over,
  })!;
  return id;
};
const setTimes = (id: number, created: string, ack: string | null) =>
  db.prepare('UPDATE feedback_items SET created_at = ?, acknowledged_at = ? WHERE id = ?').run(created, ack, id);

describe('the feedback event', () => {
  it('carries the switch and two counts, and nothing else', () => {
    const [e] = named(events(), 'feedback');
    expect(e).toEqual({ name: 'feedback', params: { feedback_enabled: false, generated_new: 0, acknowledged_new: 0 } });
    writeConfig({ feedback: { enabled: true } });
    expect(named(events(), 'feedback')[0]!.params.feedback_enabled).toBe(true);
  });

  it('counts what was made and what was acknowledged since the last ping', () => {
    const old = add({ session_id: 'old' });
    acknowledgeFeedback(db, old);
    setTimes(old, '2026-10-01 10:00:00', '2026-10-02 10:00:00');
    const made = add({ session_id: 'made' });
    acknowledgeFeedback(db, made);
    setTimes(made, '2026-10-08 01:00:00', '2026-10-08 02:00:00');
    const waiting = add({ session_id: 'waiting' });
    setTimes(waiting, '2026-10-08 03:00:00', null);
    expect(named(events(), 'feedback')[0]!.params).toMatchObject({ generated_new: 2, acknowledged_new: 1 });
  });

  it('counts a deleted item as neither acknowledged nor, once gone, generated', () => {
    const id = add();
    db.prepare('DELETE FROM feedback_items WHERE id = ?').run(id);
    expect(named(events(), 'feedback')[0]!.params).toMatchObject({ generated_new: 0, acknowledged_new: 0 });
  });

  it('survives a database from before the table', () => {
    db.exec('DROP TABLE feedback_items');
    expect(named(events(), 'feedback')[0]!.params).toMatchObject({ generated_new: 0, acknowledged_new: 0 });
  });

  it('is safe to send, and no part of an item reaches any event', () => {
    const id = add();
    acknowledgeFeedback(db, id);
    countUse(db, 'feedback:opened_greeting');
    const es = events(NOW + 3 * 86_400_000);
    expect(() => assertSafe(es)).not.toThrow();
    const wire = JSON.stringify(es);
    for (const leak of ['/Users/x', 'secret', 'payroll', 'hunter2', 'session-abc', 'claude-secret-model', 'Name the file', 'rewrite text', 'no goal', 'mixed', 'missing']) {
      expect(wire, leak).not.toContain(leak);
    }
  });
});

describe('how the reader got to the page', () => {
  it('goes out as feature_use events of kind feedback, once the day is finished', () => {
    countUse(db, 'feedback:opened_greeting');
    countUse(db, 'feedback:opened_greeting');
    countUse(db, 'feedback:opened_badge');
    countUse(db, 'feedback:opened_direct');
    // Today's counts are still growing and go out tomorrow.
    expect(named(events(Date.now()), 'feature_use').filter((e) => e.params.kind === 'feedback')).toEqual([]);
    const uses = named(events(Date.now() + 2 * 86_400_000), 'feature_use').filter((e) => e.params.kind === 'feedback');
    expect(uses.map((e) => e.params)).toEqual([
      { kind: 'feedback', feature: 'opened_badge', count: 1 },
      { kind: 'feedback', feature: 'opened_direct', count: 1 },
      { kind: 'feedback', feature: 'opened_greeting', count: 2 },
    ]);
  });
});
