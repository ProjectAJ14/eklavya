import type { DB } from './db.js';
import type { EklavyaConfig } from './config.js';
import { overheadBySource, sessionCosts, weeklyCosts } from './ledger.js';
import { guardCounts } from './loop-guard.js';
import { kept, proposal, writeRecord } from './toolprune-store.js';
import { listFacts } from './memory/pinned.js';
import { staleCounts } from './memory/use.js';

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
      `SELECT occurred_at, project, session_id, source, model, input, cache_read, cache_write_5m, cache_write_1h, output,
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
    guard: guardCounts(db, project, since),
    guard_events: guardEvents,
    memory_use: { recalls, ...reads, ...staleCounts(db, project) },
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
