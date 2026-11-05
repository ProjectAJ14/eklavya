import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { afterFold, costCommand, factsCommand, foldCommand, guardLine, refreshStale, toolpruneCommand } from '../src/cli-economy.js';
import { compact, openSession } from '../src/ledger-pending.js';
import { foldSession, recordOverhead } from '../src/ledger.js';
import { costBody } from '../src/dashboard.js';
import { SESSION_ENTRY_LIMIT, callReport, costReport, sessionReport } from '../src/cost-report.js';
import { envValues, formRepairs, render } from '../src/economy/envfacts.js';
import { readCalls, readTranscript } from '../src/economy/transcript.js';
import { applyDeny, restoreDeny } from '../src/economy/toolprune.js';
import { foldSessionFacts, fromObservation } from '../src/memory/pinned.js';
import { entryUse, flagStale, foldEntryUse, staleReason } from '../src/memory/use.js';
import { insertEntry, recordReceipt, recordRead, reembedLegacy } from '../src/memory/store.js';
import { recall } from '../src/memory/recall.js';
import { memoryGet, memorySearch } from '../src/tools/memory_read_tools.js';
import { ProviderSummarizer } from '../src/memory/provider.js';

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
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-gaps-')));
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  process.env.EKLAVYA_HOME = path.join(home, 'eh');
  process.env.EKLAVYA_DB = path.join(home, 'eh', 'knowledge.db');
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  process.env.PATH = path.join(home, 'nobin');
  fs.mkdirSync(process.env.EKLAVYA_HOME);
  db = openDb(process.env.EKLAVYA_DB);
  process.chdir(repo);
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
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

describe('small edges', () => {
  it('formats compactly', () => {
    expect([compact(5), compact(1500), compact(2_500_000)]).toEqual(['5', '1.5k', '2.5M']);
  });

  it('families: a fuller interpreter form repairs a bare one, and three ways of asking for a variable', () => {
    expect(formRepairs([
      { tool: 'Bash', input: 'python x.py', output: "ModuleNotFoundError: No module named 'y'", failed: true },
      { tool: 'Bash', input: 'python3 x.py', output: 'ok', failed: false },
      { tool: 'Bash', input: '.venv/bin/python x.py', output: 'ok', failed: false },
    ])).toEqual([expect.objectContaining({ params: expect.objectContaining({ a: 'python', b: '.venv/bin/python' }) })]);
    const asks = (output: string) => envValues([{ tool: 'Bash', input: 'app', output, failed: true }, { tool: 'Bash', input: 'TOKEN_X=1 app', output: 'ok', failed: false }]);
    expect(asks('the environment variable TOKEN_X')).toHaveLength(1);
    expect(asks('TOKEN_X is not set')).toHaveLength(1);
    expect(render('form_repair', { a: 'cd api && pytest', b: 'python -m pytest', error: 'command_missing' })).toBe('`(cd api && pytest …)` fails here with command not found; `python -m pytest …` works.');
  });

  it('transcripts: odd attachments, a tool call without input, and calls without a command', () => {
    const file = path.join(home, 't.jsonl');
    fs.writeFileSync(file, [
      line({ attachment: { type: 'deferred_tools_delta', addedNames: 'x', removedNames: 'y' } }),
      line({ type: 'assistant', message: { id: 'a', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id: 'q', name: 'Bash' }, null, { type: 'tool_use', id: 'r', name: 'WebFetch', input: {} }] } }),
      line({ type: 'user', message: { content: [null, { type: 'tool_result', tool_use_id: 'q', content: [null, { text: 5 }] }, { type: 'tool_result', tool_use_id: 'r', content: 'down' }] } }),
    ].join('\n'));
    expect(readTranscript(file).tools).toEqual({ Bash: 1, WebFetch: 1 });
    expect(readCalls(file)).toEqual([{ tool: 'Bash', input: '', output: '\n', failed: false }, { tool: 'WebFetch', input: '', output: 'down', failed: false }]);
  });

  it('restore works on a file with no permissions at all', () => {
    const settings = path.join(repo, '.claude', 'settings.local.json');
    const r = applyDeny(repo, ['X']) as { record: never };
    fs.writeFileSync(settings, '{}\n');
    expect(restoreDeny(repo, (r as { record: never }).record)).toEqual({ ok: true, removed: [] });
  });

  it('a new fact can start applied', () => {
    foldSessionFacts(db, repo, 's', [{ ...fromObservation({ family: 'env_value', key: 'k', params: { var: 'A', good: '1' }, verdict: 'confirm', exercised: true, applied: true, high: false }) }]);
    expect(db.prepare('SELECT applied FROM pinned_facts').get()).toEqual({ applied: 1 });
  });

  it('re-embedding fails open', () => {
    db.exec('DROP TABLE memory_vectors');
    expect(reembedLegacy(db)).toBe(0);
  });

  it('the cost payload reads a checkout\'s settings or the user\'s', () => {
    expect(JSON.parse(costBody(db, repo)).tools).toMatchObject({ mode: 'propose' });
    expect(JSON.parse(costBody(db, null)).tools).toBeNull();
    expect(JSON.parse(costBody(db, '/not/here')).tools).toMatchObject({ mode: 'propose' });
  });
});

