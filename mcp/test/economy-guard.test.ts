import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { NOTICE, VERDICT_CALLS, closeTurn, foldCall, greenCalls, guardCounts, guardNote, ignoredTool, judgeTurn, openTurn, thresholdsOf } from '../src/loop-guard.js';
import { statusLine } from '../src/statusline.js';

const config = (patch: (c: EklavyaConfig) => void = () => {}): EklavyaConfig => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.economy.loopguard = 'nudge';
  patch(c);
  return c;
};

let home: string;
let db: DB;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-guard-'));
  db = openDb(path.join(home, 'knowledge.db'));
});
afterEach(() => {
  if (db.open) db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const P = '/r';
const call = (cfg: EklavyaConfig, over: Partial<Parameters<typeof foldCall>[2]> = {}) =>
  foldCall(db, cfg, { sessionId: 's', tool: 'Bash', args: { command: 'npm test' }, result: 'AssertionError: expected 1 to be 2', failed: true, ...over });

/** A stuck turn: the same failing test after edits to one file, `n` times over. */
function spin(cfg: EklavyaConfig, n: number, over: Partial<Parameters<typeof foldCall>[2]> = {}) {
  const outs = [];
  for (let i = 0; i < n; i++) {
    outs.push(foldCall(db, cfg, { sessionId: 's', tool: 'Edit', args: { file_path: 'src/a.ts' }, result: '', failed: false, ...over }));
    outs.push(call(cfg, over));
  }
  return outs.filter((o) => Object.keys(o).length);
}

describe('turns', () => {
  it('opens one turn per prompt, closing the last as unknown, and ignores calls outside a turn', () => {
    expect(call(config())).toEqual({});
    const a = openTurn(db, { sessionId: 's', project: P });
    const b = openTurn(db, { sessionId: 's', project: P });
    expect(b).toBeGreaterThan(a);
    expect(db.prepare('SELECT outcome FROM econ_turns WHERE id = ?').get(a)).toEqual({ outcome: 'unknown' });
    expect(closeTurn(db, { sessionId: 's' })).toBe('unknown');
    expect(closeTurn(db, { sessionId: 's' })).toBeNull();
  });

  it('feeds the envelope only with main-thread turns that ended green', () => {
    for (let i = 0; i < 2; i++) {
      openTurn(db, { sessionId: 's', project: P });
      foldCall(db, config(), { sessionId: 's', tool: 'Edit', args: { file_path: 'a.ts' }, result: '', failed: false });
      foldCall(db, config(), { sessionId: 's', tool: 'Bash', args: { command: 'npm test' }, result: 'ok', failed: false });
      expect(closeTurn(db, { sessionId: 's' })).toBe('green');
    }
    openTurn(db, { sessionId: 's', project: null });
    foldCall(db, config(), { sessionId: 's', tool: 'Bash', args: { command: 'npm test' }, result: 'ok', failed: false });
    closeTurn(db, { sessionId: 's' });
    openTurn(db, { sessionId: 's', agentId: 'sub', project: P });
    expect(closeTurn(db, { sessionId: 's', agentId: 'sub' })).toBe('unknown');
    expect(greenCalls(db, P)).toEqual([2, 2]);
    expect(greenCalls(db, null)).toEqual([]);
  });

  it('ignores Eklavya\'s own tools and the question card, and does nothing when off', () => {
    expect(ignoredTool('mcp__plugin_eklavya_eklavya__record_attempt')).toBe(true);
    expect(ignoredTool('AskUserQuestion')).toBe(true);
    expect(ignoredTool('Bash')).toBe(false);
    openTurn(db, { sessionId: 's', project: P });
    expect(call(config((c) => (c.economy.loopguard = 'off')))).toEqual({});
    expect(call(config(), { tool: 'AskUserQuestion' })).toEqual({});
  });
});

describe('without a judge', () => {
  const seed = (n: number) => {
    for (let i = 0; i < n; i++) db.prepare('INSERT INTO econ_envelope (project, calls, recorded_at) VALUES (?, 8, ?)').run(P, 'x');
  };

  it('redirects a stuck turn past the envelope once, then notices once, then is quiet', () => {
    seed(5);
    openTurn(db, { sessionId: 's', project: P });
    const outs = spin(config(), 30);
    expect(outs[0]!.context).toContain('[Eklavya loop check] So far this turn');
    expect(outs[1]!.context).toBe(NOTICE);
    expect(outs).toHaveLength(2);
    expect(guardNote(db, 's')).toBe('loop guard: this turn looks stuck');
    expect(guardCounts(db, P, '2000-01-01')).toEqual({ redirect: 1, notice: 1 });
    expect(guardCounts(db, null, '2000-01-01')).toEqual({ redirect: 1, notice: 1 });
  });

  it('stops only a headless turn in stop mode, and never nudges a subagent', () => {
    seed(5);
    openTurn(db, { sessionId: 's', project: P });
    const outs = spin(config((c) => (c.economy.loopguard = 'stop')), 30, { headless: true });
    expect(outs[1]!.stop).toContain('loop guard');
    openTurn(db, { sessionId: 's', agentId: 'sub', project: P });
    expect(spin(config(), 30, { agentId: 'sub' })).toEqual([]);
  });

  it('notices straight away with no nudges allowed, and stays quiet within the envelope', () => {
    seed(5);
    openTurn(db, { sessionId: 's', project: P });
    expect(spin(config((c) => (c.economy.nudges = 0)), 30)[0]!.context).toBe(NOTICE);
    db.prepare('DELETE FROM econ_envelope').run();
    openTurn(db, { sessionId: 's', project: P });
    expect(spin(config(), 12)).toEqual([]);
    expect(guardNote(db, 's')).toBeNull();
  });

  it('shows the note in the status bar, and none from a broken database', () => {
    seed(5);
    openTurn(db, { sessionId: 's', project: P });
    spin(config(), 10);
    expect(guardNote(db, 's')).toBe('loop guard: redirected');
    expect(statusLine({ config: config(), level: 'easy', pinned: false, color: false, note: 'loop guard: redirected' })).toContain('loop guard: redirected');
    db.close();
    expect(guardNote(db, 's')).toBeNull();
  });
});

describe('with a judge', () => {
  const judged = (patch: (c: EklavyaConfig) => void = () => {}) =>
    config((c) => {
      c.providers.judge = { kind: 'anthropic', model: 'claude-haiku-4-5' };
      patch(c);
    });

  it('asks once the gate opens, waits while pending, and redirects on a confident stuck verdict', async () => {
    openTurn(db, { sessionId: 's', project: P });
    const outs = spin(judged(), 10);
    const ask = outs.find((o) => o.judgeTurn);
    expect(ask).toBeDefined();
    expect(outs.filter((o) => o.judgeTurn)).toHaveLength(1);
    const v = await judgeTurn(db, judged(), ask!.judgeTurn!, async (model, prompt, spec) => {
      expect(model).toBe('claude-haiku-4-5');
      expect(prompt).toContain('Recent actions');
      expect(spec.source).toBe('judge');
      return { stuck: true, confidence: 0.9, reason: 'loops', redirect: 'Look at the fixture instead.' };
    });
    expect(v).toMatchObject({ stuck: true });
    expect(call(judged()).context).toBe('[Eklavya loop check] Look at the fixture instead.');
    expect(guardCounts(db, P, '2000-01-01')).toMatchObject({ judge: 1, redirect: 1 });
  });

  it('spares a productive verdict, and asks again once a verdict is out of date', async () => {
    openTurn(db, { sessionId: 's', project: P });
    const id = spin(judged(), 10).find((o) => o.judgeTurn)!.judgeTurn!;
    await judgeTurn(db, judged(), id, async () => ({ stuck: false, confidence: 0.9 }));
    expect(call(judged())).toEqual({});
    let asked = false;
    for (let i = 0; i < VERDICT_CALLS + 1; i++) asked = asked || Boolean(call(judged()).judgeTurn);
    expect(asked).toBe(true);
  });

  it('stores unsure when the judge fails, answers badly, or none is configured', async () => {
    const id = openTurn(db, { sessionId: 's', project: P });
    expect(await judgeTurn(db, judged(), id, async () => 'nonsense')).toMatchObject({ stuck: null, reason: 'the judge answered in the wrong shape' });
    expect(await judgeTurn(db, judged(), id, async () => { throw new Error('quota'); })).toMatchObject({ stuck: null, reason: 'the judge failed: quota' });
    expect(await judgeTurn(db, config(), id, async () => ({}))).toMatchObject({ reason: 'no judge configured' });
    expect(await judgeTurn(db, config(), 999, async () => ({}))).toBeNull();
  });

  it('builds thresholds from the settings', () => {
    expect(thresholdsOf(config((c) => (c.economy.judge_confidence = 0.9))).judge_confidence).toBe(0.9);
  });
});
