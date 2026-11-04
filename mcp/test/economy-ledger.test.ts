import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import {
  costCsv,
  foldSession,
  isoWeek,
  meterProviderCalls,
  overheadBySource,
  recordOverhead,
  sessionCosts,
  settingsSnapshot,
  weeklyCosts,
} from '../src/ledger.js';
import { ABANDONED_MS, QUIET_MS, openSession, quietPending, startFold } from '../src/ledger-pending.js';
import { runClaude, setUsageSink, usageFromEnvelope } from '../src/memory/provider.js';
import { economyOff, runtimeCliPath } from '../src/hooks/economy-lib.js';

const config = (patch: (c: EklavyaConfig) => void = () => {}): EklavyaConfig => {
  const c = structuredClone(DEFAULT_CONFIG);
  patch(c);
  return c;
};

let home: string;
let db: DB;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-ledger-'));
  db = openDb(path.join(home, 'knowledge.db'));
});
afterEach(() => {
  setUsageSink(null);
  if (db.open) db.close();
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const line = (o: unknown) => JSON.stringify(o);
function transcript(name: string, extra: string[] = []): string {
  const file = path.join(home, 'projects', '-r', `${name}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      line({ type: 'user', sessionId: name, cwd: '/r', timestamp: '2026-11-02T10:00:00Z', message: { content: 'go' } }),
      line({ type: 'assistant', timestamp: '2026-11-02T10:05:00Z', message: { id: 'a', model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000 }, content: [{ type: 'tool_use', id: 't', name: 'mcp__plugin_eklavya_eklavya__record_attempt', input: {} }, { type: 'tool_use', id: 'g', name: 'Agent', input: { subagent_type: 'eklavya:eklavya-explainer' } }] } }),
      line({ type: 'user', toolUseResult: { agentId: 'x1' }, message: { content: [{ type: 'tool_result', tool_use_id: 'g' }] } }),
      line({ type: 'assistant', message: { id: 'b', model: 'mystery-model', usage: { input_tokens: 5, output_tokens: 1 }, content: [] } }),
      ...extra,
    ].join('\n'),
  );
  fs.mkdirSync(path.join(home, 'projects', '-r', name, 'subagents'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'projects', '-r', name, 'subagents', 'agent-x1.jsonl'),
    line({ type: 'assistant', message: { id: 's', model: 'claude-haiku-4-5', usage: { input_tokens: 40, output_tokens: 4 }, content: [] } }),
  );
  return file;
}

describe('pending sessions', () => {
  it('opens a row once, keeps the first transcript path, and waits for a quiet transcript', () => {
    const file = transcript('s1');
    openSession(db, { sessionId: 's1', project: '/r', transcriptPath: file });
    openSession(db, { sessionId: 's1', project: '/other', transcriptPath: '/elsewhere' });
    openSession(db, { sessionId: 'gone', project: null, transcriptPath: null });
    expect(db.prepare('SELECT project, transcript_path FROM econ_sessions WHERE session_id = ?').get('s1')).toEqual({ project: '/r', transcript_path: file });
    const now = fs.statSync(file).mtimeMs;
    expect(quietPending(db, now + 1000)).toEqual([]);
    expect(quietPending(db, now + QUIET_MS)).toEqual(['s1']);
    expect(quietPending(db, now + QUIET_MS, 's1')).toEqual([]);
    expect(quietPending(db, Date.now() + ABANDONED_MS)).toEqual(['s1', 'gone']);
  });

  it('starts a detached fold, and survives a spawn that throws', () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawn = vi.fn(() => child);
    startFold('/cli.js', ['--pending'], spawn as never);
    expect(spawn).toHaveBeenCalledWith(process.execPath, ['/cli.js', 'fold', '--pending'], expect.objectContaining({ detached: true }));
    child.emit('error', new Error('x'));
    expect(child.unref).toHaveBeenCalled();
    startFold('/cli.js', [], (() => {
      throw new Error('no');
    }) as never);
    // The real spawn is skipped under the test runner.
    startFold('/cli.js', []);
  });

  it('reads the per-session off switch and finds a CLI to run', () => {
    expect(economyOff({ EKLAVYA_ECONOMY: 'off' })).toBe(true);
    expect(economyOff({ EKLAVYA_ECONOMY: '0' })).toBe(true);
    expect(economyOff({})).toBe(false);
    expect(economyOff()).toBe(false);
    const cli = path.join(home, 'cli.js');
    fs.writeFileSync(cli, '');
    expect(runtimeCliPath(cli)).toBe(cli);
    expect(runtimeCliPath(path.join(home, 'missing.js'))).toMatch(/cli\.js$/);
    expect(typeof runtimeCliPath()).toBe('string');
  });
});

describe('folding a session', () => {
  it('prices the transcript, splits out Eklavya\'s share and labels its subagent once', () => {
    const file = transcript('s1');
    openSession(db, { sessionId: 's1', project: '/r', transcriptPath: file });
    const r = foldSession(db, config(), 's1');
    expect(r).toMatchObject({ sessionId: 's1', found: true, effective: 100 + 100 + 50 + 40 + 20, unpriced: ['mystery-model'], project: '/r', file });
    const row = db.prepare('SELECT * FROM econ_sessions WHERE session_id = ?').get('s1') as Record<string, unknown>;
    expect(row).toMatchObject({ project: '/r', model: 'claude-haiku-4-5', prompts: 1, input: 145, quiz_effective: 250, eklavya_effective: 310, unpriced: '["mystery-model"]' });
    expect(JSON.parse(row.settings as string).economy.ledger).toBe(true);
    // Folding again replaces, it does not add.
    foldSession(db, config(), 's1');
    const own = db.prepare('SELECT source, model, effective, in_session FROM econ_overhead').all();
    expect(own).toEqual([{ source: 'subagent:eklavya:eklavya-explainer', model: 'claude-haiku-4-5', effective: 60, in_session: 1 }]);
  });

  it('finds an unknown session\'s transcript by id, prefers a given path, and folds a missing one as empty', () => {
    transcript('s2');
    const env = { CLAUDE_CONFIG_DIR: home };
    expect(foldSession(db, config(), 's2', { env, home }).found).toBe(true);
    const given = transcript('s3');
    expect(foldSession(db, config(), 'other', { transcript: given, project: '/p', env, home }).found).toBe(true);
    const none = foldSession(db, config(), 'nothing', { env, home });
    expect(none).toEqual({ sessionId: 'nothing', found: false, effective: 0, unpriced: [], project: null, summary: null, file: null });
    expect(foldSession(db, config(), 'nothing2', { transcript: path.join(home, 'nope.jsonl') }).found).toBe(false);
    const empty = path.join(home, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    expect(foldSession(db, config(), 'e', { transcript: empty }).found).toBe(false);
    expect(db.prepare('SELECT folded_at IS NOT NULL AS done FROM econ_sessions WHERE session_id = ?').get('nothing')).toEqual({ done: 1 });
  });

  it('snapshots the settings that matter for the on/off comparison', () => {
    expect(JSON.parse(settingsSnapshot(config((c) => (c.memory.enabled = false)))).memory.enabled).toBe(false);
  });
});

describe('Eklavya\'s own calls', () => {
  const envelope = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0 }, total_cost_usd: 0.01, ...extra });

  it('reads usage, the serving model and the reported cost from an envelope', () => {
    expect(usageFromEnvelope('not json', 'm', 'observer')).toBeNull();
    expect(usageFromEnvelope('null', 'm', 'observer')).toBeNull();
    expect(usageFromEnvelope('{}', 'm', 'observer')).toBeNull();
    expect(usageFromEnvelope(envelope(), 'claude-sonnet-5', 'observer')).toMatchObject({ model: 'claude-sonnet-5', costUsd: 0.01, usage: { input: 1000 } });
    const served = usageFromEnvelope(envelope({ total_cost_usd: 'x', modelUsage: { 'claude-haiku-4-5': { outputTokens: 1 }, 'claude-sonnet-5-20261001': { outputTokens: 99 }, odd: {} } }), 'sonnet', 'judge');
    expect(served).toMatchObject({ source: 'judge', model: 'claude-sonnet-5-20261001', costUsd: null });
    expect(usageFromEnvelope(envelope({ modelUsage: { a: null, b: { outputTokens: 2 } } }), 'x', 'o')!.model).toBe('b');
  });

  it.skipIf(process.platform === 'win32')('meters each claude -p call into the ledger when it is on, and not when it is off', async () => {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    const body = envelope({ structured_output: { observations: [] } }).replace(/'/g, `'\\''`);
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${body}'\n`, { mode: 0o755 });
    const origPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${origPath}`;
    try {
      meterProviderCalls(db, config(), { project: '/r', sessionId: 's9' });
      await runClaude('claude-sonnet-5', 'x', { spec: { schema: {}, system: 's', source: 'judge' } });
      await runClaude('claude-sonnet-5', 'x');
      expect(db.prepare('SELECT source, session_id, effective FROM econ_overhead ORDER BY id').all()).toEqual([
        { source: 'judge', session_id: 's9', effective: 1500 },
        { source: 'observer', session_id: 's9', effective: 1500 },
      ]);
      // A ledger that cannot write does not fail the call.
      db.exec('DROP TABLE econ_overhead');
      await expect(runClaude('claude-sonnet-5', 'x')).resolves.toContain('success');
      meterProviderCalls(db, config((c) => (c.economy.ledger = false)));
      await runClaude('claude-sonnet-5', 'x');
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('records rows and sums them per source', () => {
    recordOverhead(db, { source: 'observer', model: 'claude-sonnet-5', usage: { input: 1000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 100 }, costUsd: 0.01, project: '/r' });
    recordOverhead(db, { source: 'judge', model: 'gpt-x', usage: { input: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 1 }, costUsd: null });
    expect(overheadBySource(db, '/r', '2000-01-01')).toEqual([
      { source: 'observer', calls: 1, effective: 1500, unpriced: 0, cost_usd: 0.01 },
      { source: 'judge', calls: 1, effective: 0, unpriced: 1, cost_usd: null },
    ]);
  });
});

describe('reports', () => {
  it('lists sessions, sums weeks and exports CSV that matches', () => {
    for (const [sid, at] of [['a', '2026-11-02T10:00:00Z'], ['b', '2026-11-09T10:00:00Z']] as const) {
      const file = transcript(sid);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('2026-11-02T10:00:00Z', at));
      openSession(db, { sessionId: sid, project: '/r', transcriptPath: file });
      foldSession(db, config(), sid);
    }
    openSession(db, { sessionId: 'unfolded', project: '/r', transcriptPath: null });
    db.prepare(`UPDATE econ_sessions SET started_at = NULL WHERE session_id = 'a'`).run();
    recordOverhead(db, { source: 'observer', model: 'claude-haiku-4-5', usage: { input: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 }, costUsd: null, project: '/r', sessionId: 'b', occurredAt: '2026-11-09T11:00:00Z' });
    const rows = sessionCosts(db, '/r');
    expect(rows.map((r) => r.session_id)).toEqual(['b', 'a']);
    expect(rows[0]!.overhead_effective).toBe(10);
    expect(sessionCosts(db, null, 1)).toHaveLength(1);
    expect(weeklyCosts(db, '/r')).toEqual([{ week: '2026-W46', sessions: 1, effective: 310, eklavya_effective: 310, overhead_effective: 10 }]);
    const csv = costCsv(db, '/r').trim().split('\n');
    expect(csv[0]).toContain('session_id,project,model');
    expect(csv).toHaveLength(3);
    expect(csv[1]).toContain('"[""mystery-model""]"');
    expect(isoWeek('2026-01-01T00:00:00Z')).toBe('2026-W01');
    expect(isoWeek('2027-01-01T00:00:00Z')).toBe('2026-W53');
  });
});
