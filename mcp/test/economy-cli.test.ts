import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import {
  afterFold,
  costCommand,
  experimentCommand,
  experimentReport,
  factsCommand,
  foldCommand,
  guardLine,
  judgeCommand,
  refreshStale,
  stepExperiment,
  toolpruneCommand,
} from '../src/cli-economy.js';
import { foldSession, recordOverhead } from '../src/ledger.js';
import { compact, lastSessionLine, openSession } from '../src/ledger-pending.js';
import { costReport } from '../src/cost-report.js';
import { entryUse, flagStale, foldEntryUse, staleCounts, staleReason } from '../src/memory/use.js';
import { appendEvent, insertEntry, recordReceipt, recordRead } from '../src/memory/store.js';
import { recall } from '../src/memory/recall.js';
import { openTurn } from '../src/loop-guard.js';
import { memoryFlagStale } from '../src/tools/memory_write_tools.js';
import { readCalls } from '../src/economy/transcript.js';

const config = (patch: (c: EklavyaConfig) => void = () => {}): EklavyaConfig => {
  const c = structuredClone(DEFAULT_CONFIG);
  patch(c);
  return c;
};

let home: string;
let repo: string;
let db: DB;
let out: string;
const env = { ...process.env };
const cwd = process.cwd();

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-ecli-')));
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  process.env.EKLAVYA_HOME = path.join(home, 'eh');
  process.env.EKLAVYA_DB = path.join(home, 'eh', 'knowledge.db');
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  fs.mkdirSync(process.env.EKLAVYA_HOME);
  db = openDb(process.env.EKLAVYA_DB);
  process.chdir(repo);
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    out += String(s);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
    out += String(s);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  process.env = { ...env };
  if (db.open) db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const line = (o: unknown) => JSON.stringify(o);