describe('what a call produced', () => {
  const usage = { input: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };
  const call = (link: { batchId?: number; entryId?: number }) => recordOverhead(db, { source: 'observer', model: 'claude-haiku-4-5', usage, costUsd: null, ...link });

  it('reads the entries and the kept evidence of a batch, and says when the batch is gone', () => {
    const batch = Number(db.prepare("INSERT INTO memory_batches (project, session_id, reason, event_count) VALUES (?, 's', 'time', 3)").run(repo).lastInsertRowid);
    const ev = db.prepare("INSERT INTO evidence_events (event_uid, project, session_id, kind, occurred_at, batch_id) VALUES (?, ?, 's', ?, 't', ?)");
    ev.run('e1', repo, 'prompt', batch);
    ev.run('e2', repo, 'file_edit', batch);
    ev.run('e3', repo, 'file_edit', batch);
    const kept = insertEntry(db, { project: repo, batchId: batch, title: 'Kept' });
    const gone = insertEntry(db, { project: repo, batchId: batch, title: 'Gone' });
    db.prepare("UPDATE memory_entries SET deleted_at = 't' WHERE id = ?").run(gone);
    const id = call({ batchId: batch });
    expect(callReport(db, id)).toMatchObject({
      batch_id: batch, entry_id: null, feedback_id: null,
      produced: { kind: 'batch', events: 3, kept: 3, entries: [{ id: kept, title: 'Kept' }], kinds: [{ kind: 'file_edit', n: 2 }, { kind: 'prompt', n: 1 }] },
    });
    db.prepare("DELETE FROM evidence_events WHERE kind = 'file_edit'").run();
    expect(callReport(db, id)!.produced).toMatchObject({ events: 3, kept: 1 });
    expect(callReport(db, call({ batchId: 999 }))!.produced).toEqual({ kind: 'batch', entries: [], events: null, kept: 0, kinds: [] });
  });

  it('reads the entry a refresh rewrote and its replacement, and a feedback item that may be gone', () => {
    const old = insertEntry(db, { project: repo, title: 'Old' });
    const next = insertEntry(db, { project: repo, title: 'New' });
    db.prepare('UPDATE memory_entries SET superseded_by = ? WHERE id = ?').run(next, old);
    expect(callReport(db, call({ entryId: old }))!.produced).toMatchObject({ kind: 'refresh', refreshed: { id: old }, entries: [{ id: next }] });
    expect(callReport(db, call({ entryId: 999 }))!.produced).toEqual({ kind: 'refresh', refreshed: null, entries: [] });
    const fb = call({});
    db.prepare('UPDATE econ_overhead SET feedback_id = 5 WHERE id = ?').run(fb);
    expect(callReport(db, fb)!.produced).toEqual({ kind: 'feedback', exists: false });
    db.prepare("INSERT INTO feedback_items (id, session_id, project, prompt, review, better, tips, rubric, model) VALUES (5, 's', ?, 'p', '{}', 'b', '[]', 2, 'm')").run(repo);
    expect(callReport(db, fb)!.produced).toEqual({ kind: 'feedback', exists: true });
    // A call with no link (a judge, or any row from before migration 042) produced nothing the ledger can name.
    expect(callReport(db, call({}))!.produced).toBeNull();
  });
});

