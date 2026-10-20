#!/usr/bin/env node
/**
 * The memory token report: what memory put into the model's context, counted
 * from the receipts and read log the product already writes.
 *
 *   sqlite3 ~/.eklavya/knowledge.db ".backup /tmp/knowledge-copy.db"
 *   node eval/memory-tokens.mjs --db /tmp/knowledge-copy.db
 *   node eval/memory-tokens.mjs --db /tmp/knowledge-copy.db --top 20 --json
 *   node eval/memory-tokens.mjs --db /tmp/knowledge-copy.db --since 2026-10-05T08:35:56Z
 *
 * `--since` keeps only receipts and reads at or after that ISO time. Reads were
 * not logged before migration 018, so "followed by a read" is only meaningful
 * from the first `memory_reads` row on; use `--since` to start there.
 *
 * Run it on a COPY. It opens the file through the product's `openDb`, which
 * applies any pending migration, so a live database would be written to.
 *
 * No model calls, no network, nothing in CI. All token counts are the product's
 * own `chars4-v1` estimate (four characters per token), not a tokenizer and not
 * API billing. The comparison line sums the same receipts as `receiptTotals` and runs
 * them through `savingsFrom`, the arithmetic the dashboard and `memory status` use.
 *
 * Read the comparison line carefully. "Base" is the estimated size of the raw
 * evidence (tool output, diffs, prompts) behind the recalled entries, so the
 * percentage compares memory with RE-SENDING THAT RAW HISTORY. It does not
 * compare memory with having no memory: without memory those tokens are never
 * sent at all, so every injected token is added cost, and the benefit has to be
 * earned by the session needing the information.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'mcp', 'dist');
const load = async (rel) => {
  const file = path.join(dist, rel);
  if (!fs.existsSync(file)) {
    console.error(`Missing ${file}. Run \`npm run build\` in mcp/ first.`);
    process.exit(1);
  }
  return import(pathToFileURL(file).href);
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const dbFile = flag('db', null);
const top = Number(flag('top', 10));
const since = flag('since', '0000-01-01');
const asJson = args.includes('--json');
if (!dbFile || !fs.existsSync(dbFile)) {
  console.error('usage: node eval/memory-tokens.mjs --db <copy of knowledge.db> [--top N] [--since ISO] [--json]');
  process.exit(1);
}

const { openDb } = await load('db.js');
const { DELIVERED, NOT_HELPER_RECEIPT } = await load('memory/store.js');
const { savingsFrom } = await load('memory/tokens.js');

const db = openDb(dbFile);

// One row per recall that left a hook. `detail` is what later `memory_get`
// calls were charged to the receipt: it is counted under reads, not injection.
// `followed_linked`: a read named this receipt. `followed_later`: any read in the
// same session at or after the recall, which also catches reads that named no
// receipt. Neither shows the model used what it read.
const receipts = db
  .prepare(
    `SELECT r.session_id AS session, r.scope, r.base_tokens AS base, r.delivered_tokens AS delivered,
            COALESCE((SELECT SUM(sent_tokens) FROM context_receipt_items i
                      WHERE i.receipt_id = r.id AND i.stage = 'detail'), 0) AS detail,
            EXISTS(SELECT 1 FROM memory_reads m WHERE m.receipt_id = r.id) AS followed_linked,
            EXISTS(SELECT 1 FROM memory_reads m WHERE m.session_id = r.session_id
                   AND datetime(m.created_at) >= datetime(r.created_at)) AS followed_later
     FROM context_receipts r WHERE ${DELIVERED} AND ${NOT_HELPER_RECEIPT} AND datetime(r.created_at) >= datetime(?)`,
  )
  .all(since);
// Uptake, the share of sessions with a recall where the model opened a recalled
// entry: a `memory_get` in that session, at or after the recall, whose ids
// include one the receipt listed. Per session, not per block, so a session with
// five recalls counts once.
const uptake = db
  .prepare(
    `SELECT r.session_id AS session,
            EXISTS(SELECT 1 FROM memory_reads m, json_each(m.entry_ids) j, context_receipt_items i
                   WHERE m.tool = 'memory_get' AND m.session_id = r.session_id
                     AND datetime(m.created_at) >= datetime(r.created_at)
                     AND i.receipt_id = r.id AND i.entry_id = j.value) AS opened
     FROM context_receipts r
     WHERE r.session_id IS NOT NULL AND ${DELIVERED} AND ${NOT_HELPER_RECEIPT} AND datetime(r.created_at) >= datetime(?)`,
  )
  .all(since);
const uptakeSessions = new Map();
for (const u of uptake) uptakeSessions.set(u.session, (uptakeSessions.get(u.session) ?? 0) | u.opened);
const sessionsOpened = [...uptakeSessions.values()].filter(Boolean).length;
const reads = db
  .prepare(
    `SELECT session_id AS session, tool, COUNT(*) AS n, COALESCE(SUM(result_tokens), 0) AS tokens
     FROM memory_reads WHERE datetime(created_at) >= datetime(?) GROUP BY session_id, tool`,
  )
  .all(since);
const prepared = db
  .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(delivered_tokens), 0) AS tokens FROM context_receipts WHERE delivery = 'prepared' AND ${NOT_HELPER_RECEIPT} AND datetime(created_at) >= datetime(?)`)
  .get(since);
const span = db.prepare('SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM context_receipts WHERE datetime(created_at) >= datetime(?)').get(since);

const SCOPES = ['session_start', 'prompt', 'file_context'];
const blank = () => ({ injected: { session_start: 0, prompt: 0, file_context: 0, other: 0 }, blocks: 0, followed_linked: 0, followed_later: 0, reads: 0, read_tokens: 0 });
const sessions = new Map();
const of = (id) => {
  const key = id ?? '(no session)';
  if (!sessions.has(key)) sessions.set(key, blank());
  return sessions.get(key);
};
for (const r of receipts) {
  const s = of(r.session);
  s.injected[SCOPES.includes(r.scope) ? r.scope : 'other'] += Math.max(0, r.delivered - r.detail);
  s.blocks++;
  s.followed_linked += r.followed_linked;
  s.followed_later += r.followed_later;
}
const byTool = {};
for (const r of reads) {
  const s = of(r.session);
  s.reads += r.n;
  s.read_tokens += r.tokens;
  byTool[r.tool] = byTool[r.tool] ?? { calls: 0, tokens: 0 };
  byTool[r.tool].calls += r.n;
  byTool[r.tool].tokens += r.tokens;
}

const sum = (f) => [...sessions.values()].reduce((a, s) => a + f(s), 0);
const injectedOf = (s) => Object.values(s.injected).reduce((a, b) => a + b, 0);
const totals = {
  sessions: sessions.size,
  injected: Object.fromEntries([...SCOPES, 'other'].map((k) => [k, sum((s) => s.injected[k])])),
  injected_total: sum(injectedOf),
  recall_blocks: sum((s) => s.blocks),
  blocks_followed_by_linked_read: sum((s) => s.followed_linked),
  blocks_followed_by_any_later_read_in_session: sum((s) => s.followed_later),
  reads: sum((s) => s.reads),
  read_tokens: sum((s) => s.read_tokens),
  reads_by_tool: byTool,
  prepared_never_written: prepared,
  sessions_with_recall: uptakeSessions.size,
  sessions_that_opened_a_recalled_entry: sessionsOpened,
};
totals.blocks_not_followed = totals.recall_blocks - totals.blocks_followed_by_any_later_read_in_session;
totals.memory_tokens_in_context = totals.injected_total + totals.read_tokens;

// The same sum `receiptTotals` makes (delivered receipts, helpers excluded), over
// the same window as everything above.
const base = receipts.reduce((a, r) => a + r.base, 0);
const delivered = receipts.reduce((a, r) => a + r.delivered, 0);
const comparison = {
  base_tokens: base,
  delivered_tokens: delivered,
  result: savingsFrom({ baseTokens: base, deliveredTokens: delivered, delivery: 'emitted' }),
  meaning:
    'Versus re-sending the raw evidence behind the recalled entries. NOT versus no memory: with memory off none of these tokens would be sent.',
};

const ranked = [...sessions.entries()]
  .map(([id, s]) => ({ session: id, ...s, total: injectedOf(s) + s.read_tokens }))
  .sort((a, b) => b.total - a.total);
const report = { generated_at: new Date().toISOString(), window: span, method: 'chars4-v1 (estimate)', totals, comparison, top_sessions: ranked.slice(0, top) };
db.close();

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const n = (v) => Number(v).toLocaleString('en-US');
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
console.log(`Memory token report · receipts ${span.first ?? '-'} to ${span.last ?? '-'} · tokens are chars4-v1 estimates\n`);
console.log(`sessions with memory activity: ${n(totals.sessions)} (helper sessions excluded)`);
console.log('\nInjected by the hooks (what memory added to context, before any read):');
for (const k of [...SCOPES, 'other']) if (k !== 'other' || totals.injected.other) console.log(`  ${k.padEnd(14)}${n(totals.injected[k]).padStart(12)}`);
console.log(`  ${'total'.padEnd(14)}${n(totals.injected_total).padStart(12)}`);
console.log(`  built but never written (not counted above): ${n(prepared.n)} blocks, ${n(prepared.tokens)} tokens`);
console.log('\nSpent on reads (memory_search / memory_get / memory_timeline / memory_file_history results):');
for (const [tool, v] of Object.entries(byTool)) console.log(`  ${tool.padEnd(22)}${n(v.calls).padStart(6)} calls ${n(v.tokens).padStart(10)} tokens`);
console.log(`  ${'total'.padEnd(22)}${n(totals.reads).padStart(6)} calls ${n(totals.read_tokens).padStart(10)} tokens`);
console.log(`\nMemory tokens placed in context, injected + read: ${n(totals.memory_tokens_in_context)}`);
console.log('\nRecall blocks and what followed:');
console.log(`  recall blocks written:                     ${n(totals.recall_blocks)}`);
console.log(`  followed by a read that named the block:   ${n(totals.blocks_followed_by_linked_read)} (${pct(totals.blocks_followed_by_linked_read, totals.recall_blocks)})`);
console.log(`  followed by any read later in the session: ${n(totals.blocks_followed_by_any_later_read_in_session)} (${pct(totals.blocks_followed_by_any_later_read_in_session, totals.recall_blocks)})`);
console.log(`  never followed by a read:                  ${n(totals.blocks_not_followed)} (${pct(totals.blocks_not_followed, totals.recall_blocks)})`);
console.log(`  sessions with a recall that opened a recalled entry (memory_get): ${n(sessionsOpened)} of ${n(uptakeSessions.size)} (${pct(sessionsOpened, uptakeSessions.size)})`);
console.log('  A read shows memory was fetched, not that the answer used it.');
const c = comparison.result;
console.log('\nComparison line (same arithmetic as the dashboard and `eklavya memory status`):');
console.log(`  base ${n(comparison.base_tokens)} tokens of raw evidence vs delivered ${n(comparison.delivered_tokens)}: ` + (c.kind === 'saving' ? `${c.percent}% smaller` : c.kind === 'overhead' ? `${n(c.tokens)} tokens of overhead` : c.kind));
console.log('  That is versus re-sending the raw history. It is NOT a saving versus no memory:');
console.log('  without memory none of the delivered tokens would be sent, so memory adds them,');
console.log('  and pays back only when a session needs an earlier decision, fix or unfinished work.');
console.log(`\nTop ${Math.min(top, ranked.length)} sessions by memory tokens:`);
console.log('session'.padEnd(38) + ['start', 'prompt', 'file', 'reads', 'rd-tok', 'blocks', 'followed'].map((h) => h.padStart(9)).join(''));
for (const s of ranked.slice(0, top)) {
  console.log(
    s.session.slice(0, 36).padEnd(38) +
      [s.injected.session_start, s.injected.prompt, s.injected.file_context, s.reads, s.read_tokens, s.blocks, s.followed_later].map((v) => n(v).padStart(9)).join(''),
  );
}
