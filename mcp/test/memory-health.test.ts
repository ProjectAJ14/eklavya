import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { memoryHealth, RECENT_SESSIONS } from '../src/memory/health.js';
import { memoryHealthLine } from '../src/hooks/memory-lib.js';
import { lastDropped, spoolBacklog } from '../src/memory/spool.js';

const PROJECT = '/tmp/health-repo';
const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-18T12:00:00Z');
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

let dbFile: string;
let db: DB;
let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  dbFile = tempDbPath('eklavya-health');
  db = openDb(dbFile);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-health-home-'));
  prevHome = process.env.EKLAVYA_HOME;
  process.env.EKLAVYA_HOME = home;
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = prevHome;
});

let n = 0;
function evidence(hoursAgo: number, o: { project?: string; status?: string; tool?: string; session?: string; source?: string; files?: string } = {}): void {
  db.prepare(
    `INSERT INTO evidence_events (event_uid, project, session_id, kind, tool, body, occurred_at, received_at, status, source, files)
     VALUES (?, ?, ?, 'tool_use', ?, 'x', ?, ?, ?, ?, ?)`,
  ).run(`u${++n}`, o.project ?? PROJECT, o.session ?? 's1', o.tool ?? null, ago(hoursAgo), ago(hoursAgo), o.status ?? 'accepted', o.source ?? 'hook', o.files ?? null);
}

// A stall needs a session's worth of evidence, not a straggler or two.
function burst(hoursAgo: number, o: Parameters<typeof evidence>[1] = {}): void {
  for (let i = 0; i < 5; i += 1) evidence(hoursAgo, o);
}

function entry(hoursAgo: number, o: { project?: string; files?: string; importSource?: string } = {}): void {
  db.prepare(
    `INSERT INTO memory_entries (entry_uid, project, title, occurred_at, created_at, files, import_source)
     VALUES (?, ?, 't', ?, ?, ?, ?)`,
  ).run(`e${++n}`, o.project ?? PROJECT, ago(hoursAgo), ago(hoursAgo), o.files ?? null, o.importSource ?? null);
}