describe('entry use edges', () => {
  it('reads odd file lists, absolute paths, sent-only and opened-only entries', () => {
    fs.writeFileSync(path.join(repo, 'abs.ts'), 'x');
    const bad = insertEntry(db, { project: repo, title: 'Bad files' });
    db.prepare(`UPDATE memory_entries SET files = 'nope' WHERE id = ?`).run(bad);
    const obj = insertEntry(db, { project: repo, title: 'Object files' });
    db.prepare(`UPDATE memory_entries SET files = '{"a":1}' WHERE id = ?`).run(obj);
    const abs = insertEntry(db, { project: repo, title: 'Abs', files: [path.join(repo, 'abs.ts'), '/elsewhere/x.ts'], occurredAt: '2100-01-01T00:00:00Z' });
    const row = (id: number) => db.prepare('SELECT id, project, files, occurred_at FROM memory_entries WHERE id = ?').get(id) as never;
    expect(staleReason(db, repo, row(bad))).toBeNull();
    expect(staleReason(db, repo, row(obj))).toBeNull();
    expect(staleReason(db, repo, row(abs))).toBeNull();
    const receipt = recordReceipt(db, { project: repo, sessionId: 's', scope: 'prompt', method: 'x', delivery: 'emitted', items: [{ entryId: bad, sourceTokens: 1, sentTokens: 1 }] });
    recordRead(db, { tool: 'memory_get', project: repo, sessionId: 's', receiptId: receipt, entryIds: [obj], outcome: 'ok', latencyMs: 1, resultTokens: 1 });
    foldEntryUse(db, config((c) => (c.memory.stale_check = false)), repo, 's', repo);
    expect(db.prepare('SELECT entry_id, sent, opened FROM memory_entry_use ORDER BY entry_id').all()).toEqual([
      { entry_id: bad, sent: 1, opened: 0 },
      { entry_id: obj, sent: 0, opened: 1 },
    ]);
  });

  it('memory tools record query terms, empty or not, and show why an entry may be outdated', () => {
    const id = insertEntry(db, { project: repo, title: 'Retry backoff' });
    flagStale(db, id, 'changed');
    const ctx = { db } as never;
    memorySearch.handler({ query: 'the', cwd: repo }, ctx);
    expect((db.prepare('SELECT query_terms FROM memory_reads').get() as { query_terms: string | null }).query_terms).toBeNull();
    const got = memoryGet.handler({ ids: [id], cwd: repo }, ctx) as { entries: { stale?: unknown }[] };
    expect(got.entries[0]!.stale).toEqual({ reason: 'changed', since: expect.any(String), flagged_by: 'model' });
    expect(entryUse(db, [id]).get(id)!.stale_by).toBe('model');
  });

  it('breaks a seam-query tie by utility', () => {
    const a = insertEntry(db, { project: repo, sessionId: 'x', title: 'Retry backoff jitter', occurredAt: '2026-01-01T00:00:00Z' });
    const b = insertEntry(db, { project: repo, sessionId: 'x', title: 'Retry backoff jitter', occurredAt: '2026-01-01T00:00:00Z' });
    db.prepare(`INSERT INTO memory_entry_use (entry_id, utility, updated_at) VALUES (?, 3, 'x')`).run(b);
    const r = recall(db, config((c) => (c.retrieval.mode = 'keyword')), { project: repo, index: true, seamQuery: 'retry backoff jitter' });
    expect(r.entries[0]!.id).toBe(b);
    expect(a).not.toBe(b);
  });
});

