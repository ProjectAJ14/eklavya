import fs from 'node:fs';
import type { DB } from './db.js';
import type { EklavyaConfig } from './config.js';
import { overheadBySource, sessionCosts, weeklyCosts } from './ledger.js';
import { guardCounts } from './loop-guard.js';
import { kept, proposal, writeRecord } from './toolprune-store.js';
import { listFacts } from './memory/pinned.js';
import { staleCounts } from './memory/use.js';
import { DELIVERED } from './memory/store.js';
import { savingsFrom } from './memory/tokens.js';

/**
 * The dashboard's Cost workflow (issue #259): one payload, every figure from
 * the same rows `eklavya cost --export csv` reads, each tagged with how it
 * was obtained. `measured` comes from transcripts and `claude -p` envelopes;
 * `estimated` is arithmetic on an estimate; `count` is a tally of events.
 */

const DAYS = 30;

export function costReport(db: DB, config: EklavyaConfig, project: string | null, now = Date.now()) {
  const since = new Date(now - DAYS * 86_400_000).toISOString();
  // Every folded session, the rows `eklavya cost --export csv` writes, so the totals match it exactly.
  const all = sessionCosts(db, project, Number.MAX_SAFE_INTEGER);
  const sessions = all.slice(0, 200);
  const overheadRows = db
    .prepare(
      `SELECT id, occurred_at, project, session_id, source, model, input, cache_read, cache_write_5m, cache_write_1h, output,
              effective, unpriced, cost_usd, in_session
       FROM econ_overhead WHERE (? IS NULL OR project = ? OR project IS NULL) ORDER BY occurred_at DESC LIMIT 200`,
    )
    .all(project, project);
  const guardEvents = db
    .prepare(`SELECT at, session_id, project, kind, reason FROM econ_guard_events WHERE (? IS NULL OR project = ?) ORDER BY at DESC LIMIT 200`)
    .all(project, project);
  const reads = db
    .prepare(
      `SELECT COUNT(*) AS reads, COALESCE(SUM(receipt_id IS NOT NULL), 0) AS after_recall, COALESCE(SUM(outcome = 'empty'), 0) AS zero_result
       FROM memory_reads WHERE created_at >= ? AND (? IS NULL OR project = ?)`,
    )
    .get(since, project, project) as { reads: number; after_recall: number; zero_result: number };
  const recalls = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM context_receipts WHERE created_at >= ? AND delivery IN ('emitted', 'confirmed') AND (? IS NULL OR project = ?)`)
      .get(since, project, project) as { n: number }
  ).n;
  const arms = { on: [] as number[], off: [] as number[] };
  for (const s of db
    .prepare(`SELECT effective, settings FROM econ_sessions WHERE folded_at IS NOT NULL AND settings IS NOT NULL AND (? IS NULL OR project = ?)`)
    .all(project, project) as { effective: number; settings: string }[]) {
    (JSON.parse(s.settings).memory?.enabled === false ? arms.off : arms.on).push(s.effective);
  }
  // Estimated: a session shown a FormRepair fact that ran its intent and never its failing form.
  const avoided = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM pinned_fact_shown s JOIN pinned_facts f ON f.id = s.fact_id
         WHERE s.avoided = 1 AND s.shown_at >= ? AND (? IS NULL OR f.project = ?)`,
      )
      .get(since, project, project) as { n: number }
  ).n;
  // Measured: recalled entries a session folded in the window went on to use.
  const applied = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_session_applied a JOIN memory_use_sessions u ON u.session_id = a.session_id
         JOIN memory_entries e ON e.id = a.entry_id WHERE u.folded_at >= ? AND (? IS NULL OR e.project = ?)`,
      )
      .get(since, project, project) as { n: number }
  ).n;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    days: DAYS,
    sessions,
    weeks: weeklyCosts(db, project),
    totals: {
      sessions: all.length,
      effective: sum(all.map((s) => s.effective)),
      eklavya_in_sessions: sum(all.map((s) => s.eklavya_effective)),
      unpriced_sessions: all.filter((s) => s.unpriced).length,
    },
    overhead: overheadBySource(db, project, since),
    overhead_rows: overheadRows,
    loopguard: config.economy.loopguard,
    failures_avoided: avoided,
    guard: guardCounts(db, project, since),
    guard_events: guardEvents,
    memory_use: { recalls, applied, ...reads, ...staleCounts(db, project) },
    experiment: { on: arms.on.length, off: arms.off.length, ran: arms.off.length > 0 },
    tools: project
      ? { mode: config.economy.toolprune, proposed: proposal(db, config, project), denied: writeRecord(db, project)?.added ?? [], kept: kept(db, project) }
      : null,
    facts: project
      ? listFacts(db, project, true).map((f) => ({
          id: f.id, kind: f.kind, source: f.source, state: f.state, text: f.text, confirmations: f.confirmations,
          applied: f.applied, exercised: f.exercised, contradictions: f.contradictions, retired_reason: f.retired_reason,
        }))
      : [],
  };
}

/**
 * One of Eklavya's own model calls (the Cost workflow's call page), or null when there is no such row. It is the
 * ledger row and what its link ids still point at: `econ_overhead` keeps numbers, names and, since migration 042,
 * the id of the batch, entry or feedback item the call served, never the prompt sent or the reply. `produced` is
 * read from rows Eklavya keeps anyway: the entries a batch wrote (deleted ones left out), how many of the events it
 * read are still kept (retention prunes them), the entry a refresh rewrote and its replacement, and whether the
 * feedback item still exists. Null when the row has no link (every row written before 042, every judge call).
 * A refold re-inserts a session's subagent rows under new ids, so an id can stop answering.
 */
export function callReport(db: DB, id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = db
    .prepare(
      `SELECT id, occurred_at, project, session_id, source, model, input, cache_read, cache_write_5m, cache_write_1h, output,
              effective, unpriced, cost_usd, in_session, batch_id, entry_id, feedback_id
       FROM econ_overhead WHERE id = ?`,
    )
    .get(id) as ({ project: string | null; batch_id: number | null; entry_id: number | null; feedback_id: number | null } & Record<string, unknown>) | undefined;
  if (!row) return null;
  const entries = (where: string, param: number) =>
    db.prepare(`SELECT id, title, type FROM memory_entries WHERE ${where} AND deleted_at IS NULL ORDER BY id`).all(param) as {
      id: number;
      title: string;
      type: string | null;
    }[];
  let produced: Record<string, unknown> | null = null;
  if (row.batch_id !== null) {
    const batch = db.prepare('SELECT event_count FROM memory_batches WHERE id = ?').get(row.batch_id) as { event_count: number } | undefined;
    const kinds = db
      .prepare('SELECT kind, COUNT(*) AS n FROM evidence_events WHERE batch_id = ? GROUP BY kind ORDER BY n DESC, kind')
      .all(row.batch_id) as { kind: string; n: number }[];
    produced = {
      kind: 'batch',
      entries: entries('batch_id = ?', row.batch_id),
      // Null when the batch row itself is gone (a removed project, a helper session's sweep).
      events: batch?.event_count ?? null,
      kept: kinds.reduce((a, k) => a + k.n, 0),
      kinds,
    };
  } else if (row.entry_id !== null) {
    produced = {
      kind: 'refresh',
      refreshed: entries('id = ?', row.entry_id)[0] ?? null,
      entries: entries('id = (SELECT superseded_by FROM memory_entries WHERE id = ?)', row.entry_id),
    };
  } else if (row.feedback_id !== null) {
    produced = {
      kind: 'feedback',
      exists: Boolean(db.prepare('SELECT 1 FROM feedback_items WHERE id = ?').get(row.feedback_id)),
    };
  }
  return { ...row, produced };
}

const parse = <T>(text: string | null, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** At most this many entries are named per list on the session page; the counts stay whole. */
export const SESSION_ENTRY_LIMIT = 50;

/**
 * One session as the shared session page reads it, from every workflow: what
 * it cost (measured), where its transcript is, which of Eklavya's tools it
 * called, what memory gave it and what it gave memory, and the savings
 * estimates, each tagged with how it was obtained. Answers for any id: when
 * nothing at all is recorded under it, `known` is false and every figure is empty.
 */
export function sessionReport(db: DB, id: string) {
  const econ = db
    .prepare(
      `SELECT session_id, project, transcript_path, model, started_at, ended_at, prompts, requests, tool_calls, tool_errors,
              input, cache_read, cache_write_5m, cache_write_1h, output, effective, quiz_effective, eklavya_effective,
              eklavya_tools, unpriced, folded_at
       FROM econ_sessions WHERE session_id = ?`,
    )
    .get(id) as (Record<string, unknown> & { transcript_path: string | null; eklavya_tools: string | null; unpriced: string | null }) | undefined;
  const overhead = db
    .prepare(
      `SELECT source, COUNT(*) AS calls, SUM(effective) AS effective FROM econ_overhead
       WHERE session_id = ? AND in_session = 0 GROUP BY source ORDER BY effective DESC`,
    )
    .all(id) as { source: string; calls: number; effective: number }[];
  const entries = (sql: string) =>
    db.prepare(`SELECT e.id, e.title, e.type FROM memory_entries e WHERE e.id IN (${sql}) ORDER BY e.id DESC`).all(id) as {
      id: number;
      title: string;
      type: string | null;
    }[];
  const sent = entries(
    `SELECT i.entry_id FROM context_receipt_items i JOIN context_receipts r ON r.id = i.receipt_id WHERE r.session_id = ? AND r.${DELIVERED}`,
  );
  const opened = entries(
    `SELECT CAST(j.value AS INTEGER) FROM memory_reads m, json_each(m.entry_ids) j WHERE m.session_id = ? AND m.tool = 'memory_get'`,
  );
  const applied = entries('SELECT entry_id FROM memory_session_applied WHERE session_id = ?');
  const receipts = db
    .prepare(
      `SELECT COUNT(*) AS recalls, COALESCE(SUM(base_tokens), 0) AS base, COALESCE(SUM(delivered_tokens), 0) AS delivered
       FROM context_receipts WHERE session_id = ? AND ${DELIVERED}`,
    )
    .get(id) as { recalls: number; base: number; delivered: number };
  const reads = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(outcome = 'empty'), 0) AS empty FROM memory_reads WHERE session_id = ?`)
    .get(id) as { n: number; empty: number };
  const captured = db
    .prepare(
      `SELECT COUNT(*) AS events, COALESCE(SUM(status != 'summarized'), 0) AS pending, COALESCE(SUM(redacted), 0) AS redacted
       FROM evidence_events WHERE session_id = ?`,
    )
    .get(id) as { events: number; pending: number; redacted: number };
  const remembered = (
    db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE session_id = ? AND deleted_at IS NULL').get(id) as { n: number }
  ).n;
  const facts = db
    .prepare('SELECT COUNT(*) AS shown, COALESCE(SUM(avoided = 1), 0) AS avoided FROM pinned_fact_shown WHERE session_id = ?')
    .get(id) as { shown: number; avoided: number };
  const guard = Object.fromEntries(
    (db.prepare('SELECT kind, COUNT(*) AS n FROM econ_guard_events WHERE session_id = ? GROUP BY kind').all(id) as { kind: string; n: number }[]).map(
      (r) => [r.kind, r.n],
    ),
  ) as Record<string, number>;
  const useFolded = Boolean(db.prepare('SELECT 1 FROM memory_use_sessions WHERE session_id = ?').get(id));
  const transcript = econ?.transcript_path ?? null;
  const cap = <T>(xs: T[]) => xs.slice(0, SESSION_ENTRY_LIMIT);
  return {
    session_id: id,
    // Whether Eklavya recorded anything under this id: a session the learning half alone knows is still a session.
    known: Boolean(econ || overhead.length || receipts.recalls || reads.n || captured.events || remembered || facts.shown || Object.keys(guard).length),
    cost: econ ? (({ eklavya_tools: _tools, ...row }) => ({ ...row, unpriced: parse<string[]>(row.unpriced, []), folded: row.folded_at !== null }))(econ) : null,
    transcript: transcript ? { path: transcript, on_disk: fs.existsSync(transcript) } : null,
    // Measured: from the transcript at fold time, names and counts only.
    tools: parse<Record<string, number>>(econ?.eklavya_tools ?? null, {}),
    overhead,
    memory: {
      recalls: receipts.recalls,
      reads: reads.n,
      empty_reads: reads.empty,
      sent: { count: sent.length, entries: cap(sent) },
      opened: { count: opened.length, entries: cap(opened) },
      applied: { count: applied.length, entries: cap(applied) },
      folded: useFolded,
      captured: captured.events,
      pending: captured.pending,
      redacted: captured.redacted,
      remembered,
    },
    savings: {
      recall: savingsFrom({ baseTokens: receipts.base, deliveredTokens: receipts.delivered, delivery: receipts.recalls ? 'emitted' : 'unknown' }),
      failures_avoided: facts.avoided,
      facts_shown: facts.shown,
      guard,
    },
  };
}