function job(status: string, o: { cls?: string | null; error?: string | null; hoursAgo?: number } = {}): void {
  const batch = Number(
    db.prepare("INSERT INTO memory_batches (project, session_id, reason) VALUES (?, 's1', 'manual')").run(PROJECT).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO memory_jobs (batch_id, status, error_class, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(batch, status, o.cls ?? null, o.error ?? null, ago(o.hoursAgo ?? 0), ago(o.hoursAgo ?? 0));
}

function receipt(session: string, scope: string, o: { delivery?: string; project?: string } = {}): void {
  db.prepare(
    `INSERT INTO context_receipts (receipt_uid, project, session_id, scope, method, delivery, created_at)
     VALUES (?, ?, ?, ?, 'chars4-v1', ?, ?)`,
  ).run(`r${++n}`, o.project ?? PROJECT, session, scope, o.delivery ?? 'emitted', ago(1));
}

function read(session: string): void {
  db.prepare("INSERT INTO memory_reads (created_at, project, session_id, tool, outcome) VALUES (?, ?, ?, 'memory_search', 'ok')").run(
    ago(1),
    PROJECT,
    session,
  );
}

const codes = (project?: string) => memoryHealth(db, { project, now: NOW }).reasons.map((r) => r.code);

describe('memory health verdict', () => {
  it('is ok, with no line, for an empty database', () => {
    const h = memoryHealth(db, { now: NOW });
    expect(h).toMatchObject({ verdict: 'ok', reasons: [], line: null });
    expect(h.facts.active).toBe(false);
  });

  it('is ok while work is being turned into entries', () => {
    evidence(2, { status: 'summarized' });
    entry(1);
    evidence(0.2);
    const h = memoryHealth(db, { now: NOW });
    expect(h.verdict).toBe('ok');
    expect(h.facts.active).toBe(true);
  });

  it('warns, then stalls, when work arrives after the last entry and nothing is made of it', () => {
    entry(40);
    burst(8);
    expect(memoryHealth(db, { now: NOW })).toMatchObject({ verdict: 'warn', line: expect.stringMatching(/^Memory behind · nothing new remembered for 8h/) });
    burst(30);
    const h = memoryHealth(db, { now: NOW });
    expect(h.verdict).toBe('stalled');
    expect(h.line).toMatch(/^Memory stalled · nothing new remembered for 30h/);
  });

  it('names the cause of a stall when a job explains it', () => {
    job('failed', { cls: 'auth', hoursAgo: 2 });
    burst(10);
    expect(memoryHealth(db, { now: NOW }).reasons.find((r) => r.code === 'no_entries')?.text).toMatch(
      /^Memory behind · nothing new remembered for 10h while work was captured \(claude not logged in\) · run: eklavya memory status$/,
    );
  });

  it('counts evidence with no entry at all, and ignores imports and rows the entry already covers', () => {
    evidence(30, { source: 'import' });
    expect(memoryHealth(db, { now: NOW }).verdict).toBe('ok');
    burst(30);
    burst(2);
    expect(codes()).toEqual(['no_entries']);
    // An imported entry is not the pipeline working.
    entry(1, { importSource: 'claude-mem' });
    expect(codes()).toEqual(['no_entries']);
    entry(1);
    expect(codes()).toEqual([]);
  });

  it('does not call evidence behind when its batch was quarantined on purpose', () => {
    const batch = Number(
      db.prepare("INSERT INTO memory_batches (project, session_id, reason) VALUES (?, 's1', 'manual')").run(PROJECT).lastInsertRowid,
    );
    db.prepare("INSERT INTO memory_jobs (batch_id, status) VALUES (?, 'quarantined')").run(batch);
    burst(627, { status: 'batched' });
    db.prepare('UPDATE evidence_events SET batch_id = ?').run(batch);
    expect(codes()).toEqual([]);
    burst(30);
    burst(2);
    expect(codes()).toEqual(['no_entries']);
  });

  it('stays quiet for a short session\'s leftovers and for a project nobody has touched in a day', () => {
    for (let i = 0; i < 4; i += 1) evidence(10);
    expect(codes()).toEqual([]);
    evidence(10);
    expect(codes()).toEqual(['no_entries']);
    // Idle: the newest unprocessed event is more than a day old.
    db.prepare('UPDATE evidence_events SET received_at = ?').run(ago(40));
    expect(codes()).toEqual([]);
  });

  it('checks each project against its own newest entry, so a busy one cannot hide a stalled one', () => {
    burst(30, { project: '/tmp/stalled' });
    burst(2, { project: '/tmp/stalled' });
    entry(1);
    expect(codes()).toEqual(['no_entries']);
    expect(codes('/tmp/stalled')).toEqual(['no_entries']);
    expect(codes(PROJECT)).toEqual([]);
  });

  it('stays fast on a project with thousands of entries and unsummarized events', () => {
    const insertEntry = db.prepare(
      `INSERT INTO memory_entries (entry_uid, project, title, occurred_at, created_at) VALUES (?, ?, 't', ?, ?)`,
    );
    const insertEvent = db.prepare(
      `INSERT INTO evidence_events (event_uid, project, session_id, kind, body, occurred_at, received_at, status, source)
       VALUES (?, ?, 's1', 'tool_use', 'x', ?, ?, 'accepted', 'hook')`,
    );
    db.transaction(() => {
      for (let i = 0; i < 12000; i += 1) insertEntry.run(`be${i}`, PROJECT, ago(200), ago(200));
      for (let i = 0; i < 800; i += 1) insertEvent.run(`bu${i}`, PROJECT, ago(2), ago(2));
    })();
    const started = Date.now();
    expect(memoryHealth(db, { now: NOW, project: PROJECT }).facts.behind_since).toBe(ago(2));
    // The old per-row scan of the entries took ~0.5s here (10s on a real project); one pass takes ~2ms.
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('names a login failure from the job error without ever repeating the error text', () => {
    job('paused', { cls: 'transient', error: 'Not logged in · Please run /login https://x.test/?token=SECRET', hoursAgo: 2 });
    const h = memoryHealth(db, { now: NOW });
    expect(h.verdict).toBe('warn');
    expect(h.facts.cause).toBe('claude not logged in');
    expect(JSON.stringify(h)).not.toContain('SECRET');
    expect(h.line).toMatch(/^Memory paused · claude not logged in since \d+ \w{3} · local summaries meanwhile/);
  });

  it('stalls once a pause has lasted a day, and names quota and missing causes', () => {
    job('paused', { cls: 'quota', hoursAgo: 30 });
    const h = memoryHealth(db, { now: NOW });
    expect(h.verdict).toBe('stalled');
    expect(h.line).toMatch(/^Memory stalled · usage limit reached/);
    expect(memoryHealth(db, { now: NOW }).reasons.some((r) => r.code === 'no_entries')).toBe(false);
  });

  it('classes an unknown provider failure plainly', () => {
    job('failed', { cls: 'permanent', error: null, hoursAgo: 1 });
    expect(memoryHealth(db, { now: NOW }).facts.cause).toBe('provider failing');
  });

  it('warns on a recent permanent failure, not an old one, and never on quarantined jobs alone', () => {
    job('quarantined', { hoursAgo: 500 });
    job('failed', { cls: 'permanent', hoursAgo: 24 * 30 });
    const h = memoryHealth(db, { now: NOW });
    expect(h.verdict).toBe('ok');
    expect(h.facts.queue.quarantined).toBe(1);
    job('failed', { cls: 'permanent', hoursAgo: 3 });
    expect(memoryHealth(db, { now: NOW }).line).toMatch(/^Memory · 1 job failed this week \(provider failing\)/);
    job('failed', { cls: 'missing', hoursAgo: 2 });
    expect(memoryHealth(db, { now: NOW }).line).toMatch(/2 jobs failed this week \(claude not found on PATH\)/);
  });

  it('reports a pending queue by age', () => {
    job('pending', { hoursAgo: 7 });
    expect(memoryHealth(db, { now: NOW }).line).toMatch(/^Memory behind · 1 job waiting, oldest 7h · run: eklavya doctor$/);
    job('pending', { hoursAgo: 30 });
    expect(memoryHealth(db, { now: NOW }).line).toMatch(/^Memory stalled · 2 jobs waiting, oldest 30h/);
  });

  it('warns about a spool that stays and events it dropped', () => {
    const dir = path.join(home, 'spool');
    fs.mkdirSync(dir, { recursive: true });
    expect(spoolBacklog()).toEqual({ bytes: 0, files: 0, oldestMs: null });
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, '{}\n');
    fs.writeFileSync(`${file}.taking-1`, '');
    fs.utimesSync(file, new Date(NOW - 5 * HOUR), new Date(NOW - 5 * HOUR));
    fs.writeFileSync(`${file}.taking-2`, '{}\n');
    fs.utimesSync(`${file}.taking-2`, new Date(NOW - 9 * HOUR), new Date(NOW - 9 * HOUR));
    expect(spoolBacklog()).toMatchObject({ files: 2, oldestMs: NOW - 9 * HOUR });
    expect(memoryHealth(db, { now: NOW }).line).toMatch(/^Memory · 2 spooled files not written to the database for 9h/);
    fs.rmSync(`${file}.taking-2`);
    // The previous shape's claimed file still counts, and an unrelated file does not.
    fs.writeFileSync(`${file}.replay-1`, '{}\n');
    fs.writeFileSync(path.join(dir, 'other.txt'), 'x');
    expect(spoolBacklog().files).toBe(2);
    fs.rmSync(`${file}.replay-1`);
    expect(memoryHealth(db, { now: NOW }).line).toMatch(/1 spooled file not written .* for 5h/);
    // A fresh file is a session in flight, not a stuck database.
    fs.utimesSync(file, new Date(NOW), new Date(NOW));
    expect(codes()).toEqual([]);

    expect(lastDropped()).toBeNull();
    fs.writeFileSync(path.join(dir, 'dropped.json'), JSON.stringify({ count: 3, last: ago(2) }));
    expect(memoryHealth(db, { now: NOW }).line).toMatch(/^Memory · 3 events dropped/);
    fs.writeFileSync(path.join(dir, 'dropped.json'), JSON.stringify({ count: 1, last: ago(2) }));
    expect(memoryHealth(db, { now: NOW }).line).toMatch(/^Memory · 1 event dropped/);
    fs.writeFileSync(path.join(dir, 'dropped.json'), JSON.stringify({ count: 1, last: ago(24 * 20) }));
    expect(codes()).toEqual([]);
    fs.writeFileSync(path.join(dir, 'dropped.json'), JSON.stringify({ count: 1 }));
    expect(lastDropped()).toBeNull();
  });

  it('treats recall that was never followed by a read as a warning, not an error', () => {
    for (const s of ['a', 'b']) receipt(s, 'session_start');
    // Two recalls is too few to say anything.
    expect(codes()).toEqual([]);
    receipt('c', 'prompt');
    const h = memoryHealth(db, { now: NOW });
    expect(h.verdict).toBe('warn');
    expect(h.reasons[0]?.text).toBe('Memory · recall reached Claude 3 times in the last 3 sessions and memory_search was never called');
    // A usage observation is not a fault the person can fix: no session-start line.
    expect(h.line).toBeNull();
    expect(h.facts).toMatchObject({ recall_delivered: 3, memory_reads: 0, sessions_checked: 3 });
    read('b');
    expect(codes()).toEqual([]);
  });

  it('counts only delivered recall, only the last sessions, and only this project when asked', () => {
    for (let i = 0; i < RECENT_SESSIONS + 3; i += 1) receipt(`old${i}`, 'session_start');
    // The oldest three sessions fall out of the window.
    expect(memoryHealth(db, { now: NOW }).facts.sessions_checked).toBe(RECENT_SESSIONS);
    receipt('x', 'session_start', { delivery: 'prepared' });
    expect(memoryHealth(db, { now: NOW }).facts.sessions_checked).toBe(RECENT_SESSIONS);
    expect(codes('/tmp/other')).toEqual([]);
    expect(codes(PROJECT)).toEqual(['no_reads']);
  });

  it('flags file context that never fired across reads of files that had history', () => {
    receipt('s1', 'session_start');
    read('s1');
    const names = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
    for (const f of names) evidence(1, { tool: 'Read', files: JSON.stringify([f]) });
    // No entry names these files yet, so there was nothing to inject.
    expect(codes()).not.toContain('no_file_context');
    entry(3, { files: JSON.stringify(names) });
    // The same file read twice in a session is one chance, as the hook injects once.
    evidence(1, { tool: 'Read', files: JSON.stringify([names[0]]) });
    expect(memoryHealth(db, { now: NOW }).reasons[0]?.text).toBe(
      'Memory · file context never fired across 10 reads of files with history in the last 1 session',
    );
    // A subagent's Reads never trigger the hook, so they do not count.
    db.prepare("UPDATE evidence_events SET agent_id = 'sub' WHERE tool = 'Read'").run();
    expect(codes()).not.toContain('no_file_context');
    db.prepare("UPDATE evidence_events SET agent_id = NULL WHERE tool = 'Read'").run();
    // An entry written after the read could not have been injected at it.
    db.prepare('UPDATE memory_entries SET created_at = ?').run(ago(0.5));
    expect(codes()).not.toContain('no_file_context');
    db.prepare('UPDATE memory_entries SET created_at = ?').run(ago(3));
    expect(codes()).toContain('no_file_context');
    receipt('s1', 'file_context');
    expect(codes()).not.toContain('no_file_context');
    expect(memoryHealth(db, { project: '/tmp/other', now: NOW }).verdict).toBe('ok');
  });

  it('puts a stalled reason first and scopes evidence and entries to a project', () => {
    burst(30);
    burst(2);
    for (const s of ['a', 'b', 'c']) receipt(s, 'session_start');
    const h = memoryHealth(db, { now: NOW });
    expect(h.reasons.map((r) => r.level)).toEqual(['stalled', 'warn']);
    expect(h.line).toMatch(/^Memory stalled/);
    expect(memoryHealth(db, { project: '/tmp/other', now: NOW }).verdict).toBe('ok');
  });

  it('degrades to ok on a database it cannot read, and the banner line is null', () => {
    const broken = openDb(tempDbPath('eklavya-health-broken'));
    broken.close();
    expect(memoryHealth(broken, { now: NOW }).verdict).toBe('ok');
    expect(memoryHealthLine(broken)).toBeNull();
  });

  it('reads the real clock when none is given', () => {
    expect(memoryHealth(db).verdict).toBe('ok');
  });
});