describe('the observer\'s keywords and pinned proposals', () => {
  it('passes both through from the envelope', async () => {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    const reply = { subtype: 'success', is_error: false, structured_output: { observations: [{ title: 'T', type: 'change', narrative: 'n', facts: [], files: [], tags: [], keywords: ['login'] }], pinned: [{ kind: 'decision', text: 'CSV exports use ; as the separator' }] } };
    fs.writeFileSync(path.join(bin, 'r.json'), JSON.stringify(reply));
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ncat >/dev/null\ncat "${path.join(bin, 'r.json')}"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${env.PATH}`;
    const s = new ProviderSummarizer({ kind: 'anthropic', model: 'm' });
    const drafts = await s.summarize({ project: repo, sessionId: 's', events: [{ id: 1, kind: 'prompt', tool: null, title: null, body: 'x', files: null, occurred_at: 't' }] } as never);
    expect(drafts[0]!.keywords).toEqual(['login']);
    expect(drafts.pinned).toEqual([{ kind: 'decision', text: 'CSV exports use ; as the separator' }]);
  });
});

describe('CLI edges', () => {
  const transcript = (sid: string, extra: unknown[] = []) => {
    const file = path.join(home, 'claude', 'projects', 'p', `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      line({ type: 'assistant', message: { id: 'm', model: 'weird-model', usage: { input_tokens: 10 }, content: [] } }),
      line({ type: 'assistant', message: { id: 'e', model: 'claude-haiku-4-5', usage: { input_tokens: 10 }, content: [{ type: 'tool_use', id: 'g', name: 'Agent', input: { subagent_type: 'eklavya:eklavya-explainer' } }] } }),
      line({ type: 'user', toolUseResult: { agentId: 'x' }, message: { content: [{ type: 'tool_result', tool_use_id: 'g' }] } }),
      ...extra.map(line),
    ].join('\n'));
    fs.mkdirSync(path.join(path.dirname(file), sid, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(file), sid, 'subagents', 'agent-x.jsonl'), line({ type: 'assistant', message: { id: 'z', model: 'claude-haiku-4-5', usage: { input_tokens: 4 }, content: [] } }));
    return file;
  };

  const observer = () =>
    fs.writeFileSync(path.join(process.env.EKLAVYA_HOME!, 'config.json'), JSON.stringify({ providers: { observer: { kind: 'anthropic', model: 'm' } } }));

  it('fold names unpriced models, labels a subagent with no end time, and refreshes with the real provider missing', async () => {
    observer();
    const file = transcript('s1');
    openSession(db, { sessionId: 's1', project: repo, transcriptPath: file });
    const id = insertEntry(db, { project: repo, title: 'Old', files: ['a.ts'] });
    flagStale(db, id, 'x');
    await foldCommand(['s1']);
    expect(out).toContain('(unpriced: weird-model)');
    expect(db.prepare(`SELECT source FROM econ_overhead`).get()).toEqual({ source: 'subagent:eklavya:eklavya-explainer' });
    // The real provider is not on the PATH: the refresh is left for later, the fold still succeeds.
    expect(db.prepare('SELECT superseded_by FROM memory_entries WHERE id = ?').get(id)).toEqual({ superseded_by: null });
  });

  it('fold reports a refresh, and refresh copes with an entry without files and a sparse answer', async () => {
    observer();
    openSession(db, { sessionId: 's2', project: repo, transcriptPath: transcript('s2') });
    const a = insertEntry(db, { project: repo, title: 'No files' });
    flagStale(db, a, 'x');
    await foldCommand(['s2'], async () => ({ title: 'New', narrative: 'n', facts: 'x', files: ['b.ts'] }));
    expect(out).toContain('refreshed 1 outdated entry');
    const b = insertEntry(db, { project: repo, title: 'B' });
    const c = insertEntry(db, { project: repo, title: 'C' });
    flagStale(db, b, 'x');
    flagStale(db, c, 'x');
    expect(await refreshStale(db, config(), repo, async () => ({ title: 'N', type: 'bugfix', narrative: 'n' }))).toBe(2);
  });

  it('afterFold outside a checkout, cost lines with nothing priced, and the guard line with notices only', () => {
    const plain = path.join(home, 'plain');
    fs.mkdirSync(plain);
    afterFold(db, config(), { sessionId: 'p', found: true, effective: 1, unpriced: [], project: plain, summary: { tools: {}, deferredTools: [], prompts: 1 } as never, file: null });
    openSession(db, { sessionId: 'z', project: repo, transcriptPath: null });
    db.prepare(`UPDATE econ_sessions SET folded_at = 'x' WHERE session_id = 'z'`).run();
    costCommand(['--all']);
    expect(out).toContain('unknown time  0 effective');
    db.prepare(`INSERT INTO econ_guard_events (at, project, kind) VALUES (?, ?, 'notice')`).run(new Date().toISOString(), repo);
    expect(guardLine(db, repo)).toBe('Loop guard, last 7 days: 0 redirect(s), 1 notice(s), 0 judge call(s)');
  });

  it('toolprune applies named tools and refreshes waiting sessions; facts shows forming and held-back ones', () => {
    for (const sid of ['a', 'b']) {
      openSession(db, { sessionId: sid, project: repo, transcriptPath: null });
      afterFold(db, config(), { sessionId: sid, found: true, effective: 1, unpriced: [], project: repo, summary: { tools: {}, deferredTools: ['CronCreate', 'Monitor'], prompts: 6 } as never, file: null });
    }
    toolpruneCommand(['apply', 'Monitor']);
    expect(out).toContain('Denied Monitor');
    openSession(db, { sessionId: 'waiting', project: repo, transcriptPath: null });
    db.prepare(`UPDATE econ_sessions SET created_at = '2000-01-01' WHERE session_id = 'waiting'`).run();
    toolpruneCommand(['refresh-catalog']);
    expect(out).toContain('Folded 1 waiting session(s)');
    const ev = (key: string, exercised: boolean) => fromObservation({ family: 'env_value', key, params: { var: key, good: '1' }, verdict: 'confirm', exercised, applied: false, high: false });
    foldSessionFacts(db, repo, 's0', [ev('FORMING', false)]);
    for (let i = 0; i < 5; i++) foldSessionFacts(db, repo, `h${i}`, [ev('HELD', true)]);
    out = '';
    factsCommand([]);
    expect(out).toMatch(/\[forming\]/);
    expect(out).toMatch(/\[held back\]/);
    expect(foldSession(db, config(), 'nope').found).toBe(false);
  });
});

