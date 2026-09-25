/**
 * `eklavya dashboard` — the learning state as a local web page.
 *
 * The terminal report has to fit in twenty lines, so it answers "what now?".
 * This answers "am I getting better?", which needs history, per-project
 * comparison, per-concept history and the full concept list — none of which fit
 * in a paragraph.
 *
 * Deliberately a static page plus one JSON endpoint: no framework, no build
 * step, same rule the landing page follows. It binds to loopback only, which
 * is the whole security model — the data never leaves the machine, and that
 * is a promise the landing page makes on Eklavya's behalf.
 *
 * The endpoint ships mostly *flat rows* — every attempt, every logged context,
 * one row per day — and lets the page derive the views. One aggregate query per
 * card is a coupling to the layout: the sessions view, the streak, the per-day
 * heatmap and the per-concept history are four readings of the same attempt
 * rows, and adding a fifth view should not mean adding a fifth query. The whole
 * payload for a heavy year of use is a few hundred kilobytes over loopback.
 */
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.js';
import { decayedScore, isDue, isKnown, MS_PER_DAY } from './srs.js';
import { GLOBAL_PROJECT, levelStanding, PASSING_GRADE, projectKey } from './store.js';
import { loadConfig, DEFAULT_CONFIG, type EklavyaConfig } from './config.js';
import { dbPath, DEFAULT_PORT } from './paths.js';
import { listArtifacts, resolveArtifact } from './artifacts.js';
import { NOT_HELPER_RECEIPT, receiptTotals } from './memory/store.js';
import { ESTIMATOR, savingsFrom, savingsLine } from './memory/tokens.js';
import { queueDepth } from './memory/worker.js';
import { droppedCount } from './memory/spool.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/** Moved to `paths.ts` so the SessionStart hook can probe it without importing this module. */
export { DEFAULT_PORT };
/**
 * How much history the per-day rows cover. A year, because the calendar heatmap
 * shows half of one and the streak has to be able to run off the top of it —
 * a thirty-day window would cap the longest streak at thirty.
 */
const TIMELINE_DAYS = 365;
/**
 * Cap on the attempt rows shipped for drill-down. Counts and per-day totals are
 * aggregated in SQL over the whole table, so the cap can only ever shorten a
 * history list, never make a number wrong.
 */
const ATTEMPT_LIMIT = 2000;
/**
 * The memory corpus does not travel in `/api/state`.
 *
 * Attempts are short rows with a bounded question on them; an observation
 * carries a narrative and the tool output it was distilled from, and a year of
 * them is megabytes. So the overview gets counts — aggregated in SQL, because
 * the page cannot honestly derive a total it was never sent — and the timeline
 * itself is paged over `/api/memory` (PRD DASH-02). One resource endpoint with
 * filters, not one query per card.
 */
const MEMORY_PER = 25;
/** Hard ceiling on one page of the memory resource, whatever `per` asks for. */
const MEMORY_PER_MAX = 200;
/**
 * Receipts are one row per injection and the arithmetic has to be checkable
 * line by line, so they do travel — capped like `attempts`, with the total
 * alongside so a truncated ledger cannot read as the whole one.
 */
const RECEIPT_LIMIT = 200;
/** One row per session that captured evidence, newest first. */
const MEMORY_SESSION_LIMIT = 500;
/** Longest narrative excerpt a timeline row carries; the detail page has it all. */
const SNIPPET = 150;

interface DayRow {
  day: string;
  repo: string | null;
  passed: number;
  missed: number;
  skipped: number;
}

interface ProjectRow {
  repo: string | null;
  answers: number;
  passed: number;
  skipped: number;
  concepts: number;
  first_active: string;
  last_active: string;
}

interface ConceptRow {
  id: number;
  slug: string;
  name: string;
  domain: string;
  description: string | null;
  tier: number;
  source: string;
  score: number | null;
  ease: number | null;
  interval_d: number | null;
  reps: number | null;
  next_review: string | null;
  last_seen: string | null;
  attempts: number;
  passed: number;
  skipped: number;
  first_asked: string | null;
  last_grade: number | null;
  last_context: string | null;
  last_repo: string | null;
}

/**
 * Two timestamp shapes live in this database and both have to parse.
 * `attempts.ts` defaults to SQLite's `2026-09-05 21:04:00` — UTC, no zone
 * marker, which `Date.parse` would read as local time — while `next_review` is
 * a JS ISO string that already carries its `Z`. Appending one unconditionally
 * produced `...ZZ`, which parses to NaN, and every overdue count came out zero.
 */