function transcript(sid: string, extra: string[] = []): string {
  const file = path.join(home, 'claude', 'projects', 'p', `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      line({ type: 'user', sessionId: sid, timestamp: '2026-11-02T10:00:00Z', message: { content: 'go' } }),
      line({ type: 'assistant', timestamp: '2026-11-02T10:05:00Z', message: { id: `m-${sid}`, model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pytest' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'bash: pytest: command not found' }] } }),
      line({ type: 'assistant', message: { id: `n-${sid}`, model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'python -m pytest' } }, { type: 'tool_use', id: 'w', name: 'WebFetch', input: { url: 'https://x.io' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b2', content: [{ type: 'text', text: '2 passed' }, 'x'] }, { type: 'tool_result', tool_use_id: 'w', content: 3 }, { type: 'tool_result', tool_use_id: 'zz' }] } }),
      line({ type: 'user', isSidechain: true, message: { content: [] } }),
      line({ attachment: { type: 'deferred_tools_delta', addedNames: ['CronCreate'] } }),
      ...extra,
    ].join('\n'),
  );
  return file;
}

describe('eklavya fold', () => {
  it('prices a session, feeds tool evidence and facts, and reports what it did', async () => {
    const file = transcript('s1');
    openSession(db, { sessionId: 's1', project: repo, transcriptPath: file });
    await foldCommand(['s1', '--transcript', file]);
    expect(out).toContain('s1: 156 effective tokens');
    expect(db.prepare('SELECT COUNT(*) AS n FROM econ_tool_use WHERE project = ?').get(repo)).toEqual({ n: 3 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM pinned_facts').get()).toEqual({ n: 1 });
    expect(readCalls(file).map((c) => c.tool)).toEqual(['Bash', 'Bash', 'WebFetch']);
  });

  it('folds quiet pending sessions, and refuses a bare call', async () => {
    openSession(db, { sessionId: 'gone', project: null, transcriptPath: null });
    db.prepare(`UPDATE econ_sessions SET created_at = '2000-01-01' WHERE session_id = 'gone'`).run();
    await foldCommand(['--pending']);
    expect(out).toContain('gone: no usage found');
    await expect(foldCommand([])).rejects.toThrow('exit 1');
  });

  it('afterFold: skips without a project, writes the deny list in on mode when the repo is quiet, and survives a failing part', () => {
    afterFold(db, config(), { sessionId: 'x', found: false, effective: 0, unpriced: [], project: null, summary: null, file: null });
    const summary = { tools: {}, deferredTools: ['CronCreate'], prompts: 6 } as never;
    for (const sid of ['a', 'b']) {
      openSession(db, { sessionId: sid, project: repo, transcriptPath: null });
      db.prepare(`UPDATE econ_sessions SET ended_at = '2026-01-01T00:00:00Z' WHERE session_id = ?`).run(sid);
      afterFold(db, config((c) => (c.economy.toolprune = 'on')), { sessionId: sid, found: true, effective: 1, unpriced: [], project: repo, summary, file: null });
    }
    expect(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8')).toContain('CronCreate');
    db.exec('DROP TABLE econ_tool_use');
    expect(() => afterFold(db, config(), { sessionId: 'c', found: true, effective: 1, unpriced: [], project: repo, summary, file: '/nope' })).not.toThrow();
  });
});

describe('eklavya cost', () => {
  const seed = () => {
    const file = transcript('s1');
    openSession(db, { sessionId: 's1', project: repo, transcriptPath: file });
    foldSession(db, config(), 's1');
    db.prepare(`UPDATE econ_sessions SET unpriced = '["odd"]' WHERE session_id = 's1'`).run();
    recordOverhead(db, { source: 'observer', model: 'claude-sonnet-5', usage: { input: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 1 }, costUsd: 0.5, project: repo });
    recordOverhead(db, { source: 'judge', model: 'odd', usage: { input: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 1 }, costUsd: null, project: repo });
    db.prepare(`INSERT INTO econ_guard_events (at, project, kind) VALUES (?, ?, 'redirect'), (?, ?, 'stop')`).run(new Date().toISOString(), repo, new Date().toISOString(), repo);
  };

  it('lists sessions, weeks and a CSV, and Eklavya\'s own calls', () => {
    costCommand([]);
    expect(out).toContain('No folded sessions yet');
    seed();
    out = '';
    costCommand(['--limit', '5']);
    expect(out).toMatch(/156 effective on claude-sonnet-4-5 .*unpriced: odd/);
    expect(out).toContain('Loop guard, last 7 days: 1 redirect(s), 0 notice(s), 0 judge call(s), 1 headless stop(s)');
    expect(out).toContain('observer: 1 call(s) · 15 effective · $0.50 as reported');
    expect(out).toContain('judge: 1 call(s) · 0 effective · 1 unpriced');
    out = '';
    costCommand(['--all', '--by-week']);
    expect(out).toContain('2026-W45  1 session(s)');
    out = '';
    costCommand(['--export', 'csv']);
    expect(out.split('\n')[0]).toContain('session_id');
    expect(() => costCommand(['--export', 'json'])).toThrow('exit 1');
    expect(() => costCommand(['--limit', '0'])).toThrow('exit 1');
    db.prepare('DELETE FROM econ_sessions').run();
    db.prepare('DELETE FROM econ_overhead').run();
    out = '';
    costCommand(['--by-week']);
    expect(out).toContain('No folded sessions yet.');
    expect(guardLine(db, '/elsewhere')).toBeNull();
  });

  it('the dashboard report matches the CSV totals', () => {
    seed();
    const r = costReport(db, config(), repo);
    expect(r.totals.effective).toBe(156);
    expect(r.tools).toMatchObject({ mode: 'propose' });
    expect(costReport(db, config(), null).tools).toBeNull();
    db.prepare(`UPDATE econ_sessions SET settings = '{"memory":{"enabled":false}}'`).run();
    expect(costReport(db, config(), repo).experiment).toEqual({ on: 0, off: 1, ran: true });
  });

  it('the banner line names the last session, the guard and pruning since', () => {
    expect(lastSessionLine(db, repo, null)).toBeNull();
    seed();
    db.prepare(`UPDATE econ_sessions SET ended_at = '2000-01-01'`).run();
    db.prepare(`INSERT INTO econ_settings_writes (project, record, applied_at) VALUES (?, ?, ?)`).run(repo, '{"added":["X"]}', new Date().toISOString());
    expect(lastSessionLine(db, repo, null)).toBe('Last session · 156 effective tokens on claude-sonnet-4-5 (part unpriced) · Eklavya 0% · loop guard stepped in 2× · 1 tool(s) pruned');
    db.prepare(`UPDATE econ_sessions SET effective = 0, model = NULL, unpriced = NULL, ended_at = NULL`).run();
    db.prepare('DELETE FROM econ_guard_events').run();
    db.prepare('DELETE FROM econ_settings_writes').run();
    expect(lastSessionLine(db, repo, null)).toBe('Last session · 0 effective tokens · Eklavya 0%');
    expect(compact(2_500_000)).toBe('2.5M');
  });
});

describe('eklavya judge, toolprune, facts and experiment', () => {
  it('judges a turn and refuses a bad id', async () => {
    const id = openTurn(db, { sessionId: 's', project: repo });
    await judgeCommand([String(id)]);
    expect(out).toContain('no judge configured');
    await judgeCommand(['999']);
    expect(out).toContain('No turn 999.');
    await expect(judgeCommand(['x'])).rejects.toThrow('exit 1');
  });

  it('lists, applies, measures, restores and refreshes', () => {
    toolpruneCommand([]);
    expect(out).toContain('Nothing to propose yet');
    for (const sid of ['a', 'b']) {
      openSession(db, { sessionId: sid, project: repo, transcriptPath: null });
      afterFold(db, config(), { sessionId: sid, found: true, effective: 1, unpriced: [], project: repo, summary: { tools: {}, deferredTools: ['CronCreate'], prompts: 6 } as never, file: null });
    }
    out = '';
    toolpruneCommand(['list']);
    expect(out).toContain('CronCreate  unused for 12 prompt(s) across 2 session(s)');
    toolpruneCommand(['measure']);
    expect(out).toContain('1 tool(s) proposed, 1 of them deferred');
    toolpruneCommand(['apply']);
    expect(out).toContain('Denied');
    out = '';
    toolpruneCommand(['apply']);
    expect(out).toContain('Nothing to deny.');
    toolpruneCommand(['list']);
    expect(out).toContain('Denied by Eklavya');
    toolpruneCommand(['restore', 'CronCreate']);
    expect(out).toContain('Restored CronCreate');
    toolpruneCommand(['restore']);
    expect(out).toContain('Nothing of Eklavya\'s to restore.');
    toolpruneCommand(['refresh-catalog']);
    expect(out).toContain('tool(s) seen loaded across your repositories');
    expect(() => toolpruneCommand(['bogus'])).toThrow('exit 1');
    fs.writeFileSync(path.join(process.env.EKLAVYA_HOME!, 'config.json'), JSON.stringify({ economy: { toolprune: 'off' } }));
    expect(() => toolpruneCommand(['apply'])).toThrow('exit 1');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{ bad');
    db.prepare(`INSERT INTO econ_settings_writes (project, record, applied_at) VALUES (?, ?, 'x')`).run(repo, JSON.stringify({ file: path.join(repo, '.claude', 'settings.local.json'), original: null, added: ['Y'], excludeLine: null }));
    expect(() => toolpruneCommand(['restore'])).toThrow('exit 1');
    process.chdir(home);
    expect(() => toolpruneCommand([])).toThrow('exit 1');
  });

  it('lists and retires facts', () => {
    factsCommand([]);
    expect(out).toContain('None yet');
    for (const s of ['a', 'b', 'c']) {
      afterFold(db, config(), { sessionId: s, found: true, effective: 1, unpriced: [], project: repo, summary: { tools: {}, deferredTools: [], prompts: 1 } as never, file: transcript(s) });
    }
    out = '';
    factsCommand([]);
    expect(out).toMatch(/#1 \[.*shown.*\] `pytest …` fails here/);
    factsCommand(['retire', '1']);
    expect(out).toContain('Retired #1.');
    expect(() => factsCommand(['retire', '1'])).toThrow('exit 1');
    expect(() => factsCommand(['retire', 'x'])).toThrow('exit 1');
    out = '';
    factsCommand(['--all']);
    expect(out).toContain('retired by hand');
  });

  it('runs a memory on/off experiment and puts the setting back', () => {
    expect(() => experimentCommand([])).toThrow('exit 1');
    expect(() => experimentCommand(['memory', '--sessions', '1'])).toThrow('exit 1');
    experimentCommand(['memory', '--sessions', '3']);
    expect(out).toContain('Started');
    expect(() => experimentCommand(['memory'])).toThrow('exit 1');
    const projectConfig = () => fs.readdirSync(path.join(process.env.EKLAVYA_HOME!, 'projects')).map((d) => JSON.parse(fs.readFileSync(path.join(process.env.EKLAVYA_HOME!, 'projects', d, 'config.json'), 'utf8')));
    stepExperiment(db, repo);
    expect(projectConfig()[0].memory.enabled).toBe(true);
    stepExperiment(db, repo);
    expect(projectConfig()[0].memory.enabled).toBe(false);
    stepExperiment(db, repo);
    expect(projectConfig()[0].memory.enabled).toBe(true);
    stepExperiment(db, repo);
    out = '';
    experimentCommand(['memory', '--stop']);
    expect(out).toContain('No experiment running here.');
    experimentCommand(['memory', '--sessions', '4']);
    experimentCommand(['memory', '--stop']);
    expect(out).toContain('Stopped');
    for (const [sid, on, eff] of [['a', true, 100], ['b', true, 300], ['c', false, 50]] as const) {
      openSession(db, { sessionId: sid, project: repo, transcriptPath: null });
      db.prepare(`UPDATE econ_sessions SET folded_at = 'x', effective = ?, prompts = 2, settings = ? WHERE session_id = ?`).run(eff, JSON.stringify({ memory: { enabled: on } }), sid);
    }
    expect(experimentReport(db, repo)).toContain('memory on: 2 session(s), median 200 effective tokens, median 2 prompt(s)');
    expect(experimentReport(db, '/none')).toContain('memory on: 0 session(s), median 0');
    out = '';
    experimentCommand(['memory', '--report']);
    expect(out).toContain('memory off: 1 session(s)');
  });
});

describe('entry use and stale context', () => {
  const entry = (title: string, files: string[], at = '2026-01-01T00:00:00Z', type = 'change') =>
    insertEntry(db, { project: repo, sessionId: 'old', title, type, files, occurredAt: at });

  it('counts sent, opened and applied once per session, and ranks a used entry higher', () => {
    fs.writeFileSync(path.join(repo, 'a.ts'), 'x');
    const a = entry('Retry backoff', ['a.ts']);
    const b = entry('Other thing', ['b.ts']);
    const receipt = recordReceipt(db, { project: repo, sessionId: 's1', scope: 'prompt', method: 'x', delivery: 'emitted', items: [{ entryId: a, sourceTokens: 1, sentTokens: 1 }, { entryId: b, sourceTokens: 1, sentTokens: 1 }] });
    recordRead(db, { tool: 'memory_get', project: repo, sessionId: 's1', receiptId: receipt, entryIds: [a], outcome: 'ok', latencyMs: 1, resultTokens: 1 });
    appendEvent(db, { eventUid: 'e1', project: repo, sessionId: 's1', kind: 'file_edit', body: 'edit', files: ['a.ts'] });
    foldEntryUse(db, config(), repo, 's1', repo);
    foldEntryUse(db, config(), repo, 's1', repo);
    const use = entryUse(db, [a, b]);
    expect(use.get(a)).toMatchObject({ utility: 1 });
    expect(use.get(b)).toMatchObject({ utility: 0 });
    expect(db.prepare('SELECT sent, opened, applied FROM memory_entry_use WHERE entry_id = ?').get(a)).toEqual({ sent: 1, opened: 1, applied: 1 });
    expect(entryUse(db, [])).toEqual(new Map());
  });

  it('flags a deleted file, many commits, a newer decision and an entry never used', () => {
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, 'k.ts'), '1');
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(repo, 'k.ts'), String(i));
      git('add', '.');
      git('commit', '-qm', `c${i}`);
    }
    const gone = entry('Gone', ['missing.ts']);
    const churned = entry('Churned', ['k.ts'], '2000-01-01T00:00:00Z');
    const covered = entry('Covered', ['k.ts'], '2100-01-01T00:00:00Z');
    entry('Newer decision', ['k.ts'], '2100-02-01T00:00:00Z', 'decision');
    const row = (id: number) => db.prepare('SELECT id, project, files, occurred_at FROM memory_entries WHERE id = ?').get(id) as never;
    expect(staleReason(db, repo, row(gone))).toContain('missing.ts was deleted or renamed');
    expect(staleReason(db, repo, row(churned))).toContain('3 commits to them');
    expect(staleReason(db, null, row(covered))).toMatch(/a newer decision \(#\d+\) covers the same files/);
    expect(staleReason(db, repo, { ...row(gone), files: null } as never)).toBeNull();
    // Five sends, never applied.
    const idle = entry('Idle', ['k.ts'], '2100-03-01T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      recordReceipt(db, { project: repo, sessionId: `t${i}`, scope: 'prompt', method: 'x', delivery: 'emitted', items: [{ entryId: idle, sourceTokens: 1, sentTokens: 1 }] });
      foldEntryUse(db, config(), repo, `t${i}`, null);
    }
    expect(entryUse(db, [idle]).get(idle)!.stale_reason).toBe('sent 5 times and never used');
    foldEntryUse(db, config((c) => (c.memory.stale_check = false)), repo, 'z', null);
    // Another project's entry and a deleted id are skipped.
    const foreign = insertEntry(db, { project: '/other', title: 'F' });
    recordReceipt(db, { project: '/other', sessionId: 'u', scope: 'prompt', method: 'x', delivery: 'emitted', items: [{ entryId: foreign, sourceTokens: 1, sentTokens: 1 }] });
    foldEntryUse(db, config(), repo, 'u', null);
    expect(entryUse(db, [foreign]).size).toBe(0);
  });

  it('down-ranks and labels a flagged entry in recall, and the model can flag one', () => {
    const a = entry('Alpha work', ['a.ts'], '2026-01-02T00:00:00Z');
    entry('Beta work', ['b.ts'], '2026-01-01T00:00:00Z');
    flagStale(db, a, 'retry.ts now uses a token bucket');
    const block = recall(db, config(), { project: repo, index: true }).block!;
    expect(block).toContain('may be outdated (retry.ts now uses a token bucket)');
    expect(block.indexOf('Beta work')).toBeLessThan(block.lastIndexOf('Alpha work'));
    expect(recall(db, config((c) => (c.memory.stale_check = false)), { project: repo, index: true }).block).not.toContain('may be outdated');
    expect(staleCounts(db, repo)).toEqual({ flagged: 1, refreshed: 0 });
    const ctx = { db } as never;
    expect(memoryFlagStale.handler({ id: a, reason: 'changed', cwd: repo }, ctx)).toEqual({ id: a, flagged: true, reason: 'changed' });
    expect(memoryFlagStale.handler({ id: 999, reason: 'x', cwd: repo }, ctx)).toMatchObject({ error: 'not_found' });
    const other = insertEntry(db, { project: '/other', title: 'F' });
    expect(memoryFlagStale.handler({ id: other, reason: 'x', cwd: repo }, ctx)).toMatchObject({ error: 'other_project' });
  });

  it('refreshes flagged entries within the daily quota, superseding them', async () => {
    const a = entry('Old', ['a.ts']);
    const b = entry('Old too', ['b.ts']);
    const c = entry('Old three', ['c.ts']);
    for (const id of [a, b, c]) flagStale(db, id, 'changed');
    const withObserver = config((x) => (x.memory.stale_refresh_per_day = 2));
    expect(await refreshStale(db, config((x) => (x.providers.observer = null)), repo, async () => ({}))).toBe(0);
    let calls = 0;
    const n = await refreshStale(db, withObserver, repo, async (_m, prompt, spec) => {
      calls++;
      expect(spec.source).toBe('stale_refresh');
      expect(prompt).toContain('<changes>');
      return calls === 1 ? { title: 'New', type: 'change', narrative: 'Now true.', facts: ['f', 3], files: [] } : { title: '' };
    });
    expect(n).toBe(1);
    expect(db.prepare('SELECT superseded_by IS NOT NULL AS s FROM memory_entries WHERE id = ?').get(a)).toEqual({ s: 1 });
    // One refresh used today; a second run may do one more, and a throw leaves it flagged.
    expect(await refreshStale(db, withObserver, repo, async () => { throw new Error('quota'); })).toBe(0);
    expect(await refreshStale(db, config((x) => (x.memory.stale_refresh_per_day = 0)), repo, async () => ({}))).toBe(0);
    expect(staleCounts(db, null)).toMatchObject({ refreshed: 1 });
  });
});