describe('the worker keeps observer-proposed facts', () => {
  it('folds them as forming facts only with economy.envfacts observer', async () => {
    const { appendEvent, batchSession } = await import('../src/memory/store.js');
    const { processPending } = await import('../src/memory/worker.js');
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    const reply = { subtype: 'success', is_error: false, structured_output: { observations: [{ title: 'T', type: 'change', narrative: 'n', facts: [], files: [], tags: [] }], pinned: [{ kind: 'decision', text: 'CSV exports use ; as the separator' }, { kind: 'env', text: 'short' }] } };
    fs.writeFileSync(path.join(bin, 'r.json'), JSON.stringify(reply));
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ncat >/dev/null\ncat "${path.join(bin, 'r.json')}"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${env.PATH}`;
    const run = async (sid: string, envfacts: 'observer' | 'free') => {
      appendEvent(db, { eventUid: `u-${sid}`, project: repo, sessionId: sid, kind: 'prompt', body: 'Change the CSV separator' });
      batchSession(db, { project: repo, sessionId: sid, reason: 'session_seam' });
      await processPending(db, config((c) => {
        c.providers.observer = { kind: 'anthropic', model: 'm' };
        c.economy.envfacts = envfacts;
      }));
    };
    await run('w1', 'free');
    expect(db.prepare('SELECT COUNT(*) AS n FROM pinned_facts').get()).toEqual({ n: 0 });
    await run('w2', 'observer');
    expect(db.prepare('SELECT kind, source, state FROM pinned_facts').all()).toEqual([{ kind: 'decision', source: 'observer', state: 'forming' }]);
  });
});

describe('last edges', () => {
  it('splits a doubled separator, keeps a fact a session did not exercise, and counts a first contradiction', async () => {
    const { informativeTerms } = await import('../src/memory/terms.js');
    expect(informativeTerms('retry..backoff')).toEqual(['retry', 'backoff']);
    const { sessionEvidence } = await import('../src/memory/pinned.js');
    const fail = { tool: 'Bash', input: 'python app.py', output: "ModuleNotFoundError: No module named 'y'", failed: true };
    const work = { tool: 'Bash', input: '.venv/bin/python app.py', output: 'ok', failed: false };
    foldSessionFacts(db, repo, 'f1', sessionEvidence(db, repo, [fail, work]));
    foldSessionFacts(db, repo, 'f2', sessionEvidence(db, repo, [{ tool: 'Bash', input: 'ls', output: '', failed: false }]));
    expect(db.prepare('SELECT exercised FROM pinned_facts').get()).toEqual({ exercised: 1 });
    foldSessionFacts(db, repo, 'f3', sessionEvidence(db, repo, [{ tool: 'Bash', input: 'python app.py', output: 'ok', failed: false }]));
    expect(JSON.parse((db.prepare('SELECT params FROM pinned_facts').get() as { params: string }).params).contra_streak).toBe(1);
  });

  it('refresh with nothing flagged does nothing, and fold says how many it refreshed', async () => {
    const withObserver = config((c) => (c.providers.observer = { kind: 'anthropic', model: 'm' }));
    expect(await refreshStale(db, withObserver, repo, async () => ({}))).toBe(0);
    fs.writeFileSync(path.join(process.env.EKLAVYA_HOME!, 'config.json'), JSON.stringify({ providers: { observer: { kind: 'anthropic', model: 'm' } } }));
    for (const t of ['One', 'Two']) flagStale(db, insertEntry(db, { project: repo, title: t }), 'x');
    openSession(db, { sessionId: 'r1', project: repo, transcriptPath: null });
    await foldCommand(['r1'], async () => ({ title: 'New', narrative: 'n' }));
    expect(out).toContain('refreshed 2 outdated entries');
  });

  it('the dashboard report carries facts and what pruning wrote', async () => {
    const { costReport } = await import('../src/cost-report.js');
    foldSessionFacts(db, repo, 'c1', [fromObservation({ family: 'env_value', key: 'k', params: { var: 'A', good: '1' }, verdict: 'confirm', exercised: false, applied: false, high: false })]);
    db.prepare(`INSERT INTO econ_settings_writes (project, record, applied_at) VALUES (?, ?, 'x')`).run(repo, JSON.stringify({ file: 'f', original: null, added: ['X'], excludeLine: null }));
    const r = costReport(db, config(), repo);
    expect(r.facts).toHaveLength(1);
    expect(r.tools!.denied).toEqual(['X']);
    expect(r).toMatchObject({ loopguard: 'nudge', failures_avoided: 0 });
    // A session shown a fact that never ran the failing form counts, in its project only.
    const fid = (db.prepare('SELECT id FROM pinned_facts').get() as { id: number }).id;
    db.prepare(`INSERT INTO pinned_fact_shown (session_id, fact_id, shown_at, avoided) VALUES ('c2', ?, ?, 1)`).run(fid, new Date().toISOString());
    expect(costReport(db, config(), repo).failures_avoided).toBe(1);
    expect(costReport(db, config(), null).failures_avoided).toBe(1);
    expect(costReport(db, config(), '/elsewhere').failures_avoided).toBe(0);
  });
});

describe('coercion and tie-breaks', () => {
  it('coerces the new memory and economy keys, keeping defaults for bad values', async () => {
    const { coerce } = await import('../src/config.js');
    const bad = coerce({ memory: { pinned_facts: 'x', stale_check: 'yes', stale_refresh_per_day: -1 }, economy: { judge_confidence: 2, backstop_mult: Number.NaN, toolprune_protect: 'Bash', nudges: 'one' } }, DEFAULT_CONFIG);
    expect(bad.memory).toMatchObject({ pinned_facts: 8, stale_check: true, stale_refresh_per_day: 5 });
    expect(bad.economy).toMatchObject({ judge_confidence: 0.7, backstop_mult: 2.5, toolprune_protect: [], nudges: 1 });
    const good = coerce({ memory: { pinned_facts: 50, stale_check: false }, economy: { judge_confidence: 0.5, toolprune_protect: ['CronCreate'], ledger: false, loopguard: 'nudge' } }, DEFAULT_CONFIG);
    expect(good.memory).toMatchObject({ pinned_facts: 20, stale_check: false });
    expect(good.economy).toMatchObject({ judge_confidence: 0.5, toolprune_protect: ['CronCreate'], ledger: false, loopguard: 'nudge' });
  });

  it('breaks an equal match with equal utility by recency', () => {
    insertEntry(db, { project: repo, sessionId: 'x', title: 'Retry backoff jitter', occurredAt: '2026-01-01T00:00:00Z' });
    const newer = insertEntry(db, { project: repo, sessionId: 'x', title: 'Retry backoff jitter', occurredAt: '2026-02-01T00:00:00Z' });
    const r = recall(db, config((c) => (c.retrieval.mode = 'keyword')), { project: repo, index: true, seamQuery: 'retry backoff jitter' });
    expect(r.entries[0]!.id).toBe(newer);
  });
});

describe('the catalog follows the Claude Code version, and the dashboard can apply and restore', () => {
  it('drops evidence for tools a new version no longer loads', async () => {
    const { refreshCatalog, recordToolUse, evidence } = await import('../src/toolprune-store.js');
    const t = (version: string | null, deferredTools: string[]) => ({ version, tools: {}, deferredTools, prompts: 3 });
    expect(refreshCatalog(db, repo, t(null, []))).toBe(false);
    for (const [sid, v, tools] of [['a', '2.1.1', ['Old', 'Kept']], ['b', '2.1.1', ['Old', 'Kept']]] as const) {
      openSession(db, { sessionId: sid, project: repo, transcriptPath: null });
      expect(refreshCatalog(db, repo, t(v, [...tools]))).toBe(false);
      recordToolUse(db, repo, sid, t(v, [...tools]));
    }
    expect(refreshCatalog(db, repo, t('2.2.0', ['Kept', 'New']))).toBe(true);
    expect(evidence(db, repo).map((r) => r.tool)).toEqual(['Kept']);
  });

  it('refresh-catalog needs no checkout', () => {
    process.chdir(home);
    toolpruneCommand(['refresh-catalog']);
    expect(out).toContain('across your repositories');
  });

  it('applies and restores through the dashboard\'s write routes, only for a known checkout', async () => {
    const { WRITES } = await import('../src/dashboard.js');
    const { appendEvent } = await import('../src/memory/store.js');
    appendEvent(db, { eventUid: 'inv', project: repo, checkout: repo, sessionId: 'i', kind: 'prompt', body: 'x' });
    for (const sid of ['a', 'b']) {
      openSession(db, { sessionId: sid, project: repo, transcriptPath: null });
      afterFold(db, config(), { sessionId: sid, found: true, effective: 1, unpriced: [], project: repo, summary: { tools: {}, deferredTools: ['CronCreate'], prompts: 6, version: null } as never, file: null });
    }
    const apply = WRITES['/api/toolprune/apply']!.handler;
    const restore = WRITES['/api/toolprune/restore']!.handler;
    expect(apply(db, { project: '/nowhere' })).toMatchObject({ status: 400 });
    expect(apply(db, null)).toMatchObject({ status: 400 });
    expect(apply(db, { project: repo, tools: ['CronCreate', 3] })).toEqual({ status: 200, body: { ok: true, tools: ['CronCreate'] } });
    expect(restore(db, { project: repo })).toEqual({ status: 200, body: { ok: true, tools: ['CronCreate'] } });
    // A restored tool is kept, so nothing is left to apply; a broken file refuses a restore.
    expect(apply(db, { project: repo })).toEqual({ status: 200, body: { ok: true, tools: [] } });
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{ broken');
    db.prepare(`INSERT INTO econ_settings_writes (project, record, applied_at) VALUES (?, ?, 'x')`).run(repo, JSON.stringify({ file: path.join(repo, '.claude', 'settings.local.json'), original: null, added: ['Y'], excludeLine: null }));
    expect(restore(db, { project: repo })).toMatchObject({ status: 409 });
  });
});

describe('the shared session page', () => {
  const evidence = (session: string, files: string[]) =>
    db
      .prepare(
        `INSERT INTO evidence_events (event_uid, project, session_id, kind, files, occurred_at, status, redacted)
         VALUES (?, ?, ?, 'file_edit', ?, '2026-11-02T10:00:00Z', 'accepted', 1)`,
      )
      .run(`${session}-${files.join()}`, repo, session, JSON.stringify(files));

  it('records which recalled entries each session used, once per session and entry', () => {
    const used = insertEntry(db, { project: repo, title: 'Used', files: ['src/a.ts'] });
    const idle = insertEntry(db, { project: repo, title: 'Idle', files: ['src/b.ts'] });
    for (const s of ['u1', 'u2']) {
      recordReceipt(db, { project: repo, sessionId: s, scope: 'prompt', method: 'x', delivery: 'emitted', items: [used, idle].map((entryId) => ({ entryId, sourceTokens: 10, sentTokens: 2 })) });
    }
    evidence('u1', ['src/a.ts']);
    const off = config((c) => (c.memory.stale_check = false));
    foldEntryUse(db, off, repo, 'u1', null);
    foldEntryUse(db, off, repo, 'u1', null);
    foldEntryUse(db, off, repo, 'u2', null);
    expect(db.prepare('SELECT session_id, entry_id FROM memory_session_applied').all()).toEqual([{ session_id: 'u1', entry_id: used }]);
    expect(costReport(db, config(), repo).memory_use.applied).toBe(1);
    expect(costReport(db, config(), '/elsewhere').memory_use.applied).toBe(0);
  });

  it('answers for an id nothing recorded, with every figure empty', () => {
    expect(sessionReport(db, 'nobody')).toEqual({
      session_id: 'nobody',
      known: false,
      cost: null,
      transcript: null,
      tools: {},
      overhead: [],
      memory: {
        recalls: 0, reads: 0, empty_reads: 0,
        sent: { count: 0, entries: [] }, opened: { count: 0, entries: [] }, applied: { count: 0, entries: [] },
        folded: false, captured: 0, pending: 0, redacted: 0, remembered: 0,
      },
      savings: { recall: { kind: 'none' }, failures_avoided: 0, facts_shown: 0, guard: {} },
    });
    // A guard event alone is enough for a session to be known.
    db.prepare(`INSERT INTO econ_guard_events (at, session_id, project, kind) VALUES ('x', 'g1', ?, 'redirect')`).run(repo);
    expect(sessionReport(db, 'g1')).toMatchObject({ known: true, savings: { guard: { redirect: 1 } } });
  });

  it('joins what a session cost, called, was given and gave memory, on its id', () => {
    const file = path.join(home, 'claude', 'projects', '-r', 'p1.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        line({ type: 'user', sessionId: 'p1', cwd: repo, timestamp: '2026-11-02T10:00:00Z', message: { content: 'go' } }),
        line({ type: 'assistant', timestamp: '2026-11-02T10:05:00Z', message: { id: 'a', model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'tool_use', id: 't', name: 'mcp__plugin_eklavya_eklavya__memory_search', input: {} }] } }),
      ].join('\n'),
    );
    openSession(db, { sessionId: 'p1', project: repo, transcriptPath: file });
    foldSession(db, config(), 'p1');
    recordOverhead(db, { source: 'observer', model: 'claude-haiku-4-5', usage: { input: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 }, costUsd: null, sessionId: 'p1', project: repo });
    const sent = insertEntry(db, { project: repo, title: 'Sent', files: ['src/a.ts'] });
    const read = insertEntry(db, { project: repo, title: 'Read' });
    insertEntry(db, { project: repo, sessionId: 'p1', title: 'Captured' });
    recordReceipt(db, { project: repo, sessionId: 'p1', scope: 'prompt', method: 'x', delivery: 'emitted', items: [{ entryId: sent, sourceTokens: 100, sentTokens: 20 }] });
    recordRead(db, { tool: 'memory_get', project: repo, sessionId: 'p1', receiptId: null, entryIds: [read], outcome: 'ok', latencyMs: 1, resultTokens: 1 });
    recordRead(db, { tool: 'memory_search', project: repo, sessionId: 'p1', receiptId: null, entryIds: [], outcome: 'empty', latencyMs: 1, resultTokens: 0 });
    evidence('p1', ['src/a.ts']);
    foldEntryUse(db, config((c) => (c.memory.stale_check = false)), repo, 'p1', null);
    const fact = db
      .prepare(`INSERT INTO pinned_facts (project, fact_key, family, kind, text, source, created_at, updated_at) VALUES (?, 'k', 'form_repair', 'env', 't', 'fold', 'x', 'x')`)
      .run(repo).lastInsertRowid;
    db.prepare(`INSERT INTO pinned_fact_shown (session_id, fact_id, shown_at, avoided) VALUES ('p1', ?, 'x', 1)`).run(fact);

    const r = sessionReport(db, 'p1');
    expect(r.known).toBe(true);
    expect(r.cost).toMatchObject({ project: repo, model: 'claude-sonnet-4-5', prompts: 1, effective: 150, folded: true, unpriced: [] });
    expect(r.cost).not.toHaveProperty('eklavya_tools');
    expect(r.transcript).toEqual({ path: file, on_disk: true });
    expect(r.tools).toEqual({ memory_search: 1 });
    expect(r.overhead).toEqual([{ source: 'observer', calls: 1, effective: 10 }]);
    expect(r.memory).toMatchObject({
      recalls: 1, reads: 2, empty_reads: 1, folded: true, captured: 1, pending: 1, redacted: 1, remembered: 1,
      sent: { count: 1, entries: [{ id: sent, title: 'Sent' }] },
      opened: { count: 1, entries: [{ id: read, title: 'Read' }] },
      applied: { count: 1, entries: [{ id: sent, title: 'Sent' }] },
    });
    expect(r.savings).toEqual({ recall: { kind: 'saving', percent: 80, base: 100, delivered: 20 }, failures_avoided: 1, facts_shown: 1, guard: {} });

    // A deleted transcript keeps its path; unreadable tool counts read as none.
    fs.rmSync(file);
    db.prepare(`UPDATE econ_sessions SET eklavya_tools = 'nope' WHERE session_id = 'p1'`).run();
    expect(sessionReport(db, 'p1')).toMatchObject({ transcript: { path: file, on_disk: false }, tools: {} });
  });

  it('names at most SESSION_ENTRY_LIMIT entries per list and keeps the whole count', () => {
    const items = Array.from({ length: SESSION_ENTRY_LIMIT + 2 }, (_, i) => ({ entryId: insertEntry(db, { project: repo, title: `E${i}` }), sourceTokens: 1, sentTokens: 1 }));
    recordReceipt(db, { project: repo, sessionId: 'big', scope: 'prompt', method: 'x', delivery: 'emitted', items });
    const r = sessionReport(db, 'big');
    expect(r.memory.sent.count).toBe(SESSION_ENTRY_LIMIT + 2);
    expect(r.memory.sent.entries).toHaveLength(SESSION_ENTRY_LIMIT);
    expect(r.cost).toBeNull();
  });
});