const parseTs = (s: string): number =>
  Date.parse(/([zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : s.replace(' ', 'T') + 'Z');

const days = (from: string | null, now: Date): number | null => {
  if (from === null) return null;
  const t = parseTs(from);
  return Number.isFinite(t) ? Math.floor((now.getTime() - t) / MS_PER_DAY) : null;
};

function readConfig(): EklavyaConfig {
  // A dashboard must open even if the config file is half-written or owned by
  // another user; the defaults describe the same product.
  try {
    return loadConfig().config;
  } catch {
    return DEFAULT_CONFIG;
  }
}

const one = <T>(db: DB, sql: string, ...args: unknown[]): T => db.prepare(sql).get(...args) as T;
const many = <T>(db: DB, sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...args) as T[];

/**
 * The memory half of the overview, as counts rather than rows.
 *
 * Six numbers that a single "memories" figure would conflate, and the
 * conflation is the dishonest part: evidence can be captured and never
 * processed, an entry can be indexed and never retrieved, retrieved and never
 * delivered, and delivered without anyone ever being asked about it. Exposure
 * is not assessment (PRD LRN-02) — `assessed` is the only one of these that
 * required the developer to answer something.
 */
function memorySummary(db: DB): Record<string, unknown> {
  const entries = one<{ total: number; live: number; superseded: number; deleted: number; notes: number }>(
    db,
    `SELECT count(*) AS total,
            COALESCE(SUM(deleted_at IS NULL AND superseded_by IS NULL), 0) AS live,
            COALESCE(SUM(superseded_by IS NOT NULL), 0) AS superseded,
            COALESCE(SUM(deleted_at IS NOT NULL), 0) AS deleted,
            COALESCE(SUM(kind = 'note'), 0) AS notes
     FROM memory_entries`,
  );
  const events = one<{ captured: number; processed: number; pending: number; redacted: number; newest: string | null }>(
    db,
    `SELECT count(*) AS captured,
            COALESCE(SUM(status = 'summarized'), 0) AS processed,
            COALESCE(SUM(status <> 'summarized'), 0) AS pending,
            COALESCE(SUM(redacted), 0) AS redacted,
            max(occurred_at) AS newest
     FROM evidence_events`,
  );
  const candidates = many<{ status: string; n: number }>(
    db,
    'SELECT status, count(*) AS n FROM learning_sources GROUP BY status',
  );

  return {
    // What the hooks accepted from the host.
    captured: events.captured,
    // How much of that an observation job has already distilled.
    processed: events.processed,
    pending: events.pending,
    redacted: events.redacted,
    newest_event: events.newest,
    entries: entries.live,
    entries_total: entries.total,
    superseded: entries.superseded,
    deleted: entries.deleted,
    notes: entries.notes,
    // Live entries carrying a vector: what semantic recall can actually reach.
    indexed: one<{ n: number }>(
      db,
      `SELECT count(DISTINCT v.entry_id) AS n FROM memory_vectors v
       JOIN memory_entries e ON e.id = v.entry_id WHERE e.deleted_at IS NULL`,
    ).n,
    // Entries a receipt ever selected …
    reused: one<{ n: number }>(db, 'SELECT count(DISTINCT entry_id) AS n FROM context_receipt_items').n,
    // … and the subset that a *confirmed* delivery actually put in front of the agent.
    exposed: one<{ n: number }>(
      db,
      `SELECT count(DISTINCT i.entry_id) AS n FROM context_receipt_items i
       JOIN context_receipts r ON r.id = i.receipt_id WHERE r.delivery = 'confirmed'`,
    ).n,
    // Concepts that came out of evidence and were then actually answered on.
    assessed: one<{ n: number }>(
      db,
      `SELECT count(DISTINCT ls.concept_id) AS n FROM learning_sources ls
       JOIN attempts a ON a.concept_id = ls.concept_id
       WHERE ls.concept_id IS NOT NULL`,
    ).n,
    candidates: Object.fromEntries(candidates.map((c) => [c.status, c.n])),
    types: many(db, `SELECT COALESCE(type, 'untyped') AS type, count(*) AS n FROM memory_entries
                     WHERE deleted_at IS NULL GROUP BY type ORDER BY n DESC`),
    tags: many(db, `SELECT t.tag, count(*) AS n FROM memory_entry_tags t
                    JOIN memory_entries e ON e.id = t.entry_id AND e.deleted_at IS NULL
                    GROUP BY t.tag ORDER BY n DESC, t.tag LIMIT 60`),
    projects: many(db, `SELECT project, count(*) AS n FROM memory_entries GROUP BY project ORDER BY n DESC`),
    per_page: MEMORY_PER,
  };
}

/**
 * The savings ledger, receipt by receipt.
 *
 * `B` is what the same material would have cost read from source; `D` is what
 * was actually delivered. Only a *confirmed* delivery contributes to the
 * headline — `receiptTotals` sums the confirmed rows alone, and `savingsFrom`
 * refuses to divide at all unless the delivery was confirmed, so an optimistic
 * "prepared" receipt can never be shown as a saving.
 */
function reuseSummary(db: DB): Record<string, unknown> {
  const totals = receiptTotals(db);
  const savings = savingsFrom({
    baseTokens: totals.base,
    deliveredTokens: totals.delivered,
    delivery: totals.confirmed > 0 ? 'confirmed' : 'unknown',
  });
  return {
    ...totals,
    savings,
    line: savingsLine(savings),
    estimator: ESTIMATOR,
    by_delivery: many(
      db,
      `SELECT delivery, count(*) AS n,
              COALESCE(SUM(base_tokens), 0) AS base,
              COALESCE(SUM(delivered_tokens), 0) AS delivered
       FROM context_receipts WHERE ${NOT_HELPER_RECEIPT} GROUP BY delivery`,
    ),
    receipts_shown: Math.min(totals.receipts, RECEIPT_LIMIT),
    rows: many(
      db,
      `SELECT r.id, r.receipt_uid, r.project, r.session_id, r.scope, r.method,
              r.base_tokens, r.delivered_tokens, r.item_count, r.delivery, r.created_at,
              (SELECT COALESCE(SUM(sent_tokens), 0) FROM context_receipt_items i
                WHERE i.receipt_id = r.id AND i.stage = 'index') AS index_tokens,
              (SELECT COALESCE(SUM(sent_tokens), 0) FROM context_receipt_items i
                WHERE i.receipt_id = r.id AND i.stage = 'detail') AS detail_tokens,
              (SELECT count(*) FROM context_receipt_items i
                WHERE i.receipt_id = r.id AND i.stage = 'detail') AS detail_items
       FROM context_receipts r WHERE ${NOT_HELPER_RECEIPT} ORDER BY r.id DESC LIMIT ?`,
      RECEIPT_LIMIT,
    ),
  };
}

/**
 * Capture heartbeat, queue, failures and provider state.
 *
 * Bounded and redacted by construction: error *classes* and counts, never
 * `last_error`, never a key, never a log dump (PRD DASH-03). A class is what
 * tells the reader whether to re-authenticate or wait.
 */
function healthSummary(db: DB, config: EklavyaConfig): Record<string, unknown> {
  const beat = one<{ newest: string | null; received: string | null }>(
    db,
    'SELECT max(occurred_at) AS newest, max(received_at) AS received FROM evidence_events',
  );
  return {
    capture: {
      enabled: config.memory.enabled,
      mode: config.memory.capture,
      newest_event: beat.newest,
      newest_received: beat.received,
      retention_days: config.memory.retention_days,
      // Each project stamps its own sweep; the page shows the latest of them
      // (the bare key is the stamp versions before per-project retention wrote).
      pruned_at:
        one<{ value: string | null }>(
          db,
          "SELECT max(value) AS value FROM meta WHERE key = 'memory_pruned_at' OR key LIKE 'memory_pruned_at:%'",
        ).value ?? null,
    },
    queue: queueDepth(db),
    stalled: many(
      db,
      `SELECT status, COALESCE(error_class, 'unclassified') AS error_class, count(*) AS n, max(updated_at) AS last,
              max(attempts) AS attempts
       FROM memory_jobs WHERE status IN ('failed', 'paused')
       GROUP BY status, error_class ORDER BY n DESC`,
    ),
    spool_dropped: droppedCount(),
    // Whether a provider exists and which model it names. The key never appears
    // here — only the environment variable it is read from is configured at all,
    // and even that name stays out of the payload.
    providers: {
      observer: config.providers.observer
        ? { kind: config.providers.observer.kind, model: config.providers.observer.model }
        : null,
      embeddings: config.providers.embeddings
        ? { kind: config.providers.embeddings.kind, model: config.providers.embeddings.model }
        : null,
      retrieval_mode: config.retrieval.mode,
    },
  };
}

/** One row per session that captured evidence, so a session page can link the two halves. */
function memorySessions(db: DB): Record<string, unknown>[] {
  return many(
    db,
    `SELECT e.session_id, e.project, count(*) AS events,
            COALESCE(SUM(e.redacted), 0) AS redacted,
            min(e.occurred_at) AS first, max(e.occurred_at) AS last,
            (SELECT count(*) FROM memory_entries m WHERE m.session_id = e.session_id) AS entries,
            (SELECT count(*) FROM learning_sources ls JOIN memory_entries m ON m.id = ls.entry_id
              WHERE m.session_id = e.session_id) AS candidates
     FROM evidence_events e
     GROUP BY e.session_id, e.project
     ORDER BY last DESC LIMIT ?`,
    MEMORY_SESSION_LIMIT,
  );
}

export interface MemoryQuery {
  project?: string | null;
  session?: string | null;
  type?: string | null;
  tag?: string | null;
  q?: string | null;
  since?: string | null;
  until?: string | null;
  page?: number;
  per?: number;
}

/**
 * One page of the memory timeline (PRD DASH-02).
 *
 * Deleted and superseded rows are *included* — the dashboard is the audit
 * trail, and an entry that vanished when it was corrected is an entry nobody
 * can check. They travel with `deleted_at` and `superseded_by` set so the page
 * can mark them.
 */
export function memoryPage(db: DB, q: MemoryQuery = {}): Record<string, unknown> {
  const per = Math.min(MEMORY_PER_MAX, Math.max(1, Math.floor(q.per || MEMORY_PER)));
  const page = Math.max(1, Math.floor(q.page || 1));
  const where: string[] = [];
  const args: unknown[] = [];
  const eq = (sql: string, v: unknown) => {
    if (v === undefined || v === null || v === '') return;
    where.push(sql);
    args.push(v);
  };
  eq('e.project = ?', q.project);
  eq('e.session_id = ?', q.session);
  eq("COALESCE(e.type, 'untyped') = ?", q.type);
  eq('e.occurred_at >= ?', q.since);
  eq('e.occurred_at <= ?', q.until);
  if (q.tag) {
    where.push('EXISTS (SELECT 1 FROM memory_entry_tags t WHERE t.entry_id = e.id AND t.tag = ?)');
    args.push(String(q.tag).toLowerCase());
  }
  // A search box is not FTS5 query syntax, and the corpus is small enough that
  // a LIKE over the stored columns beats explaining a MATCH parse error to
  // someone who typed `fix: auth (retry?)`.
  if (q.q && String(q.q).trim()) {
    // The escape needs its `ESCAPE` clause: without one SQLite reads `\%` as a
    // backslash then a wildcard, and a search for `100%` or `snake_case` found
    // nothing.
    where.push(
      "(e.title LIKE ? ESCAPE '\\' OR e.narrative LIKE ? ESCAPE '\\' OR e.facts LIKE ? ESCAPE '\\' OR e.files LIKE ? ESCAPE '\\')",
    );
    const like = `%${String(q.q).trim().replace(/[\\%_]/g, '\\$&')}%`;
    args.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = one<{ n: number }>(db, `SELECT count(*) AS n FROM memory_entries e ${clause}`, ...args).n;
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(page, pages);

  const rows = many<Record<string, unknown>>(
    db,
    `SELECT e.id, e.entry_uid, e.project, e.session_id, e.kind, e.type, e.title,
            substr(e.narrative, 1, ${SNIPPET}) AS snippet, length(e.narrative) AS narrative_length,
            e.files, e.generator, e.confidence, e.occurred_at, e.created_at,
            e.superseded_by, e.deleted_at, e.import_source,
            (SELECT count(*) FROM memory_entry_events me WHERE me.entry_id = e.id) AS event_count,
            (SELECT group_concat(t.tag, ',') FROM memory_entry_tags t WHERE t.entry_id = e.id) AS tag_list
     FROM memory_entries e ${clause}
     ORDER BY e.occurred_at DESC, e.id DESC LIMIT ? OFFSET ?`,
    ...args,
    per,
    (p - 1) * per,
  ).map((r) => ({ ...r, tags: r.tag_list ? String(r.tag_list).split(',') : [] }));

  // Asking for one session is asking for that session's whole memory story, so
  // the candidates it proposed ride along rather than costing a second round
  // trip from the session page.
  const candidates = q.session
    ? many(
        db,
        `SELECT ls.id, ls.slug, ls.name, ls.domain, ls.confidence, ls.status, c.slug AS concept_slug
         FROM learning_sources ls
         JOIN memory_entries e ON e.id = ls.entry_id
         LEFT JOIN concepts c ON c.id = ls.concept_id
         WHERE e.session_id = ? ORDER BY ls.confidence DESC`,
        q.session,
      )
    : undefined;

  return { total, page: p, pages, per, rows, ...(candidates ? { candidates } : {}) };
}

/**
 * One page of the sessions that captured or remembered anything, newest first.
 *
 * `memory_sessions` in `/api/state` is capped at `MEMORY_SESSION_LIMIT` for the
 * learning page's join; this is the same reading as a paged resource with a
 * real total, so the Memory workflow's Sessions list never stops at the cap.
 * A session can exist in `memory_entries` alone — an import carries entries
 * and no evidence — so both tables contribute.
 */
export function memorySessionPage(
  db: DB,
  q: { project?: string | null; session?: string | null; page?: number; per?: number } = {},
): Record<string, unknown> {
  const per = Math.min(MEMORY_PER_MAX, Math.max(1, Math.floor(q.per || MEMORY_PER)));
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.project) { where.push('project = ?'); args.push(q.project); }
  if (q.session) { where.push('session_id = ?'); args.push(q.session); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const union = `
    SELECT session_id, project, count(*) AS events, COALESCE(SUM(redacted), 0) AS redacted,
           COALESCE(SUM(status <> 'summarized'), 0) AS pending, min(occurred_at) AS first, max(occurred_at) AS last
    FROM evidence_events GROUP BY session_id, project
    UNION ALL
    SELECT session_id, project, 0, 0, 0, min(occurred_at), max(occurred_at)
    FROM memory_entries WHERE session_id IS NOT NULL GROUP BY session_id, project`;
  const total = one<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM (SELECT session_id, project FROM (${union}) ${clause} GROUP BY session_id, project)`,
    ...args,
  ).n;
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(Math.max(1, Math.floor(q.page || 1)), pages);
  const rows = many(
    db,
    `SELECT s.session_id, s.project, SUM(s.events) AS events, SUM(s.redacted) AS redacted, SUM(s.pending) AS pending,
            min(s.first) AS first, max(s.last) AS last,
            (SELECT count(*) FROM memory_entries m WHERE m.session_id = s.session_id AND m.project = s.project
              AND m.deleted_at IS NULL AND m.superseded_by IS NULL) AS entries,
            (SELECT count(*) FROM learning_sources ls JOIN memory_entries m ON m.id = ls.entry_id
              WHERE m.session_id = s.session_id AND m.project = s.project) AS candidates
     FROM (${union}) s ${clause}
     GROUP BY s.session_id, s.project ORDER BY last DESC LIMIT ? OFFSET ?`,
    ...args,
    per,
    (p - 1) * per,
  );
  return { total, page: p, pages, per, rows };
}

/** The id of a project whose rows carry no repository at all: recorded before projects were tracked. */
export const UNATTRIBUTED = '~';

interface InventoryProject {
  id: string;
  path: string | null;
  kind: 'repo' | 'global' | 'unattributed';
  name: string;
  available: boolean | null;
  sources: string[];
  aliases: string[];
  learning: {
    answers: number; passed: number; skipped: number; assessed_concepts: number;
    logged_concepts: number; sessions: number; first: string | null; last: string | null;
  };
  memory: {
    events: number; pending: number; entries: number; sessions: number; receipts: number;
    first: string | null; last: string | null;
  };
  first_active: string | null;
  last_active: string | null;
}

/**
 * Every project any part of Eklavya has recorded, under one id per codebase.
 *
 * The learning page's `projects` list is built from `attempts` alone, so a
 * project whose concepts were logged but never asked about, or one that only
 * ever captured memory, was absent from it and from the project selector. This
 * is the inventory both workflows share instead. Existence is established by
 * any row that names a project: an attempt, a logged concept (through its
 * session's gate), captured evidence — processed or not — a stored
 * observation, a reuse receipt, or an earned level. Counts stay per half:
 * captured is not assessed, and a project with no answers says so rather than
 * reading as one that failed them.
 *
 * Identity is `projectKey`, the same fold every writer uses. Two readings need
 * more than that, and neither guesses:
 *
 * - `gates.repo` is the unfolded checkout (the commit gate matches it against
 *   `git rev-parse --show-toplevel`), and a deleted worktree can no longer be
 *   folded from the filesystem. If captured evidence recorded that checkout
 *   under exactly one project, that recorded fold is used; otherwise the path
 *   stays its own project, marked unavailable, rather than merged by a guess.
 * - A NULL repo is `UNATTRIBUTED`, never folded into `*`. On a gate row it can
 *   mean "before migration 003" or "outside any repository", and nothing
 *   stored tells the two apart.
 */
export function projectInventory(db: DB): {
  projects: InventoryProject[];
  aliases: Record<string, string>;
  sessions: Record<string, string>;
} {
  const recorded = new Map<string, Set<string>>();
  for (const r of many<{ checkout: string; project: string }>(
    db,
    `SELECT DISTINCT checkout, project FROM evidence_events WHERE checkout IS NOT NULL AND checkout <> project`,
  )) {
    recorded.set(r.checkout, (recorded.get(r.checkout) ?? new Set()).add(r.project));
  }
  const folded = new Map<string, string>();
  const canonical = (raw: string | null): string => {
    const v = raw?.trim();
    if (!v) return UNATTRIBUTED;
    if (v === GLOBAL_PROJECT) return GLOBAL_PROJECT;
    let id = folded.get(v);
    if (id === undefined) {
      id = projectKey(v);
      const onRecord = recorded.get(v);
      if (id === v && onRecord?.size === 1) id = [...onRecord][0]!;
      folded.set(v, id);
    }
    return id;
  };

  const byId = new Map<string, InventoryProject & { _assessed: Set<number>; _logged: Set<number>; _lsess: Set<string>; _msess: Set<string> }>();
  const at = (raw: string | null, source: string) => {
    const id = canonical(raw);
    let p = byId.get(id);
    if (!p) {
      const kind = id === UNATTRIBUTED ? 'unattributed' : id === GLOBAL_PROJECT ? 'global' : 'repo';
      p = {
        id, kind, path: kind === 'repo' ? id : null, name: '', available: kind === 'repo' ? fs.existsSync(id) : null,
        sources: [], aliases: [],
        learning: { answers: 0, passed: 0, skipped: 0, assessed_concepts: 0, logged_concepts: 0, sessions: 0, first: null, last: null },
        memory: { events: 0, pending: 0, entries: 0, sessions: 0, receipts: 0, first: null, last: null },
        first_active: null, last_active: null,
        _assessed: new Set(), _logged: new Set(), _lsess: new Set(), _msess: new Set(),
      };
      byId.set(id, p);
    }
    if (!p.sources.includes(source)) p.sources.push(source);
    const v = raw?.trim();
    if (v && v !== id && !p.aliases.includes(v)) p.aliases.push(v);
    return p;
  };
  const sessionIds = new Map<string, Set<string>>();
  const note = (sid: string, id: string) => sessionIds.set(sid, (sessionIds.get(sid) ?? new Set()).add(id));
  // Both timestamp shapes, flattened to ISO so min/max compare as instants.
  const iso = (ts: string | null) => {
    if (!ts) return null;
    const t = parseTs(ts);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  };
  const span = (o: { first: string | null; last: string | null }, first: string | null, last: string | null) => {
    const f = iso(first), l = iso(last);
    if (f && (!o.first || f < o.first)) o.first = f;
    if (l && (!o.last || l > o.last)) o.last = l;
  };

  for (const r of many<{ repo: string | null; session_id: string | null; concept_id: number; n: number; passed: number; skipped: number; first: string; last: string }>(
    db,
    `SELECT repo, session_id, concept_id, count(*) AS n,
            COALESCE(SUM(grade >= ${PASSING_GRADE}), 0) AS passed,
            COALESCE(SUM(outcome IN ('declined','dont_know')), 0) AS skipped,
            min(ts) AS first, max(ts) AS last
     FROM attempts GROUP BY repo, session_id, concept_id`,
  )) {
    const p = at(r.repo, 'attempts');
    p.learning.answers += r.n;
    p.learning.passed += r.passed;
    p.learning.skipped += r.skipped;
    p._assessed.add(r.concept_id);
    if (r.session_id) {
      p._lsess.add(r.session_id);
      if (r.repo?.trim()) note(r.session_id, p.id);
    }
    span(p.learning, r.first, r.last);
  }
  for (const r of many<{ project: string; session_id: string; n: number; pending: number; first: string; last: string }>(
    db,
    `SELECT project, session_id, count(*) AS n, COALESCE(SUM(status <> 'summarized'), 0) AS pending,
            min(occurred_at) AS first, max(occurred_at) AS last
     FROM evidence_events GROUP BY project, session_id`,
  )) {
    const p = at(r.project, 'evidence');
    p.memory.events += r.n;
    p.memory.pending += r.pending;
    p._msess.add(r.session_id);
    note(r.session_id, p.id);
    span(p.memory, r.first, r.last);
  }
  // A gate row with no repository names no project, but the same session's
  // own answers and evidence may. Where they agree on exactly one project, the
  // session is that project's; where they do not, it stays unattributed. The
  // session id is an exact identity -- nothing here matches on names or times.
  const unassigned = new Map<string, string | null>();
  for (const [sid, ids] of sessionIds) unassigned.set(sid, ids.size === 1 ? [...ids][0]! : null);
  const sessionProjects: Record<string, string> = {};
  for (const r of many<{ repo: string | null; session_id: string; concept_id: number; origin: string | null; first: string; last: string }>(
    db,
    `SELECT g.repo AS repo, sc.session_id, sc.concept_id, sc.origin, min(sc.ts) AS first, max(sc.ts) AS last
     FROM session_concepts sc LEFT JOIN gates g ON g.session_id = sc.session_id
     GROUP BY g.repo, sc.session_id, sc.concept_id`,
  )) {
    const proven = r.repo?.trim() ? null : unassigned.get(r.session_id) ?? null;
    if (proven) sessionProjects[r.session_id] = proven;
    const p = proven ? at(proven, 'logged') : at(r.repo, 'logged');
    // Only work the agent logged. `record_attempt` writes a `review` row for
    // every concept it grades, and counting those would call every answered
    // concept "recorded from your work".
    if ((r.origin ?? 'work') === 'work') p._logged.add(r.concept_id);
    p._lsess.add(r.session_id);
    span(p.learning, r.first, r.last);
  }
  for (const r of many<{ project: string; session_id: string | null; live: number; first: string; last: string }>(
    db,
    `SELECT project, session_id, COALESCE(SUM(deleted_at IS NULL AND superseded_by IS NULL), 0) AS live,
            min(occurred_at) AS first, max(occurred_at) AS last
     FROM memory_entries GROUP BY project, session_id`,
  )) {
    const p = at(r.project, 'entries');
    p.memory.entries += r.live;
    if (r.session_id) p._msess.add(r.session_id);
    span(p.memory, r.first, r.last);
  }
  for (const r of many<{ project: string; n: number }>(db, 'SELECT project, count(*) AS n FROM context_receipts GROUP BY project')) {
    at(r.project, 'receipts').memory.receipts += r.n;
  }
  for (const r of many<{ repo: string }>(db, 'SELECT repo FROM project_levels')) at(r.repo, 'levels');

  const projects = [...byId.values()].map(({ _assessed, _logged, _lsess, _msess, ...p }) => {
    p.learning.assessed_concepts = _assessed.size;
    p.learning.logged_concepts = _logged.size;
    p.learning.sessions = _lsess.size;
    p.memory.sessions = _msess.size;
    const firsts = [p.learning.first, p.memory.first].filter(Boolean) as string[];
    const lasts = [p.learning.last, p.memory.last].filter(Boolean) as string[];
    p.first_active = firsts.sort()[0] ?? null;
    p.last_active = lasts.sort().at(-1) ?? null;
    return p;
  });

  // A folder name is what a person recognises, but two repositories can share
  // one. Widen a clashing name one parent at a time until it is unique.
  const repos = projects.filter((p) => p.kind === 'repo');
  const tail = (p: string, n: number) => p.split(/[\\/]/).filter(Boolean).slice(-n).join('/');
  for (const p of repos) {
    let n = 1;
    while (n < 8 && repos.some((o) => o !== p && tail(o.id, n) === tail(p.id, n))) n += 1;
    p.name = tail(p.id, n) || p.id;
  }
  for (const p of projects) {
    if (p.kind === 'global') p.name = 'No repository';
    if (p.kind === 'unattributed') p.name = 'Unattributed';
  }
  projects.sort((a, b) => String(b.last_active ?? '').localeCompare(String(a.last_active ?? '')) || a.name.localeCompare(b.name));

  const aliases: Record<string, string> = {};
  for (const [raw, id] of folded) aliases[raw] = id;
  return { projects, aliases, sessions: sessionProjects };
}

/** One entry with its tags, its raw evidence and the candidates it proposed. */
export function memoryEntry(db: DB, id: number): Record<string, unknown> | null {
  const entry = one<Record<string, unknown> | undefined>(db, 'SELECT * FROM memory_entries WHERE id = ?', id);
  if (!entry) return null;
  return {
    entry,
    tags: many<{ tag: string }>(db, 'SELECT tag FROM memory_entry_tags WHERE entry_id = ? ORDER BY tag', id).map(
      (t) => t.tag,
    ),
    // The raw evidence behind the claim. `body` is capped: an observation can be
    // distilled from a 200KB tool dump and the drill-down is a check, not an export.
    events: many(
      db,
      `SELECT ev.id, ev.event_uid, ev.kind, ev.tool, ev.title, ev.source, ev.host, ev.agent_id,
              substr(ev.body, 1, 4000) AS body, length(ev.body) AS body_length,
              ev.files, ev.occurred_at, ev.redacted, ev.status
       FROM evidence_events ev
       JOIN memory_entry_events me ON me.event_id = ev.id
       WHERE me.entry_id = ? ORDER BY ev.occurred_at, ev.id`,
      id,
    ),
    candidates: many(
      db,
      `SELECT ls.id, ls.slug, ls.name, ls.domain, ls.confidence, ls.status, ls.concept_id,
              c.slug AS concept_slug
       FROM learning_sources ls LEFT JOIN concepts c ON c.id = ls.concept_id
       WHERE ls.entry_id = ? ORDER BY ls.confidence DESC`,
      id,
    ),
    // The row that replaced this one, and the rows this one replaced.
    replaced_by: entry.superseded_by
      ? one(db, 'SELECT id, title, occurred_at FROM memory_entries WHERE id = ?', entry.superseded_by)
      : null,
    replaces: many(db, 'SELECT id, title, occurred_at FROM memory_entries WHERE superseded_by = ?', id),
    receipts: many(
      db,
      `SELECT r.id, r.scope, r.delivery, r.created_at, i.stage, i.source_tokens, i.sent_tokens
       FROM context_receipt_items i JOIN context_receipts r ON r.id = i.receipt_id
       WHERE i.entry_id = ? ORDER BY r.id DESC LIMIT 20`,
      id,
    ),
  };
}

export function dashboardState(db: DB): Record<string, unknown> {
  const now = new Date();
  const config = readConfig();

  // One row per calendar day per project, split three ways. `grade >= 3` is the
  // same pass line the level ladder uses, so the chart and the promotion agree.
  const daily = db
    .prepare(
      `SELECT date(ts) AS day,
              NULLIF(trim(COALESCE(repo, '')), '') AS repo,
              sum(CASE WHEN grade >= ? THEN 1 ELSE 0 END) AS passed,
              sum(CASE WHEN grade < ? AND (outcome IS NULL OR outcome = 'answered') THEN 1 ELSE 0 END) AS missed,
              sum(CASE WHEN outcome IN ('declined','dont_know') THEN 1 ELSE 0 END) AS skipped
       FROM attempts
       WHERE ts >= date('now', ?)
       GROUP BY day, repo
       ORDER BY day`,
    )
    .all(PASSING_GRADE, PASSING_GRADE, `-${TIMELINE_DAYS} days`) as DayRow[];

  // A null repo is the pre-migration-003 bucket. It is kept, not dropped:
  // hiding those rows would silently shrink every total on the page.
  const projects = db
    .prepare(
      `SELECT NULLIF(trim(COALESCE(a.repo, '')), '') AS repo,
              count(*) AS answers,
              sum(CASE WHEN a.grade >= ? THEN 1 ELSE 0 END) AS passed,
              sum(CASE WHEN a.outcome IN ('declined','dont_know') THEN 1 ELSE 0 END) AS skipped,
              count(DISTINCT a.concept_id) AS concepts,
              min(a.ts) AS first_active,
              max(a.ts) AS last_active
       FROM attempts a
       GROUP BY repo
       ORDER BY last_active DESC`,
    )
    .all(PASSING_GRADE) as ProjectRow[];

  const conceptRows = db
    .prepare(
      `SELECT c.id, c.slug, c.name, c.domain, c.description, c.tier, c.source,
              m.score, m.ease, m.interval_d, m.reps, m.next_review, m.last_seen,
              (SELECT count(*) FROM attempts a WHERE a.concept_id = c.id) AS attempts,
              (SELECT count(*) FROM attempts a WHERE a.concept_id = c.id AND a.grade >= ${PASSING_GRADE}) AS passed,
              (SELECT count(*) FROM attempts a WHERE a.concept_id = c.id
                AND a.outcome IN ('declined','dont_know')) AS skipped,
              (SELECT min(a.ts) FROM attempts a WHERE a.concept_id = c.id) AS first_asked,
              (SELECT a.grade FROM attempts a WHERE a.concept_id = c.id ORDER BY a.id DESC LIMIT 1) AS last_grade,
              (SELECT sc.context FROM session_concepts sc
                WHERE sc.concept_id = c.id AND sc.context IS NOT NULL
                ORDER BY sc.ts DESC LIMIT 1) AS last_context,
              (SELECT a.repo FROM attempts a
                WHERE a.concept_id = c.id AND a.repo IS NOT NULL AND trim(a.repo) <> ''
                ORDER BY a.id DESC LIMIT 1) AS last_repo
       FROM concepts c
       LEFT JOIN mastery m ON m.concept_id = c.id
       ORDER BY c.domain, c.tier, c.name`,
    )
    .all() as ConceptRow[];

  const byId = new Map(conceptRows.map((r) => [r.id, r.slug]));

  // Edges travel as slugs so the page can link one concept card to another
  // without carrying the id space around with it.
  const edgeRows = db
    .prepare('SELECT from_concept, to_concept, relation FROM edges')
    .all() as { from_concept: number; to_concept: number; relation: string }[];

  const prereqs = new Map<string, string[]>();
  const unlocks = new Map<string, string[]>();
  const related = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const e of edgeRows) {
    const from = byId.get(e.from_concept);
    const to = byId.get(e.to_concept);
    if (!from || !to) continue;
    if (e.relation === 'prerequisite_of') {
      push(prereqs, to, from);
      push(unlocks, from, to);
    } else {
      push(related, from, to);
      push(related, to, from);
    }
  }

  const domains = new Map<
    string,
    { domain: string; catalogue: number; touched: number; mastered: number; learning: number; unseen: number }
  >();
  const concepts = conceptRows.map((row) => {
    const bucket = domains.get(row.domain) ?? {
      domain: row.domain,
      catalogue: 0,
      touched: 0,
      mastered: 0,
      learning: 0,
      unseen: 0,
    };
    domains.set(row.domain, bucket);
    bucket.catalogue += 1;

    // Read-time decay only, exactly as the profile computes it — two surfaces
    // disagreeing about the same score is worse than either being wrong.
    const score = decayedScore(row.score ?? 0, row.next_review, now);
    const seen = row.attempts > 0;
    const mastered = seen && isKnown({ score, reps: row.reps ?? 0 });
    if (!seen) bucket.unseen += 1;
    else {
      bucket.touched += 1;
      if (mastered) bucket.mastered += 1;
      else bucket.learning += 1;
    }

    const due = seen && isDue(row.next_review, now);
    return {
      slug: row.slug,
      name: row.name,
      domain: row.domain,
      description: row.description,
      tier: row.tier,
      source: row.source,
      seen,
      score: Number(score.toFixed(4)),
      // The stored score, so a decayed concept can say how much of its score is
      // rust rather than failure.
      stored_score: Number((row.score ?? 0).toFixed(4)),
      ease: row.ease ?? null,
      interval_d: row.interval_d ?? 0,
      reps: row.reps ?? 0,
      attempts: row.attempts,
      passed: row.passed,
      skipped: row.skipped,
      last_grade: row.last_grade,
      mastered,
      due,
      overdue_days: due ? days(row.next_review, now) : null,
      next_review: row.next_review,
      last_seen: row.last_seen,
      first_asked: row.first_asked,
      context: row.last_context,
      repo: row.last_repo,
      prereqs: prereqs.get(row.slug) ?? [],
      unlocks: unlocks.get(row.slug) ?? [],
      related: related.get(row.slug) ?? [],
    };
  });

  // Every graded response, newest first, with its question and the tutor's
  // explanation. This is what makes a concept page a record of what you were
  // actually asked rather than a score.
  const attempts = db
    .prepare(
      `SELECT a.id, c.slug, c.name, c.domain, a.session_id, a.question, a.answer, a.feedback,
              a.grade, a.difficulty AS tier, a.outcome, a.format, a.options, a.ts,
              NULLIF(trim(COALESCE(a.repo, '')), '') AS repo, a.level
       FROM attempts a JOIN concepts c ON c.id = a.concept_id
       ORDER BY a.id DESC
       LIMIT ?`,
    )
    .all(ATTEMPT_LIMIT) as Record<string, unknown>[];

  // The context lines, which are what a concept means to *this* learner: the
  // code that taught it. Grouped by session on the page.
  const logged = db
    .prepare(
      `SELECT sc.session_id, c.slug, c.name, c.domain, sc.context, sc.ts, sc.origin,
              NULLIF(trim(COALESCE(g.repo, '')), '') AS repo
       FROM session_concepts sc
       JOIN concepts c ON c.id = sc.concept_id
       LEFT JOIN gates g ON g.session_id = sc.session_id
       ORDER BY sc.ts DESC`,
    )
    .all()
    // `gates.repo` stays the worktree path -- the POSIX gate matches it against
    // `git rev-parse --show-toplevel`. Every other repo on this page comes from
    // `attempts`, already folded, so fold this one too or a project filter drops
    // every context line a worktree session logged.
    .map((r) => {
      const row = r as Record<string, unknown>;
      return { ...row, repo: row.repo ? projectKey(row.repo as string) : null };
    }) as Record<string, unknown>[];

  const allTime = db
    .prepare(
      `SELECT count(*) AS answers,
              sum(CASE WHEN grade >= ? THEN 1 ELSE 0 END) AS passed,
              sum(CASE WHEN grade < ? AND (outcome IS NULL OR outcome = 'answered') THEN 1 ELSE 0 END) AS missed,
              sum(CASE WHEN outcome IN ('declined','dont_know') THEN 1 ELSE 0 END) AS skipped,
              count(DISTINCT date(ts)) AS active_days,
              min(ts) AS first_answer
       FROM attempts`,
    )
    .get(PASSING_GRADE, PASSING_GRADE) as {
    answers: number;
    passed: number | null;
    missed: number | null;
    skipped: number | null;
    active_days: number;
    first_answer: string | null;
  };

  const sessionCount = (
    db.prepare('SELECT count(DISTINCT session_id) AS n FROM session_concepts').get() as { n: number }
  ).n;

  const memory = memorySummary(db);
  const reuse = reuseSummary(db);

  return {
    generated_at: now.toISOString(),
    db_path: dbPath(),
    /**
     * What an open page polls to notice that work landed while it was reading
     * it (PRD DASH-01). Counts of rows the payload already carries, so it costs
     * no extra query and moves exactly when the page's content does.
     *
     * Deliberately not `generated_at`, and not a hash of the payload: both
     * change on every call — scores are decayed against the clock — and a page
     * that announces new activity every minute is a page whose banner is
     * ignored inside a day.
     *
     * Ceiling: counts cannot see an edit that leaves the counts alone. Every
     * such edit here (a superseded entry, a deleted one) moves a *different*
     * count in this list, so the gap is theoretical today; a real event cursor
     * is the upgrade if that stops being true.
     */
    cursor: [
      allTime.answers,
      logged.length,
      sessionCount,
      memory.captured,
      memory.processed,
      memory.entries_total,
      memory.superseded,
      memory.deleted,
      reuse.receipts,
    ].join(':'),
    timeline_days: TIMELINE_DAYS,
    attempts_shown: attempts.length,
    attempts_total: allTime.answers,
    config: {
      quiz_enabled: config.quiz.enabled,
      quiz_enforced: config.quiz.enforced,
      focus: config.focus,
      focus_topic: config.focus_topic,
      cadence: config.cadence,
      difficulty: config.difficulty,
      pass_threshold: config.pass_threshold,
      level_up_after: config.level_up_after,
      level_up_accuracy: config.level_up_accuracy,
      max_questions_per_task: config.max_questions_per_task,
    },
    totals: {
      answers: allTime.answers,
      passed: allTime.passed ?? 0,
      missed: allTime.missed ?? 0,
      skipped: allTime.skipped ?? 0,
      mastered: concepts.filter((c) => c.mastered).length,
      due: concepts.filter((c) => c.due).length,
      touched: concepts.filter((c) => c.seen).length,
      catalogue: conceptRows.length,
      sessions: sessionCount,
      active_days: allTime.active_days,
      first_answer: allTime.first_answer,
    },
    daily,
    projects: projects.map((p) => {
      // The promotion runway, said out loud rather than hinted at — the same
      // numbers `/eklavya:progress` prints, so the two never disagree.
      const standing = levelStanding(db, config, p.repo);
      return {
        ...p,
        key: p.repo ?? GLOBAL_PROJECT,
        level: standing.level,
        pinned: standing.pinned,
        promoted_at: standing.entered_at,
        next_level: standing.next,
        level_counts: standing.counts,
        level_accuracy: standing.accuracy,
        level_needed: standing.needed,
        level_unmet: standing.unmet,
      };
    }),
    domains: [...domains.values()].sort((a, b) => b.touched - a.touched || b.catalogue - a.catalogue),
    concepts,
    attempts,
    logged,
    // The memory half. Additive: every key above kept its name and its shape,
    // because `/api/state` is a contract an older page still reads.
    memory,
    reuse,
    health: healthSummary(db, config),
    memory_sessions: memorySessions(db),
    // The third workflow. Read from the files themselves on every load
    // (`artifacts.ts`): there is no table to fall out of step with the disk.
    artifacts: listArtifacts(),
  };
}

/**
 * The platform's URL opener, as a command and its arguments.
 *
 * The empty string before the URL on Windows is load-bearing: `start <url>`
 * reads its first quoted argument as the new window's *title*, so a URL passed
 * alone can be swallowed as one. `start "" <url>` is the documented shape.
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}

/**
 * Hands the URL to whatever the OS considers the browser.
 *
 * Best effort, and deliberately silent when it fails: a container, a bare SSH
 * session or a machine with no desktop has no browser to hand it to, and the
 * URL is on stdout for those. Detached and unref'd so the opener's lifetime is
 * not tied to this process — `xdg-open` can outlive the launch by seconds, and
 * a child still attached would hold the terminal after Ctrl+C.
 */
export function openInBrowser(url: string): void {
  try {
    const [cmd, args] = browserCommand(url);
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Nothing to do: the URL is printed either way.
  }
}

/**
 * The site's tokens, minus anything fetched from another host.
 *
 * `tokens.css` is shared with the landing page, which loads its web fonts from
 * Google; the dashboard promises that nothing on it leaves the machine, and a
 * font request is a request that tells a third party this page was opened. So
 * remote `@import`s are dropped here and the font stacks fall through to the
 * system faces they already name — the site keeps its fonts, this page makes
 * no outbound request.
 */
export function localTokens(css: string): string {
  return css.replace(/@import\s+url\(\s*['"]?(?:https?:)?\/\/[^)]*\)[^;]*;\s*/gi, '');
}

/**
 * What a browser may do with anything this server sends. The page is one file
 * with an inline script and inline styles, a `data:` favicon, and same-origin
 * fetches -- nothing more is allowed, so an injected tag that slipped past
 * `esc()` still cannot load or send anything off the machine, and no other page
 * can frame this one.
 */
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

/**
 * What an artifact page may do. It is HTML an agent wrote, served from the
 * dashboard's own origin, so the CSP `sandbox` directive gives it an opaque
 * origin instead: its scripts run (the PDF and HTML buttons need them) but it
 * cannot read `/api/state` or anything else here, since a fetch from a null
 * origin gets no CORS grant. The web fonts its template links are the one
 * thing allowed off the machine; without them it falls back to system faces.
 * A link out (the Eklavya lockup) opens in a normal, unsandboxed tab.
 */
const ARTIFACT_CSP = [
  'sandbox allow-scripts allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  'img-src data: blob:',
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function send(
  res: http.ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': type,
    // A dashboard read from a stale cache is a dashboard that lies about
    // progress made ten seconds ago, which is the one thing it is for.
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
    ...extra,
  });
  res.end(body);
}

/**
 * Starts the server and resolves with the URL it actually bound to. The
 * requested port may be taken by a second dashboard or an unrelated dev
 * server; falling back to an ephemeral port beats failing with EADDRINUSE
 * when the caller does not care which port it gets.
 */
/** `127.0.0.1`, `[::1]` and `localhost`, with or without a port, and nothing else. */
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|\[::1\]|::1|localhost)(?::\d+)?$/i;

export function fromLoopback(hostHeader?: string, originHeader?: string): boolean {
  // A request with no Host is HTTP/1.0 or a hand-rolled client, not a browser,
  // and a browser is the only attacker this check has. Allow it.
  if (hostHeader !== undefined && !LOOPBACK_HOST.test(hostHeader)) return false;
  // An `Origin` only appears on a cross-origin or scripted request. If one is
  // present it has to be a loopback origin too -- `null` included, which is
  // what a sandboxed iframe or a `file://` page sends.
  if (originHeader !== undefined && originHeader !== 'null') {
    try {
      if (!LOOPBACK_HOST.test(new URL(originHeader).host)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function startDashboard(
  db: DB,
  opts: { port?: number; host?: string } = {},
): Promise<{ url: string; close: () => void }> {
  const host = opts.host ?? '127.0.0.1';
  const wanted = opts.port ?? DEFAULT_PORT;
  const assets = path.join(moduleDir, 'assets');

  const server = http.createServer((req, res) => {
    // Loopback is not an authorisation boundary for a browser (PRD DASH-03).
    // A page the developer happens to have open can point a hostname it
    // controls at 127.0.0.1 and fetch from here -- DNS rebinding -- and the
    // same-origin policy does not help, because the page's origin *is* that
    // hostname. Nothing here mutates, so the risk is not a write; it is that
    // this payload now contains the developer's prompts, code and project
    // history, and a hostile page would be reading all of it.
    //
    // The check is the standard one: the request has to have been addressed to
    // loopback by name, which a rebound hostname never is.
    if (!fromLoopback(req.headers.host, req.headers.origin)) {
      return send(res, 403, 'text/plain', 'Eklavya serves loopback only.\n');
    }
    // Every route reads. Anything else is refused rather than answered as a GET.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'text/plain', 'Eklavya\'s dashboard is read-only.\n', { allow: 'GET, HEAD' });
    }
    const url = new URL(req.url ?? '/', `http://${host}`);
    try {
      if (url.pathname === '/api/state') {
        return send(res, 200, 'application/json', JSON.stringify(dashboardState(db)));
      }
      // The memory timeline is a paged resource rather than part of the state
      // payload: the corpus is the one thing here that grows without bound.
      if (url.pathname === '/api/memory') {
        const g = (k: string) => url.searchParams.get(k);
        return send(
          res,
          200,
          'application/json',
          JSON.stringify(
            memoryPage(db, {
              project: g('project'),
              session: g('session'),
              type: g('type'),
              tag: g('tag'),
              q: g('q'),
              since: g('since'),
              until: g('until'),
              page: Number(g('page')) || 1,
              per: Number(g('per')) || MEMORY_PER,
            }),
          ),
        );
      }
      if (url.pathname === '/api/projects') {
        return send(res, 200, 'application/json', JSON.stringify(projectInventory(db)));
      }
      if (url.pathname === '/api/memory/sessions') {
        const g = (k: string) => url.searchParams.get(k);
        return send(
          res,
          200,
          'application/json',
          JSON.stringify(
            memorySessionPage(db, {
              project: g('project'),
              session: g('session'),
              page: Number(g('page')) || 1,
              per: Number(g('per')) || MEMORY_PER,
            }),
          ),
        );
      }
      if (url.pathname === '/api/memory/entry') {
        const entry = memoryEntry(db, Number(url.searchParams.get('id')));
        if (!entry) return send(res, 404, 'application/json', '{"error":"no such entry"}');
        return send(res, 200, 'application/json', JSON.stringify(entry));
      }
      if (url.pathname.startsWith('/artifacts/')) {
        let id: string;
        try {
          id = decodeURIComponent(url.pathname.slice('/artifacts/'.length));
        } catch {
          return send(res, 400, 'text/plain', 'bad artifact path');
        }
        const file = resolveArtifact(id);
        if (!file) return send(res, 404, 'text/plain', 'no such artifact');
        return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(file), {
          'content-security-policy': ARTIFACT_CSP,
        });
      }
      if (url.pathname === '/tokens.css') {
        return send(res, 200, 'text/css', localTokens(fs.readFileSync(path.join(assets, 'tokens.css'), 'utf8')));
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(assets, 'dashboard.html')));
      }
      return send(res, 404, 'text/plain', 'not found');
    } catch (err) {
      return send(res, 500, 'text/plain', err instanceof Error ? err.message : 'error');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE' || opts.port !== undefined) return reject(err);
      server.listen(0, host);
    });
    server.on('listening', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : wanted;
      resolve({ url: `http://${host}:${port}`, close: () => server.close() });
    });
    server.listen(wanted, host);
  });
}
