/**
 * `eklavya dashboard` — the learning state as a local web page.
 *
 * The terminal report has to fit in twenty lines, so it answers "what now?".
 * This answers "am I getting better?", which needs history, per-project
 * comparison, per-concept history and the full concept list — none of which fit
 * in a paragraph.
 *
 * Deliberately a static page plus JSON endpoints: no framework, no build
 * step, same rule the landing page follows. It binds to loopback only — the
 * data never leaves the machine, and that is a promise the landing page makes
 * on Eklavya's behalf. It is read-only except the routes in `WRITES`, and every
 * one of those goes through `acceptWrite`: loopback Origin, JSON, the page's
 * per-start token and a size cap.
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
import { decayedScore, isKnown, isOwed, MS_PER_DAY } from './srs.js';
import {
  correctionStates, correctionTarget, CorrectionError, GLOBAL_PROJECT, levelStanding, PASSING_GRADE, projectKey, promoteIfEarned, recordRetry,
  type CorrectionErrorCode,
} from './store.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  findRepoConfig, LEGACY_REPO_CONFIG_FILE, loadConfig, loadGlobalConfig, loadProjectConfig, configFileProblem, isGlobalOnlyKey, mainRepoRoot,
  readConfigFile, normalizeLegacyKeys,
  type EklavyaConfig,
} from './config.js';
import { applySetting, knownKeys, SETTING_RULES, valueAt, type SettingRule } from './config-path.js';
import {
  artifactsDir, dashboardPort, dbPath, DEFAULT_PORT, eklavyaHome, globalConfigPath, projectConfigPath, projectsDir,
} from './paths.js';
import { ownVersion } from './dashboard-daemon.js';
import { countUse } from './telemetry.js';
import { acknowledgeFeedback, deleteFeedback, feedbackSummary, getFeedback, feedbackPending, listAcknowledged } from './feedback.js';
import { artifactsStamp, artifactThumb, listArtifacts, resolveArtifact, type ArtifactRow } from './artifacts.js';
import { LIMITS } from './tools/types.js';
import { DELIVERED, NOT_HELPER_RECEIPT, readTotals, receiptTotals, totalsDelivery } from './memory/store.js';
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
 * Cap on the attempt rows shipped for drill-down, newest first. Counts and
 * per-day totals are aggregated in SQL over the whole table, so the cap can only
 * ever shorten a history list, never make a number wrong: anything the page
 * counts, or narrows a project to, it takes from those aggregates and not from
 * these rows (`totals`, `concepts`, `daily`, and `projectInventory`'s per-project
 * counts, `totals` and `concept_slugs`).
 *
 * One number with `LOGGED_LIMIT`, and the one that sets the size of `/api/state`:
 * a row is about 0.85 KB (a question, its options, the answer and the tutor's
 * feedback), so these rows are over half of the payload. The budget for the
 * payload at a year of daily use is 1.5 MB (issue #171), and at 2,000 rows of
 * each kind it was 2.5 MB however the rest was trimmed: the two lists alone
 * were more than that. At this size it is 1.15 MB with a 25-character
 * repository path and 1.44 MB with a 105-character one (every row names its
 * repository, so the path's length is in the size), which is why the number is
 * not larger. `scripts/dashboard-perf.mjs medium` prints it.
 */
export const ATTEMPT_LIMIT = 800;
/**
 * Cap on the logged context lines (`session_concepts` rows) shipped in the
 * payload, newest first like `attempts` and the same size: one number for how
 * much history each kind of row brings. Each line carries its context text, so
 * the list grew without bound and was the largest key at scale; a learner with
 * fewer lines sees no change. `logged_shown` and `logged_total` say when it is
 * cut, as `attempts_shown` and `attempts_total` do, and every total stays right
 * because it is aggregated in SQL: `totals.sessions`, the concept catalogue's
 * last context, the project inventory (its counts, its `sessions`, its `totals`
 * across projects and the `concept_slugs` the page narrows a project to). A session whose lines fall
 * outside the cap is still opened through `/api/memory/sessions`
 * (`sessionLearning`).
 */
export const LOGGED_LIMIT = 800;
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
  /** Misses (and taught blanks) answered right later from their explainer. */
  corrected: number;
}

/**
 * A correction row (`retry_of`, migration 019) is a pick made on this page
 * after the explainer showed the answer, not a question asked: no count here
 * includes it. The miss it corrects is counted once, as `corrected` instead of
 * missed or skipped, by joining that row as `fix`.
 */
const NOT_CORRECTION = 'retry_of IS NULL';

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
  /** Correction rows: misses answered right later from their explainer. */
  corrected: number;
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

const days = (from: string, now: Date): number | null => {
  const t = parseTs(from);
  return Number.isFinite(t) ? Math.floor((now.getTime() - t) / MS_PER_DAY) : null;
};

/**
 * The config in force for one project row: `null` is the global scope.
 *
 * Per project, never the server's own cwd: the daemon serves every project from
 * one process, and started inside a checkout with `difficulty: "hard"` it used
 * to show every other project pinned at hard. Nothing here can stop the page
 * opening: a half-written or unreadable file reads as empty, and no working
 * directory is consulted, so a deleted one is no longer a failure to catch.
 */
const readConfig = (repo: string | null = null): EklavyaConfig => loadProjectConfig(repo).config;

/** Every project that has answers, by the key its rows carry. */
const answeredRepos = (db: DB): (string | null)[] =>
  many<{ repo: string | null }>(
    db,
    `SELECT DISTINCT NULLIF(trim(COALESCE(repo, '')), '') AS repo FROM attempts WHERE ${NOT_CORRECTION} ORDER BY repo`,
  ).map((r) => r.repo);

interface Configs {
  user: EklavyaConfig;
  /** Read so far, keyed as `levelStanding` is. */
  projects: Map<string | null, EklavyaConfig>;
  /** One project's config, read once per payload. */
  of: (repo: string | null) => EklavyaConfig;
}

/** The user settings, then each answered project's. */
function readConfigs(db: DB): Configs {
  const projects = new Map<string | null, EklavyaConfig>();
  const of = (repo: string | null): EklavyaConfig => {
    if (!projects.has(repo)) projects.set(repo, readConfig(repo));
    return projects.get(repo)!;
  };
  for (const repo of answeredRepos(db)) of(repo);
  return { user: readConfig(), projects, of };
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
function memorySummary(db: DB, events: EvidenceTotals): Record<string, unknown> {
  // One pass over the entries (each carries its narrative, so a pass reads the most bytes of any
  // table here) gives the totals and the types: a group per type, summed for the totals.
  const entries = { total: 0, live: 0, superseded: 0, deleted: 0, notes: 0 };
  const types: { type: string; n: number }[] = [];
  for (const g of many<{ type: string | null; n: number; live: number; superseded: number; deleted: number; notes: number }>(
    db,
    `SELECT type, count(*) AS n,
            SUM(deleted_at IS NULL AND superseded_by IS NULL) AS live,
            SUM(superseded_by IS NOT NULL) AS superseded,
            SUM(deleted_at IS NOT NULL) AS deleted,
            SUM(kind = 'note') AS notes
     FROM memory_entries GROUP BY type ORDER BY type`,
  )) {
    entries.total += g.n;
    entries.live += g.live;
    entries.superseded += g.superseded;
    entries.deleted += g.deleted;
    entries.notes += g.notes;
    // A type counts what is not deleted (superseded entries stay on the timeline, marked), so a type
    // with nothing left is not listed, and an entry with no type is `untyped`.
    if (g.n > g.deleted) types.push({ type: g.type ?? 'untyped', n: g.n - g.deleted });
  }
  // Largest first; equal counts keep the types' order. (The statement this replaced left equal counts
  // in whatever order its plan gave them, which was the opposite one until an index served it.)
  types.sort((a, b) => b.n - a.n);
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
    // … and the subset a hook actually wrote out, rather than only prepared.
    exposed: one<{ n: number }>(
      db,
      `SELECT count(DISTINCT i.entry_id) AS n FROM context_receipt_items i
       JOIN context_receipts r ON r.id = i.receipt_id WHERE r.${DELIVERED}`,
    ).n,
    // Concepts that came out of evidence and were then actually answered on.
    assessed: one<{ n: number }>(
      db,
      `SELECT count(DISTINCT ls.concept_id) AS n FROM learning_sources ls
       JOIN attempts a ON a.concept_id = ls.concept_id
       WHERE ls.concept_id IS NOT NULL`,
    ).n,
    candidates: Object.fromEntries(candidates.map((c) => [c.status, c.n])),
    types,
    // A tag row always names an entry (a foreign key), so while none is deleted every tag counts and
    // the entries need not be read again; once one is, only the live entries' tags do.
    tags: entries.deleted === 0
      ? many(db, `SELECT tag, count(*) AS n FROM memory_entry_tags GROUP BY tag ORDER BY n DESC, tag LIMIT 60`)
      : many(db, `SELECT t.tag, count(*) AS n FROM memory_entry_tags t
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
 * was actually delivered. Only context a hook wrote out (`emitted`, or a legacy
 * `confirmed`) contributes to the headline — `receiptTotals` sums those rows
 * alone, and `savingsFrom` refuses to divide for anything else, so a
 * "prepared" receipt can never be shown as a saving. `reads` counts explicit
 * memory reads, receipt or not, so a fetch without one is not lost.
 */
function reuseSummary(db: DB): Record<string, unknown> {
  const totals = receiptTotals(db);
  const savings = savingsFrom({
    baseTokens: totals.base,
    deliveredTokens: totals.delivered,
    delivery: totalsDelivery(totals),
  });
  return {
    ...totals,
    reads: readTotals(db),
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
function healthSummary(db: DB, config: EklavyaConfig, events: EvidenceTotals): Record<string, unknown> {
  return {
    capture: {
      enabled: config.memory.enabled,
      mode: config.memory.capture,
      newest_event: events.newest,
      newest_received: events.received,
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

/**
 * One row of the single read of `evidence_events`: a session's events under one
 * project and checkout. The overview's counts, the health panel's heartbeat, the
 * session list and the project inventory all derive from these, so the table
 * (the largest one, with a tool output on every row) is read once per build
 * instead of five times. The checkout is in the key only so the inventory can
 * see which checkouts were recorded under which project; every other reading
 * merges the groups that differ by it.
 */
interface EvidenceGroup {
  project: string;
  session_id: string;
  checkout: string | null;
  events: number;
  processed: number;
  pending: number;
  redacted: number;
  first: string;
  last: string;
  received: string;
}

/**
 * Every group, in `(project, session_id, checkout)` order: the order `GROUP BY`
 * already yields, spelled out because the inventory's rows are created in it.
 */
function evidenceGroups(db: DB): EvidenceGroup[] {
  // Every aggregate here is paid once per event (about 0.1 ms per thousand events
  // each), so a sum that follows from the others is taken from them once per
  // group: `status` is never null, so what is not processed is pending. A group
  // has rows, so its sums are numbers and need no default.
  return many<EvidenceGroup>(
    db,
    `SELECT project, session_id, checkout, count(*) AS events,
            SUM(status = 'summarized') AS processed,
            count(*) - SUM(status = 'summarized') AS pending,
            SUM(redacted) AS redacted,
            min(occurred_at) AS first, max(occurred_at) AS last, max(received_at) AS received
     FROM evidence_events
     GROUP BY project, session_id, checkout
     ORDER BY project, session_id, checkout`,
  );
}

/** What the overview and the health panel say about the whole table. */
interface EvidenceTotals {
  captured: number;
  processed: number;
  pending: number;
  redacted: number;
  newest: string | null;
  received: string | null;
}

/** The larger of two timestamps; `null` is no timestamp. They are ISO text, so text order is time order. */
const laterOf = (a: string | null, b: string): string => (a === null || b > a ? b : a);

function evidenceTotals(groups: EvidenceGroup[]): EvidenceTotals {
  const t: EvidenceTotals = { captured: 0, processed: 0, pending: 0, redacted: 0, newest: null, received: null };
  for (const g of groups) {
    t.captured += g.events;
    t.processed += g.processed;
    t.pending += g.pending;
    t.redacted += g.redacted;
    t.newest = laterOf(t.newest, g.last);
    t.received = laterOf(t.received, g.received);
  }
  return t;
}

/**
 * Text in the order SQLite sorts it (bytes of the UTF-8 form), which is not JavaScript's (UTF-16 units) for every string.
 * The two agree wherever the first difference is between characters below the surrogates (which is
 * every id and path people use), and the bytes are compared only where it is not.
 */
const binaryOrder = (a: string, b: string): number => {
  if (a === b) return 0;
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return x < 0xd800 && y < 0xd800 ? x - y : Buffer.compare(Buffer.from(a), Buffer.from(b));
  }
  return a.length - b.length;
};

/**
 * One row per session that captured evidence, newest first, so a session page can
 * link the two halves. A session that two projects both captured is two rows.
 * Equal newest events keep the order `GROUP BY session_id, project` gave them.
 */
function memorySessions(db: DB, groups: EvidenceGroup[]): Record<string, unknown>[] {
  const merged = new Map<string, { session_id: string; project: string; events: number; redacted: number; first: string; last: string }>();
  for (const g of groups) {
    const key = `${g.session_id}\u0000${g.project}`;
    const row = merged.get(key);
    if (!row) {
      merged.set(key, { session_id: g.session_id, project: g.project, events: g.events, redacted: g.redacted, first: g.first, last: g.last });
    } else {
      row.events += g.events;
      row.redacted += g.redacted;
      if (g.first < row.first) row.first = g.first;
      if (g.last > row.last) row.last = g.last;
    }
  }
  const newest = [...merged.values()]
    .sort((a, b) => binaryOrder(b.last, a.last) || binaryOrder(a.session_id, b.session_id) || binaryOrder(a.project, b.project))
    .slice(0, MEMORY_SESSION_LIMIT);
  // Counted by session alone, not by project, as this list always has. One pass
  // over each table rather than a lookup per row (the candidates one scans).
  const entries = new Map(
    many<{ session_id: string; n: number }>(
      db,
      'SELECT session_id, count(*) AS n FROM memory_entries WHERE session_id IS NOT NULL GROUP BY session_id',
    ).map((r) => [r.session_id, r.n]),
  );
  const candidates = new Map(
    many<{ session_id: string; n: number }>(
      db,
      `SELECT m.session_id, count(*) AS n FROM learning_sources ls JOIN memory_entries m ON m.id = ls.entry_id
       WHERE m.session_id IS NOT NULL GROUP BY m.session_id`,
    ).map((r) => [r.session_id, r.n]),
  );
  return newest.map((r) => ({ ...r, entries: entries.get(r.session_id) ?? 0, candidates: candidates.get(r.session_id) ?? 0 }));
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
 *
 * Two steps, so the cost follows the page and not the database: the key set
 * (which sessions there are, newest first, which is the total and the order),
 * then the counts for the page's own rows. Equal newest times keep the order
 * `GROUP BY session_id, project` gives them: session id, then project.
 *
 * Asking for one session (`session`) also answers for the learning half, which
 * is in neither table above: see `sessionLearning`. That is how the page opens
 * a session whose rows were cut from `logged` and `attempts`.
 *
 * One read transaction, so the key set and the counts under it are one snapshot
 * of the database. They were one statement before they were two, and another
 * process (a retention sweep, a purge) may delete rows at any moment: without
 * the snapshot a session's last row could go between the two reads, leaving a
 * key with nothing to count, and the page's first and last time would have no
 * time to take (an HTTP 500). A deferred transaction that only reads takes no
 * write lock and, in WAL, never blocks the writer it is a snapshot against.
 */
export function memorySessionPage(
  db: DB,
  q: { project?: string | null; session?: string | null; page?: number; per?: number } = {},
): Record<string, unknown> {
  return db.transaction(() => sessionPageRows(db, q))();
}

function sessionPageRows(
  db: DB,
  q: { project?: string | null; session?: string | null; page?: number; per?: number },
): Record<string, unknown> {
  const per = Math.min(MEMORY_PER_MAX, Math.max(1, Math.floor(q.per || MEMORY_PER)));
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.project) { where.push('project = ?'); args.push(q.project); }
  if (q.session) { where.push('session_id = ?'); args.push(q.session); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // The entries half never names a session that is NULL; an import can leave one.
  const entryClause = clause ? `${clause} AND session_id IS NOT NULL` : 'WHERE session_id IS NOT NULL';
  const keys = many<{ session_id: string; project: string }>(
    db,
    `SELECT session_id, project FROM (
       SELECT session_id, project, max(occurred_at) AS last FROM evidence_events ${clause} GROUP BY session_id, project
       UNION ALL
       SELECT session_id, project, max(occurred_at) FROM memory_entries ${entryClause} GROUP BY session_id, project)
     GROUP BY session_id, project ORDER BY max(last) DESC, session_id, project`,
    ...args,
    ...args,
  );
  const total = keys.length;
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(Math.max(1, Math.floor(q.page || 1)), pages);

  const evidence = db.prepare(
    `SELECT count(*) AS events, COALESCE(SUM(redacted), 0) AS redacted, COALESCE(SUM(status <> 'summarized'), 0) AS pending,
            min(occurred_at) AS first, max(occurred_at) AS last
     FROM evidence_events WHERE session_id = ? AND project = ?`,
  );
  const entries = db.prepare(
    `SELECT COALESCE(SUM(deleted_at IS NULL AND superseded_by IS NULL), 0) AS live, min(occurred_at) AS first, max(occurred_at) AS last
     FROM memory_entries WHERE session_id = ? AND project = ?`,
  );
  const candidates = db.prepare(
    `SELECT count(*) AS n FROM learning_sources ls JOIN memory_entries m ON m.id = ls.entry_id
     WHERE m.session_id = ? AND m.project = ?`,
  );
  const rows = keys.slice((p - 1) * per, p * per).map(({ session_id, project }) => {
    const e = evidence.get(session_id, project) as { events: number; redacted: number; pending: number; first: string | null; last: string | null };
    const m = entries.get(session_id, project) as { live: number; first: string | null; last: string | null };
    const c = candidates.get(session_id, project) as { n: number };
    // The key is in at least one table, so at least one side has times.
    const first = [e.first, m.first].filter((t): t is string => t !== null).reduce((a, b) => (b < a ? b : a));
    const last = [e.last, m.last].filter((t): t is string => t !== null).reduce((a, b) => (b > a ? b : a));
    return { session_id, project, events: e.events, redacted: e.redacted, pending: e.pending, first, last, entries: m.live, candidates: c.n };
  });
  return { total, page: p, pages, per, rows, ...(q.session ? { learning: sessionLearning(db, q.session) } : {}) };
}

/**
 * Everything one session logged and was asked, however old: the rows the state
 * payload cut (`LOGGED_LIMIT`, `ATTEMPT_LIMIT`) and the ones it never had to cut
 * because the session has no memory to list it under. Same row shapes as the
 * payload's `logged` and `attempts` (one query each, shared), so the page draws
 * a looked-up session exactly as one it already holds.
 *
 * Whole, and not narrowed by the page's project scope: which project a row
 * belongs to is the page's `pid()`, which folds worktrees and recorded
 * checkouts the way `projectInventory` does, and a second reading of that here
 * would be a second opinion. The session's attempts are capped at
 * `ATTEMPT_LIMIT` like every attempts list, with `attempts_total` to say so;
 * its logged lines are at most one per concept.
 */
function sessionLearning(db: DB, session: string): { logged: Record<string, unknown>[]; attempts: Record<string, unknown>[]; attempts_total: number } {
  return {
    logged: loggedRows(db, projectFolder(), -1, session),
    attempts: attemptRows(db, ATTEMPT_LIMIT, session),
    attempts_total: one<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM attempts a WHERE a.session_id = ? AND a.${NOT_CORRECTION}`,
      session,
    ).n,
  };
}

/** The id of a project whose rows carry no repository at all: recorded before projects were tracked. */
export const UNATTRIBUTED = '~';

/** The earliest and latest instant seen, in epoch milliseconds. */
interface Span {
  min: number | null;
  max: number | null;
}

/**
 * What the cards cannot be added up to: a concept or a session that two projects both have is one, not two. The
 * page reads these for the all-projects scope (`sessionTotal`, the Learning Dashboard's head), where the capped
 * lists of rows can say neither, and a project's own card for a single one.
 */
export interface InventoryTotals {
  /** Distinct sessions that logged a concept or were asked a question, in any project. */
  sessions: number;
  /** Distinct concepts the agent logged from its work (not a review), in any project. */
  logged_concepts: number;
  /** Of those, the ones any answer was recorded for. */
  logged_assessed_concepts: number;
}

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
    logged_concepts: number;
    /** Of `logged_concepts`, the ones a question was also asked about: the page's "recorded from your work, assessed". */
    logged_assessed_concepts: number;
    sessions: number; first: string | null; last: string | null;
    /**
     * Every concept an answer or a logged line (any origin) in this project names,
     * by slug, sorted: what the page narrows the concept list to. Exact however
     * many rows the payload's capped lists hold.
     */
    concept_slugs: string[];
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
  totals: InventoryTotals;
} {
  const evidence = evidenceGroups(db);
  const recorded = new Map<string, Set<string>>();
  for (const g of evidence) {
    if (g.checkout !== null && g.checkout !== g.project) {
      recorded.set(g.checkout, (recorded.get(g.checkout) ?? new Set()).add(g.project));
    }
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

  const byId = new Map<
    string,
    InventoryProject & {
      _assessed: Set<number>; _logged: Set<number>; _touched: Set<number>; _lsess: Set<string>; _msess: Set<string>;
      _lspan: Span; _mspan: Span;
    }
  >();
  const at = (raw: string | null, source: string) => {
    const id = canonical(raw);
    let p = byId.get(id);
    if (!p) {
      const kind = id === UNATTRIBUTED ? 'unattributed' : id === GLOBAL_PROJECT ? 'global' : 'repo';
      p = {
        id, kind, path: kind === 'repo' ? id : null, name: '', available: kind === 'repo' ? fs.existsSync(id) : null,
        sources: [], aliases: [],
        learning: {
          answers: 0, passed: 0, skipped: 0, assessed_concepts: 0, logged_concepts: 0, logged_assessed_concepts: 0,
          sessions: 0, first: null, last: null, concept_slugs: [],
        },
        memory: { events: 0, pending: 0, entries: 0, sessions: 0, receipts: 0, first: null, last: null },
        first_active: null, last_active: null,
        _assessed: new Set(), _logged: new Set(), _touched: new Set(), _lsess: new Set(), _msess: new Set(),
        _lspan: { min: null, max: null }, _mspan: { min: null, max: null },
      };
      byId.set(id, p);
    }
    if (!p.sources.includes(source)) p.sources.push(source);
    const v = raw?.trim();
    if (v && v !== id && !p.aliases.includes(v)) p.aliases.push(v);
    return p;
  };
  // Across every project: the sets whose union is not the sum of the cards.
  const every = { sessions: new Set<string>(), logged: new Set<number>(), assessed: new Set<number>() };
  const sessionIds = new Map<string, Set<string>>();
  const note = (sid: string, id: string) => sessionIds.set(sid, (sessionIds.get(sid) ?? new Set()).add(id));
  // Both timestamp shapes, read as instants (epoch milliseconds) so min/max compare as instants. A
  // group of one row has the same time at both ends and is read once; the instant becomes ISO
  // text once per project at the end, not once per row (it was most of this function's time).
  const epoch = (ts: string | null): number | null => {
    if (!ts) return null;
    const t = parseTs(ts);
    return Number.isFinite(t) ? t : null;
  };
  const span = (o: Span, first: string | null, last: string | null) => {
    const f = epoch(first);
    const l = last === first ? f : epoch(last);
    if (f !== null && (o.min === null || f < o.min)) o.min = f;
    if (l !== null && (o.max === null || l > o.max)) o.max = l;
  };
  const isoOf = (t: number | null) => (t === null ? null : new Date(t).toISOString());

  // Answers that name no repository: the project they count toward for the concept list is
  // settled below, once the sessions that prove one are known (as the page's `pid()` does).
  const blankAsked: [string | null, number][] = [];
  for (const r of many<{ repo: string | null; session_id: string | null; concept_id: number; n: number; passed: number; skipped: number; first: string; last: string }>(
    db,
    `SELECT repo, session_id, concept_id, count(*) AS n,
            SUM(grade >= ${PASSING_GRADE}) AS passed,
            SUM(outcome IN ('declined','dont_know')) AS skipped,
            min(ts) AS first, max(ts) AS last
     FROM attempts WHERE ${NOT_CORRECTION} GROUP BY repo, session_id, concept_id`,
  )) {
    const p = at(r.repo, 'attempts');
    p.learning.answers += r.n;
    p.learning.passed += r.passed;
    p.learning.skipped += r.skipped;
    p._assessed.add(r.concept_id);
    every.assessed.add(r.concept_id);
    if (r.repo?.trim()) p._touched.add(r.concept_id);
    else blankAsked.push([r.session_id, r.concept_id]);
    if (r.session_id) {
      p._lsess.add(r.session_id);
      every.sessions.add(r.session_id);
      if (r.repo?.trim()) note(r.session_id, p.id);
    }
    span(p._lspan, r.first, r.last);
  }
  // A miss corrected from its explainer counts as right, as on the Accuracy tile. They are the answers
  // that have a correction and did not pass (a handful), counted here by repository rather than by
  // a lookup made for every answer above; each one's project is already there.
  for (const r of many<{ repo: string | null; n: number }>(
    db,
    `SELECT a.repo, count(*) AS n FROM attempts a JOIN attempts fix ON fix.retry_of = a.id
     WHERE a.${NOT_CORRECTION} AND a.grade < ${PASSING_GRADE} GROUP BY a.repo`,
  )) {
    byId.get(canonical(r.repo))!.learning.passed += r.n;
  }
  // One row per project and session, whichever checkouts the events came from.
  for (const g of evidence) {
    const p = at(g.project, 'evidence');
    p.memory.events += g.events;
    p.memory.pending += g.pending;
    p._msess.add(g.session_id);
    note(g.session_id, p.id);
    span(p._mspan, g.first, g.last);
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
    if ((r.origin ?? 'work') === 'work') {
      p._logged.add(r.concept_id);
      every.logged.add(r.concept_id);
    }
    // Any origin: a concept a question was asked about is as much in the project as one its work touched.
    p._touched.add(r.concept_id);
    p._lsess.add(r.session_id);
    every.sessions.add(r.session_id);
    span(p._lspan, r.first, r.last);
  }
  // An answer with no repository belongs where its session was proven to belong, else nowhere.
  for (const [sid, concept] of blankAsked) byId.get((sid && sessionProjects[sid]) || UNATTRIBUTED)!._touched.add(concept);
  for (const r of many<{ project: string; session_id: string | null; live: number; first: string; last: string }>(
    db,
    `SELECT project, session_id, COALESCE(SUM(deleted_at IS NULL AND superseded_by IS NULL), 0) AS live,
            min(occurred_at) AS first, max(occurred_at) AS last
     FROM memory_entries GROUP BY project, session_id`,
  )) {
    const p = at(r.project, 'entries');
    p.memory.entries += r.live;
    if (r.session_id) p._msess.add(r.session_id);
    span(p._mspan, r.first, r.last);
  }
  for (const r of many<{ project: string; n: number }>(db, 'SELECT project, count(*) AS n FROM context_receipts GROUP BY project')) {
    at(r.project, 'receipts').memory.receipts += r.n;
  }
  for (const r of many<{ repo: string }>(db, 'SELECT repo FROM project_levels')) at(r.repo, 'levels');

  const slugs = new Map(many<{ id: number; slug: string }>(db, 'SELECT id, slug FROM concepts').map((c) => [c.id, c.slug]));
  const projects = [...byId.values()].map(({ _assessed, _logged, _touched, _lsess, _msess, _lspan, _mspan, ...p }) => {
    p.learning.assessed_concepts = _assessed.size;
    p.learning.logged_concepts = _logged.size;
    p.learning.logged_assessed_concepts = [..._logged].filter((id) => _assessed.has(id)).length;
    // Concepts exist for every row that names one (a foreign key), so every id has its slug.
    p.learning.concept_slugs = [..._touched].map((id) => slugs.get(id)!).sort();
    p.learning.sessions = _lsess.size;
    p.memory.sessions = _msess.size;
    p.learning.first = isoOf(_lspan.min);
    p.learning.last = isoOf(_lspan.max);
    p.memory.first = isoOf(_mspan.min);
    p.memory.last = isoOf(_mspan.max);
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
  const totals: InventoryTotals = {
    sessions: every.sessions.size,
    logged_concepts: every.logged.size,
    logged_assessed_concepts: [...every.logged].filter((id) => every.assessed.has(id)).length,
  };
  return { projects, aliases, sessions: sessionProjects, totals };
}

/**
 * What an open page is told about, to notice that work landed while it was
 * reading it (PRD DASH-01): `/api/events` streams it (`createLive`, which reads
 * it for as long as a page is listening) and `/api/cursor` returns it alone,
 * building no payload.
 *
 * Three parts, one per place the page's content comes from:
 * - `change_version` (migration 021), which triggers move on every write to a
 *   table the page shows. In-place edits count: a session summary rewritten
 *   as the session runs, a receipt delivered, a memory read logged.
 * - The effective config, hashed: the user dials the page prints and each
 *   project's own, which set that project's level and promotion runway.
 * - The artifact files' count, total size and newest mtime (`artifactsStamp`).
 *
 * Deliberately not `generated_at`, and not a hash of the payload: both change
 * on every call -- scores are decayed against the clock -- and a cursor that
 * moves on every call would redraw the page every second. Not watched: the
 * prune stamp and spool drop count in the health panel.
 */
export function changeCursor(db: DB, configs = readConfigs(db)): string {
  const version = one<{ n: number }>(db, 'SELECT n FROM change_version WHERE id = 1').n;
  const dials = createHash('sha256')
    .update(JSON.stringify([configs.user, [...configs.projects]]))
    .digest('hex')
    .slice(0, 12);
  return `${version}:${dials}:${artifactsStamp()}`;
}

/*
 * Serving a build once per cursor.
 *
 * A build is the expensive part of opening the page (the state alone is 20 ms
 * to a second, by the size of the database) and almost always rebuilds what the
 * last one said: the page reads the whole payload on every load and the server
 * is one thread. `changeCursor` is the version of everything the page shows and
 * costs a few milliseconds, so every read asks it first and rebuilds only when
 * it moved.
 *
 * One memo per database handle, in a WeakMap, never a global: tests and the
 * daemon hold several databases in one process, and each answers for its own.
 * The exported `settingsState` and `configurableProjects` read the same memo
 * as the server does, so a build is paid for once whoever asks first.
 *
 * Two inputs are not in the cursor, and both expire the build by time instead:
 * the clock (scores decay at read time, so `due` and `overdue_days` move
 * without a write) and the filesystem (a project's `available` flag, whether a
 * checkout still has its `.git`, what `listArtifacts` reads from the files).
 * The health panel's prune stamp and the spool's drop count are not in the
 * cursor either (see its comment) and ride the same minute: they show on the
 * next build, not the next request. One more input is left out of the cursor on
 * purpose and is too visible to wait a minute: `reviewFailed`.
 */

/** How long a build that reads the clock or the filesystem is served without being rebuilt. */
export const MEMO_TTL_MS = 60_000;
/** Serialised responses kept per database; the least recently used goes first. */
export const PAGE_CACHE_ENTRIES = 64;
/** A response larger than this many bytes is served but not kept, so one huge entry cannot pin megabytes. */
const PAGE_MAX_BYTES = 1024 * 1024;

type Inventory = ReturnType<typeof projectInventory>;
type Configurable = { id: string; name: string; inventory: string }[];

interface Memo {
  /** What the memo is valid for: `changeCursor` and `reviewFailed`, as they were when it took over, read before any build stored here. */
  cursor: string;
  /** The database's own part of that cursor: all the project inventory depends on besides the filesystem. */
  version: string;
  /**
   * `/api/state`, serialised once and kept as the bytes it is sent as: handing
   * `res.end` the 3.7 MB string re-encodes it on every request, 25 ms against
   * 5 for the same bytes, which is most of what a repeat would cost.
   */
  state: { at: number; body: Buffer } | null;
  /** The inventory, and the part of it Settings may write for, derived on first use. Read-only to callers. */
  inventory: { at: number; value: Inventory; configurable: Configurable | null } | null;
  /** Serialised responses by the full request URL, in least-recently-used order. */
  pages: Map<string, { at: number; stamp: string; body: Buffer }>;
}

const memos = new WeakMap<DB, Memo>();

/** The one route whose response a settings write changes. */
const SETTINGS_PATH = '/api/settings';

/**
 * Whether the last session Eklavya looked at for feedback could not be reviewed.
 *
 * `feedback_reviewed` has no change triggers, deliberately (migration 026, and
 * `migrate.test.ts` pins it): a session looked at and found quiet is not news
 * for an open page. But the state says "couldn't review the last session" from
 * it, and a page loaded a moment after that row landed has to say so, as it
 * did when every load was a build. So the memo asks, alongside the cursor.
 * An older schema without the table reads as not failed, as `feedbackSummary` does.
 */
function reviewFailed(db: DB): boolean {
  try {
    const last = one<{ outcome: string } | undefined>(
      db,
      'SELECT outcome FROM feedback_reviewed ORDER BY reviewed_at DESC, rowid DESC LIMIT 1',
    );
    return last?.outcome === 'failed';
  } catch {
    return false;
  }
}

/** Whether a build made at `at` may still be served at `now`. A clock that stepped back expires it too. */
const served = (at: number, now: number): boolean => now >= at && now - at < MEMO_TTL_MS;

/**
 * The memo for this database, valid for the cursor as it is right now (and for
 * `reviewFailed`, the one thing beside it that the state reads and the cursor does not).
 *
 * The cursor is read here, before any build that is stored in the memo, and
 * stays with it: a write that lands during a build makes the next read see a
 * newer cursor and rebuild, where reading it after would label a build with a
 * cursor newer than the rows it read. A change to the config or to an artifact
 * keeps the inventory, which reads neither: only the database's counter, the
 * first part of the cursor, drops it.
 */
function memoFor(db: DB): Memo {
  const cursor = changeCursor(db);
  const version = cursor.slice(0, cursor.indexOf(':'));
  const valid = `${cursor}|${reviewFailed(db)}`;
  let memo = memos.get(db);
  if (memo?.cursor !== valid) {
    memo = { cursor: valid, version, state: null, inventory: memo?.version === version ? memo.inventory : null, pages: new Map() };
    memos.set(db, memo);
  }
  return memo;
}

/** `/api/state` as the bytes it is sent as. Built at most once per cursor and minute. */
function stateBody(memo: Memo, db: DB): Buffer {
  const now = Date.now();
  if (memo.state && served(memo.state.at, now)) return memo.state.body;
  const body = Buffer.from(JSON.stringify(dashboardState(db)));
  memo.state = { at: now, body };
  return body;
}

/** The project inventory, rebuilt when the database moved, a minute passed, or the caller must not trust a memo. */
function inventoryOf(memo: Memo, db: DB, rebuild = false): NonNullable<Memo['inventory']> {
  const now = Date.now();
  if (rebuild || !memo.inventory || !served(memo.inventory.at, now)) {
    memo.inventory = { at: now, value: projectInventory(db), configurable: null };
  }
  return memo.inventory;
}

/**
 * One response by its full URL (path and query), most recently used last.
 *
 * `build` returns null for a response that is not a page worth keeping (an
 * entry that does not exist); it is not stored. `expires` is for a response
 * that reads the filesystem, and `stamp` for one whose inputs are files the
 * cursor does not cover: an entry made under another stamp is not served.
 */
function pageBody(
  memo: Memo,
  key: string,
  build: () => string | null,
  opts: { expires?: boolean; stamp?: () => string } = {},
): Buffer | null {
  const now = Date.now();
  const stamp = opts.stamp ? opts.stamp() : '';
  const hit = memo.pages.get(key);
  if (hit && hit.stamp === stamp && (!opts.expires || served(hit.at, now))) {
    memo.pages.delete(key);
    memo.pages.set(key, hit);
    return hit.body;
  }
  const json = build();
  // Replacing an entry must also move it: `Map.set` on a present key keeps its place.
  memo.pages.delete(key);
  if (json === null) return null;
  const body = Buffer.from(json);
  if (body.length <= PAGE_MAX_BYTES) {
    memo.pages.set(key, { at: now, stamp, body });
    while (memo.pages.size > PAGE_CACHE_ENTRIES) memo.pages.delete(memo.pages.keys().next().value!);
  }
  return body;
}

/** The state and the inventory, built now so the first request finds them. Throws as the builders do. */
function warmMemo(db: DB): void {
  const memo = memoFor(db);
  stateBody(memo, db);
  inventoryOf(memo, db);
}

/** What a settings write changed is on disk before any cursor or clock can say so: drop the pages that show it. */
function forgetSettings(db: DB): void {
  const pages = memos.get(db)?.pages;
  if (!pages) return;
  for (const key of pages.keys()) if (key.startsWith(SETTINGS_PATH)) pages.delete(key);
}

/** One file's identity and version, or `-` when there is none. Inode, size and nanosecond mtime: an atomic rewrite changes at least one. */
function fileStamp(file: string): string {
  try {
    const s = fs.statSync(file, { bigint: true });
    return `${s.ino}.${s.size}.${s.mtimeNs}`;
  } catch {
    return '-';
  }
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

/**
 * `projectKey`, once per distinct path in one build. It looks at the checkout's
 * `.git` on disk (a worktree folds into its main checkout), and a context line
 * carries the path of every session's repository: a statement per row is
 * thousands of statements for a few hundred distinct answers.
 */
function projectFolder(): (repo: string) => string {
  const keys = new Map<string, string>();
  return (repo) => {
    let key = keys.get(repo);
    if (key === undefined) {
      key = projectKey(repo);
      keys.set(repo, key);
    }
    return key;
  };
}

/**
 * Graded answers, newest first, as the page reads them: the payload's capped
 * history (`attempts`) and one session's own rows (`sessionLearning`) come from
 * this one statement, so they cannot drift apart. A correction row is a pick on
 * the explainer, not a question asked (`NOT_CORRECTION`), and rides on the row
 * it corrected.
 */
function attemptRows(db: DB, limit: number, session?: string): Record<string, unknown>[] {
  return many<Record<string, unknown>>(
    db,
    `SELECT a.id, c.slug, c.name, c.domain, a.session_id, a.question, a.answer, a.feedback,
            a.grade, a.difficulty AS tier, a.outcome, a.format, a.options, a.ts,
            NULLIF(trim(COALESCE(a.repo, '')), '') AS repo, a.level,
            -- A miss corrected from its explainer: when, and on which try.
            fix.ts AS corrected_at,
            CASE WHEN fix.id IS NULL THEN NULL
                 ELSE (SELECT count(*) FROM attempt_retries r WHERE r.attempt_id = a.id) END AS corrected_try
     FROM attempts a JOIN concepts c ON c.id = a.concept_id
     LEFT JOIN attempts fix ON fix.retry_of = a.id
     WHERE a.${NOT_CORRECTION}${session === undefined ? '' : ' AND a.session_id = ?'}
     ORDER BY a.id DESC
     LIMIT ?`,
    ...(session === undefined ? [] : [session]),
    limit,
  );
}

/**
 * The context lines the agent logged, newest first, as the page reads them: the
 * payload's capped list and one session's lines (`sessionLearning`, a `limit`
 * of -1, which SQLite reads as none). Equal times keep the order the rows were
 * written in, which is the order they have always had.
 *
 * `gates.repo` stays the worktree path -- the POSIX gate matches it against
 * `git rev-parse --show-toplevel`. Every other repo on this page comes from
 * `attempts`, already folded, so fold this one too or a project filter drops
 * every context line a worktree session logged.
 */
function loggedRows(db: DB, fold: (repo: string) => string, limit: number, session?: string): Record<string, unknown>[] {
  const rows = many<Record<string, unknown>>(
    db,
    `SELECT sc.session_id, c.slug, c.name, c.domain, sc.context, sc.ts, sc.origin,
            NULLIF(trim(COALESCE(g.repo, '')), '') AS repo
     FROM session_concepts sc
     JOIN concepts c ON c.id = sc.concept_id
     LEFT JOIN gates g ON g.session_id = sc.session_id
     ${session === undefined ? '' : 'WHERE sc.session_id = ?'}
     ORDER BY sc.ts DESC, sc.rowid
     LIMIT ?`,
    ...(session === undefined ? [] : [session]),
    limit,
  );
  for (const row of rows) row.repo = row.repo ? fold(row.repo as string) : null;
  return rows;
}

/** What the answers table says, for the day rows, the project rows, the totals and the catalogue. */
interface AnswerRollups {
  daily: DayRow[];
  projects: ProjectRow[];
  allTime: {
    answers: number; passed: number; missed: number; skipped: number; corrected: number;
    active_days: number; first_answer: string | null;
  };
  /** Per concept: the counts and the ids of its newest answer and its newest answer with a repository. */
  asked: Map<number, AskedRow>;
}

interface AskedRow {
  attempts: number;
  passed: number;
  skipped: number;
  corrected: number;
  first_asked: string | null;
  last_id: number | null;
  last_repo_id: number | null;
}

/**
 * Every number the page takes from `attempts` that is not a list of rows: the
 * per-day split, the per-project totals, the all-time totals and each concept's
 * counts. They were five statements, each reading the whole table and the
 * first two converting every timestamp to the learner's day (2 microseconds a
 * row, 19 ms at 10,000 answers); they are two statements now, one grouped by
 * day and repository and one by repository and concept, and a few sums in JS.
 *
 * Each figure is the one the statement it replaced gave, value for value: a
 * correction row is no answer (`NOT_CORRECTION`) but is counted as one
 * `corrected` against the miss it fixes, and an answer that was corrected is
 * neither missed nor skipped. That last exclusion is taken from the answers
 * that were corrected (a handful) instead of a join over every answer.
 */
function answerRollups(db: DB): AnswerRollups {
  // One group per local day, repository and side of the year's window: `recent` is the daily rows'
  // filter, the whole is the all-time total.
  // A time that is no time (an imported row) has no day: its group's day is null, as the day rows
  // have always had it, and it is no active day.
  interface DayGroup {
    day: string | null; repo: string | null; recent: number; answers: number; passed: number; missed: number; skipped: number; first: string;
  }
  const dayGroups = many<DayGroup>(
    db,
    `SELECT date(a.ts, 'localtime') AS day, NULLIF(trim(COALESCE(a.repo, '')), '') AS repo, a.ts >= date('now', ?) AS recent,
            count(*) AS answers,
            sum(CASE WHEN a.grade >= ${PASSING_GRADE} THEN 1 ELSE 0 END) AS passed,
            sum(CASE WHEN a.grade < ${PASSING_GRADE} AND (a.outcome IS NULL OR a.outcome = 'answered') THEN 1 ELSE 0 END) AS missed,
            sum(CASE WHEN a.outcome IN ('declined','dont_know') THEN 1 ELSE 0 END) AS skipped,
            min(a.ts) AS first
     FROM attempts a
     WHERE a.${NOT_CORRECTION}
     GROUP BY 1, 2, 3
     ORDER BY 1, 2, 3`,
    `-${TIMELINE_DAYS} days`,
  );
  // The same groups, over the answers that were corrected (a handful): what to take back out of
  // missed and skipped.
  const groupKey = (g: { day: string | null; repo: string | null; recent: number }) => `${g.day ?? ''}\u0000${g.repo ?? ''}\u0000${g.recent}`;
  const fixed = new Map<string, { fixed: number; missed: number; skipped: number }>();
  for (const f of many<{ day: string | null; repo: string | null; recent: number; fixed: number; missed: number; skipped: number }>(
    db,
    `SELECT date(a.ts, 'localtime') AS day, NULLIF(trim(COALESCE(a.repo, '')), '') AS repo, a.ts >= date('now', ?) AS recent,
            count(*) AS fixed,
            sum(CASE WHEN a.grade < ${PASSING_GRADE} AND (a.outcome IS NULL OR a.outcome = 'answered') THEN 1 ELSE 0 END) AS missed,
            sum(CASE WHEN a.outcome IN ('declined','dont_know') THEN 1 ELSE 0 END) AS skipped
     FROM attempts a JOIN attempts fix ON fix.retry_of = a.id
     WHERE a.${NOT_CORRECTION}
     GROUP BY 1, 2, 3`,
    `-${TIMELINE_DAYS} days`,
  )) {
    fixed.set(groupKey(f), f);
  }
  const none = { fixed: 0, missed: 0, skipped: 0 };
  const daily: DayRow[] = [];
  const allTime: AnswerRollups['allTime'] = { answers: 0, passed: 0, missed: 0, skipped: 0, corrected: 0, active_days: 0, first_answer: null };
  const activeDays = new Set<string>();
  for (const g of dayGroups) {
    // Every corrected answer is an answer, so its group is among these.
    const f = fixed.size === 0 ? none : fixed.get(groupKey(g)) ?? none;
    const missed = g.missed - f.missed;
    const skipped = g.skipped - f.skipped;
    allTime.answers += g.answers;
    allTime.passed += g.passed;
    allTime.missed += missed;
    allTime.skipped += skipped;
    allTime.corrected += f.fixed;
    if (g.day !== null) activeDays.add(g.day);
    if (allTime.first_answer === null || g.first < allTime.first_answer) allTime.first_answer = g.first;
    // The groups come in the order `GROUP BY day, repo` gave the rows they replace.
    if (g.recent) daily.push({ day: g.day as string, repo: g.repo, passed: g.passed, missed, skipped, corrected: f.fixed });
  }
  allTime.active_days = activeDays.size;

  // One group per repository and concept over the answers, which give the project rows and the
  // catalogue's counts, and the same over the corrections (an index finds them), which the
  // catalogue counts as `corrected` and which may be the newest row naming a repository.
  const asked = new Map<number, AskedRow>();
  const byRepo = new Map<string | null, ProjectRow>();
  const concept = (id: number): AskedRow => {
    let c = asked.get(id);
    if (c === undefined) {
      c = { attempts: 0, passed: 0, skipped: 0, corrected: 0, first_asked: null, last_id: null, last_repo_id: null };
      asked.set(id, c);
    }
    return c;
  };
  // Grouped by the repo column as written, which is how the project rows have always been grouped:
  // a project row is one per spelling (an empty repo, a blank one and an unset one are three rows,
  // each reading as no repository), and a catalogue row cannot tell them apart.
  for (const g of many<{
    raw: string | null; repo: string | null; concept_id: number; attempts: number; passed: number; skipped: number; first: string; last: string; last_id: number;
  }>(
    db,
    `SELECT a.repo AS raw, NULLIF(trim(COALESCE(a.repo, '')), '') AS repo, a.concept_id,
            count(*) AS attempts,
            sum(a.grade >= ${PASSING_GRADE}) AS passed,
            sum(a.outcome IN ('declined','dont_know')) AS skipped,
            min(a.ts) AS first, max(a.ts) AS last, max(a.id) AS last_id
     FROM attempts a
     WHERE a.${NOT_CORRECTION}
     GROUP BY a.repo, a.concept_id`,
  )) {
    const c = concept(g.concept_id);
    c.attempts += g.attempts;
    c.passed += g.passed;
    c.skipped += g.skipped;
    if (c.first_asked === null || g.first < c.first_asked) c.first_asked = g.first;
    if (c.last_id === null || g.last_id > c.last_id) c.last_id = g.last_id;
    if (g.repo !== null && (c.last_repo_id === null || g.last_id > c.last_repo_id)) c.last_repo_id = g.last_id;
    const p = byRepo.get(g.raw) ?? { repo: g.repo, answers: 0, passed: 0, skipped: 0, concepts: 0, first_active: g.first, last_active: g.last };
    byRepo.set(g.raw, p);
    p.answers += g.attempts;
    p.passed += g.passed;
    p.skipped += g.skipped;
    p.concepts += 1;
    if (g.first < p.first_active) p.first_active = g.first;
    if (g.last > p.last_active) p.last_active = g.last;
  }
  for (const g of many<{ repo: string | null; concept_id: number; corrections: number; last_id: number }>(
    db,
    `SELECT NULLIF(trim(COALESCE(a.repo, '')), '') AS repo, a.concept_id, count(*) AS corrections, max(a.id) AS last_id
     FROM attempts a
     WHERE a.retry_of IS NOT NULL
     GROUP BY 1, 2`,
  )) {
    const c = concept(g.concept_id);
    c.corrected += g.corrections;
    if (g.repo !== null && (c.last_repo_id === null || g.last_id > c.last_repo_id)) c.last_repo_id = g.last_id;
  }
  // Repositories came out in order, so equal last-active times keep it.
  const projects = [...byRepo.values()].sort((a, b) => (a.last_active === b.last_active ? 0 : a.last_active < b.last_active ? 1 : -1));
  return { daily, projects, allTime, asked };
}

export function dashboardState(db: DB): Record<string, unknown> {
  const now = new Date();
  const configs = readConfigs(db);
  // The overview's dials are the user settings: one machine-wide line cannot
  // speak for every project, and the server's cwd is not any project's choice.
  const config = configs.user;
  // First, before any of the payload is read: a write that lands while it is
  // being built moves the next cursor, so the page reads again and never misses it.
  const cursor = changeCursor(db, configs);

  // The numbers taken from `attempts` that are not lists of rows: one row per calendar day per
  // project (split three ways: `grade >= PASSING_GRADE` is the pass line the level ladder uses, so
  // the chart and the promotion agree), the per-project totals, the all-time totals and each
  // concept's counts. A null repo is the pre-migration-003 bucket. It is kept, not dropped:
  // hiding those rows would silently shrink every total on the page.
  const { daily, projects, allTime, asked } = answerRollups(db);

  // The catalogue with each concept's last context. The newest answer of a concept and its counts
  // come from the rollup above; the last context is one index lookup per concept
  // (migration 031), where this used to be eight correlated subqueries per concept over
  // `attempts` and `session_concepts`, the last of them reading every logged line.
  const lastGrade = db.prepare('SELECT grade FROM attempts WHERE id = ?').pluck();
  const lastRepo = db.prepare('SELECT repo FROM attempts WHERE id = ?').pluck();
  const conceptRows = (
    db
      .prepare(
        `SELECT c.id, c.slug, c.name, c.domain, c.description, c.tier, c.source,
                m.score, m.ease, m.interval_d, m.reps, m.next_review, m.last_seen,
                -- The latest context a session logged for the concept; equal times go to the row written first.
                (SELECT sc.context FROM session_concepts sc
                  WHERE sc.concept_id = c.id AND sc.context IS NOT NULL
                  ORDER BY sc.ts DESC, sc.rowid LIMIT 1) AS last_context
         FROM concepts c
         LEFT JOIN mastery m ON m.concept_id = c.id
         ORDER BY c.domain, c.tier, c.name, c.id`,
      )
      .all() as Omit<ConceptRow, 'attempts' | 'passed' | 'skipped' | 'corrected' | 'first_asked' | 'last_grade' | 'last_repo'>[]
  ).map((c): ConceptRow => {
    const a = asked.get(c.id);
    return {
      ...c,
      attempts: a?.attempts ?? 0,
      passed: a?.passed ?? 0,
      skipped: a?.skipped ?? 0,
      corrected: a?.corrected ?? 0,
      first_asked: a?.first_asked ?? null,
      // The backlog rule's grade (OWED_SQL in store.ts): a correction does not clear it.
      last_grade: a?.last_id != null ? (lastGrade.get(a.last_id) as number) : null,
      last_repo: a?.last_repo_id != null ? (lastRepo.get(a.last_repo_id) as string) : null,
    };
  });

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

    // The backlog rule (`isOwed`): only a question declined, blanked or missed
    // comes back. A correct answer's review date is decay's clock, not a debt,
    // so it is neither due nor upcoming.
    const owed = seen && row.last_grade != null && row.last_grade < PASSING_GRADE;
    const due = owed && isOwed(row.last_grade, row.next_review, now);
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
      corrected: row.corrected,
      last_grade: row.last_grade,
      mastered,
      owed,
      due,
      // `due` implies a parseable `next_review` (`isDue`), so it is never null here.
      overdue_days: due ? days(row.next_review!, now) : null,
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
  const attempts = attemptRows(db, ATTEMPT_LIMIT);

  // The context lines, which are what a concept means to *this* learner: the
  // code that taught it. Grouped by session on the page. Newest first and cut at
  // `LOGGED_LIMIT`, with the total beside it.
  const logged = loggedRows(db, projectFolder(), LOGGED_LIMIT);
  const loggedTotal =
    logged.length < LOGGED_LIMIT
      ? logged.length
      : one<{ n: number }>(db, 'SELECT count(*) AS n FROM session_concepts sc JOIN concepts c ON c.id = sc.concept_id').n;

  const sessionCount = (
    db.prepare('SELECT count(DISTINCT session_id) AS n FROM session_concepts').get() as { n: number }
  ).n;

  // The one read of evidence_events: the counts, the heartbeat and the session list all come from it.
  const evidence = evidenceGroups(db);
  const evidenceSummary = evidenceTotals(evidence);
  const memory = memorySummary(db, evidenceSummary);
  const reuse = reuseSummary(db);

  return {
    generated_at: now.toISOString(),
    db_path: dbPath(),
    cursor,
    timeline_days: TIMELINE_DAYS,
    attempts_shown: attempts.length,
    attempts_total: allTime.answers,
    // The same disclosure for the context lines: shown is what travelled, total
    // is every row, so a cut list cannot pass for the whole one.
    logged_shown: logged.length,
    logged_total: loggedTotal,
    // The user file's dials, before any project's overrides. Each project row
    // below carries the level and runway its own settings resolve to.
    config_scope: 'user',
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
      passed: allTime.passed,
      missed: allTime.missed,
      skipped: allTime.skipped,
      corrected: allTime.corrected,
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
      // Its own settings, as the CLI and the tools resolve them from inside it.
      const standing = levelStanding(db, configs.of(p.repo), p.repo);
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
    health: healthSummary(db, config, evidenceSummary),
    memory_sessions: memorySessions(db, evidence),
    // The third workflow. Read from the files themselves on every load
    // (`artifacts.ts`): there is no table to fall out of step with the disk.
    artifacts: artifactRows(db),
    // Switches and counts only: the prompt text comes from `/api/feedback`, to the page that shows it.
    feedback: feedbackSummary(db, config),
  };
}

/**
 * `listArtifacts`, plus whether each explainer can still be corrected:
 * `open`, `done`, or null for a page with no attempt, a plain artifact, or an
 * attempt recorded without its right answer. One query for all of them.
 */
function artifactRows(db: DB): (ArtifactRow & { correction: 'open' | 'done' | null })[] {
  const rows = listArtifacts();
  const ids = rows.filter((r) => r.kind === 'explainer' && r.attempt !== null).map((r) => r.attempt!);
  const states = correctionStates(db, ids);
  return rows.map((r) => ({ ...r, correction: (r.kind === 'explainer' && states.get(r.attempt!)) || null }));
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


/* ============================================================
   Settings: the one part of the dashboard that writes.
   ============================================================ */

export interface SettingField extends SettingRule {
  key: string;
  label: string;
  help: string;
  group: string;
  /** The input's step: 1 for whole numbers, 0.05 for a share. */
  step?: number;
}

/**
 * Every setting the Settings pages can change, in the order they show. A key
 * that is neither here nor in `CLI_ONLY` fails `dashboard.test.ts`, which is
 * what keeps the dashboard and `eklavya config set` describing one config: a
 * new key in `DEFAULT_CONFIG` has to be placed on one list or the other.
 * What each accepts is not written here: it is `SETTING_RULES`, the table the
 * CLI and `set_config` check against too, merged in below.
 */
const FIELDS: Omit<SettingField, 'type'>[] = [
  { key: 'quiz.enabled', group: 'Questions', label: 'Ask questions',
    help: 'Whether Eklavya asks about the work at all. Memory keeps recording either way.' },
  { key: 'quiz.enforced', group: 'Questions', label: 'Gate commits',
    help: 'Hold commits until the session\'s questions are passed. Off whenever questions are off.' },
  { key: 'quiz.only_on_changes', group: 'Questions', label: 'Only after code changes',
    help: 'Ask only in sessions that changed code in a git repository, so reading, research and plain questions are not quizzed.' },
  { key: 'quiz.panel', group: 'Questions', label: 'Quiz side panel (experimental)',
    help: 'Show questions in a side panel instead of Claude\'s question card, so Claude keeps working while you answer. Needs a supported Claude Code build; anywhere else the card is used. Off changes nothing.' },
  { key: 'focus', group: 'Questions', label: 'Focus',
    help: 'What is taught: the transferable concept, this codebase, or a topic you chose (needs a topic).' },
  { key: 'focus_topic', group: 'Questions', label: 'Learn topic',
    help: 'The topic "learn" focus teaches, e.g. caching. Ignored by the other focuses.' },
  { key: 'cadence', group: 'Questions', label: 'Cadence',
    help: 'As-you-go asks one question mid-task; end waits until the task is finished.' },
  { key: 'difficulty', group: 'Questions', label: 'Difficulty',
    help: 'Auto earns the level per project. A literal level pins it and stops progression.' },
  { key: 'explain_on_wrong', group: 'Questions', label: 'Explainer after a miss',
    help: 'Write and open an explainer page in the background when a question is missed.' },
  { key: 'delegate_work', group: 'Questions', label: 'Delegate while you learn',
    help: 'Hand non-trivial code changes to background agents and ask questions while they build. Needs as-you-go cadence for questions while waiting; under end they wait for the end of the task. Next session.' },
  { key: 'quiet', group: 'Questions', label: 'Quiet',
    help: 'Fewer status lines from Eklavya in the session.' },
  { key: 'max_questions_per_task', group: 'Pacing', label: 'Questions per task',
    help: 'The session budget. Under as-you-go cadence, questions asked mid-work come out of it.' },
  { key: 'min_minutes_between_quizzes', group: 'Pacing', label: 'Minutes between quizzes',
    help: 'Cooldown between whole quizzes. Enforced quizzing ignores it.' },
  { key: 'min_minutes_between_checkpoints', group: 'Pacing', label: 'Minutes between mid-work questions',
    help: 'Floor on the gap between single as-you-go questions. 0 asks at every seam.' },
  { key: 'max_new_concepts_per_session', group: 'Pacing', label: 'New concepts per session',
    help: 'Cap on concepts the agent may add to the catalogue in one session.' },
  { key: 'max_stop_blocks_per_session', group: 'Pacing', label: 'Stop-hook blocks per session',
    help: 'Hard backstop on how often the end-of-task check may hold a session.' },
  { key: 'domains_enabled', group: 'Pacing', label: 'Domains',
    help: 'Concept domains that may be asked about, one per line. * is every domain.' },
  { key: 'level_up_after', group: 'Levels', label: 'Answers to level up',
    help: 'Passing answers needed at a level, in one project, before it promotes.' },
  { key: 'level_up_accuracy', group: 'Levels', label: 'Accuracy to level up',
    help: 'Minimum accuracy over those answers, declines excluded (0 to 1).' },
  { key: 'pass_threshold', group: 'Levels', label: 'Pass threshold',
    help: 'Share of a gate\'s questions that must pass (0 to 1).' },
  { key: 'memory.enabled', group: 'Memory', label: 'Record memory',
    help: 'Capture what each session did. Independent of questions.' },
  { key: 'memory.capture', group: 'Memory', label: 'Capture',
    help: 'Minimal keeps prompts and session seams without recording every read.' },
  { key: 'memory.batch_max_events', group: 'Memory', label: 'Events per batch',
    help: 'Events per observation batch; the session seam flushes the rest.' },
  { key: 'memory.retention_days', group: 'Memory', label: 'Keep raw evidence (days)',
    help: 'Empty keeps raw evidence until you delete it.' },
  { key: 'retrieval.mode', group: 'Memory', label: 'Search',
    help: 'Hybrid fuses keyword and vector search.' },
  { key: 'retrieval.max_items', group: 'Memory', label: 'Recalled items',
    help: 'Entries offered at a session seam before any detail fetch.' },
  { key: 'retrieval.max_tokens', group: 'Memory', label: 'Recall budget (tokens)',
    help: 'Estimated tokens for the whole recalled block.' },
  { key: 'retrieval.cross_project', group: 'Memory', label: 'Recall across projects',
    help: 'Let another repository\'s memory be recalled here.' },
  { key: 'feedback.enabled', group: 'Feedback', label: 'Prompt feedback',
    help: 'Review one prompt from a finished session, using your later prompts to show what it left out, in the background, using your observer model. Needs memory on and an observer model.' },
  { key: 'privacy.exclude_paths', group: 'Privacy', label: 'Never capture paths',
    help: 'Path patterns, one per line, on top of the built-in credential paths.' },
  { key: 'privacy.exclude_tools', group: 'Privacy', label: 'Never capture tools',
    help: 'Tool names, one per line.' },
  { key: 'privacy.redact_patterns', group: 'Privacy', label: 'Extra redaction patterns',
    help: 'Regular expressions, one per line, on top of the built-in secret shapes.' },
  { key: 'auto_update', group: 'This machine', label: 'Update automatically',
    help: 'Install newer releases in the background at session start.' },
  { key: 'telemetry', group: 'This machine', label: 'Anonymous usage counts',
    help: 'The daily ping of counts and setting values. Never a path, name or text.' },
  { key: 'dashboard_autostart', group: 'This machine', label: 'Keep the dashboard running',
    help: 'Start this dashboard in the background at session start, and restart it after an update.' },
];

export const SETTINGS: SettingField[] = FIELDS.map((f) => {
  const rule = SETTING_RULES[f.key]!;
  return { ...f, ...rule, ...(rule.type === 'number' ? { step: rule.int ? 1 : 0.05 } : {}) };
});

/**
 * Settings the dashboard shows but will not change. Each sends this machine's
 * work somewhere else or runs a command (see `CLONED_FORBIDDEN` in config.ts),
 * so turning one on stays a typed command rather than a click on a page.
 */
export const CLI_ONLY: { key: string; why: string }[] = [
  { key: 'providers.observer', why: 'sends session evidence to a model' },
  { key: 'providers.embeddings', why: 'sends memory text to a model' },
  { key: 'notifications.enabled', why: 'posts to a webhook or runs a command' },
  { key: 'notifications.sinks', why: 'posts to a webhook or runs a command' },
  { key: 'sync.enabled', why: 'writes memory to a shared folder' },
  { key: 'sync.target', why: 'writes memory to a shared folder' },
  { key: 'sync.device_id', why: 'pins this device\'s sync identity' },
];

/** The Settings pages' projects, from an inventory: a checkout that still has its `.git`. */
function configurableFrom(inventory: Inventory): Configurable {
  const out = new Map<string, Configurable[number]>();
  for (const p of inventory.projects) {
    // A checkout, not just a directory: `loadConfig` finds the project file
    // through the repository, so a folder without `.git` would show the user
    // settings as if they were this project's.
    if (p.kind !== 'repo' || !p.available || !p.path || !fs.existsSync(path.join(p.path, '.git'))) continue;
    const root = mainRepoRoot(p.path);
    if (!out.has(root)) out.set(root, { id: root, name: p.name, inventory: p.id });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The memoized list for a memo already in hand; derived with the inventory, so it expires with it. */
const configurableOf = (memo: Memo, db: DB, rebuild = false): Configurable => {
  const slot = inventoryOf(memo, db, rebuild);
  return (slot.configurable ??= configurableFrom(slot.value));
};

/**
 * Projects the Settings pages may write for: an inventory project whose
 * checkout still exists. The POST checks against this list, so the page can
 * never name an arbitrary path to write settings for.
 *
 * Read from the per-cursor memo: the inventory behind it is six full-table
 * scans. A caller that is about to write passes `fresh` and gets a rebuild, so
 * a write is never validated against a minute-old picture of the filesystem;
 * that rebuild becomes the memo's.
 */
export function configurableProjects(db: DB, opts: { fresh?: boolean } = {}): Configurable {
  return configurableOf(memoFor(db), db, opts.fresh);
}

/** The project a `?project=` names, by its checkout or its inventory id. */
const pickProject = (projects: Configurable, root: string | null) =>
  root ? projects.find((p) => p.id === root || p.inventory === root) ?? null : null;

/**
 * What `/api/settings` reads that the cursor does not cover, as a string that
 * changes when any of it does.
 *
 * Files, by their stat and never by their content: the user file, and the named
 * project's. A project the inventory knows from memory alone has no answers, so
 * its settings file is in no cursor; a save from the terminal must still show on
 * the next read. Beside them, the legacy `<checkout>/.eklavya.json`, because
 * `loadConfig` still falls back to it for a project that has no settings file
 * outside the checkout (until a session moves it), and the page shows the
 * resolved values. It is a file a `git clone` may have brought, so it is
 * statted from the place `loadConfig` finds it and its bytes go nowhere near a
 * stamp.
 *
 * And when the project list inside the page was built. The list is the
 * inventory's, which expires on its own clock: a page built late in the
 * inventory's minute would otherwise carry that list a minute past the
 * inventory's expiry, and offer (and refuse a write to) a project the next
 * build would drop. With the build time in the stamp the page lives exactly as
 * long as the older of its two sources.
 */
function settingsStamp(memo: Memo, db: DB, root: string | null): string {
  const projects = configurableOf(memo, db);
  // Served or rebuilt by the line above, so the slot is there.
  const stamps = [String(memo.inventory!.at), fileStamp(globalConfigPath())];
  const project = pickProject(projects, root);
  if (project) {
    stamps.push(fileStamp(projectConfigPath(project.id)));
    const checkout = findRepoConfig(project.id).repoRoot;
    stamps.push(checkout ? fileStamp(path.join(checkout, LEGACY_REPO_CONFIG_FILE)) : '-');
  }
  return stamps.join('|');
}

const settingKeys = () => [...SETTINGS.map((f) => f.key), ...CLI_ONLY.map((c) => c.key)];
/** What one file sets, key by key, in today's spelling: a key absent here inherits. */
const setIn = (file: Record<string, unknown>) => {
  const raw = normalizeLegacyKeys(file);
  return Object.fromEntries(settingKeys().flatMap((k) => {
    const v = valueAt(raw as unknown as EklavyaConfig, k);
    return v === undefined ? [] : [[k, v]];
  }));
};
const effectiveOf = (c: EklavyaConfig) => Object.fromEntries(settingKeys().map((k) => [k, valueAt(c, k)]));

/** `GET /api/settings?project=<checkout>`: both files and what they resolve to. */
export function settingsState(db: DB, root: string | null): Record<string, unknown> {
  const projects = configurableProjects(db);
  const project = pickProject(projects, root);
  return {
    fields: SETTINGS,
    cli_only: CLI_ONLY,
    global_only: settingKeys().filter(isGlobalOnlyKey),
    known: knownKeys(),
    projects,
    user: {
      path: globalConfigPath(),
      set: setIn(readConfigFile(globalConfigPath())),
      effective: effectiveOf(loadGlobalConfig()),
    },
    project: project && {
      ...project,
      path: projectConfigPath(project.id),
      set: setIn(readConfigFile(projectConfigPath(project.id))),
      effective: effectiveOf(loadConfig(project.id).config),
    },
    problem: configFileProblem(project?.id ?? eklavyaHome()),
  };
}

/** `POST /api/settings`: `{ scope: 'user'|'project', project?, key, value | unset: true }`. */
export function updateSetting(db: DB, body: unknown): { status: number; body: Record<string, unknown> } {
  const bad = (error: string) => ({ status: 400, body: { error } });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Expected a JSON object.');
  const b = body as Record<string, unknown>;
  if (b.scope !== 'user' && b.scope !== 'project') return bad('scope is "user" or "project".');
  const f = SETTINGS.find((x) => x.key === b.key);
  if (!f) {
    const cli = CLI_ONLY.find((x) => x.key === b.key);
    return bad(cli ? `${cli.key} ${cli.why}, so it is changed from the terminal: eklavya config set ${cli.key} <value>`
      : `Unknown setting ${JSON.stringify(b.key)}.`);
  }
  let root: string | null = null;
  if (b.scope === 'project') {
    // A write is checked against the filesystem as it is, not as a minute ago.
    const p = configurableProjects(db, { fresh: true }).find((x) => x.id === b.project);
    if (!p) return bad('That project is not one this dashboard can configure.');
    if (isGlobalOnlyKey(f.key)) return bad(`${f.key} is set once for the whole machine, in your user settings.`);
    root = p.id;
  }
  const unset = b.unset === true;
  if (!unset && b.value === undefined) return bad('Send a value, or unset: true.');
  // Every rule -- range, type, list items, combinations -- is `applySetting`'s,
  // so this refuses exactly what `eklavya config set` refuses, in its words.
  try {
    const { target } = applySetting(f.key, unset ? undefined : b.value, root);
    forgetSettings(db);
    return { status: 200, body: { ok: true, key: f.key, target, unset } };
  } catch (err) {
    return bad(err instanceof Error ? err.message : String(err));
  }
}

// Room for the largest value `SETTING_RULES` accepts — 100 list lines of 500
// characters, JSON-escaped — so the page refuses nothing the CLI would take.
const MAX_SETTINGS_BODY = 256 * 1024;

/** Each refusal a correction can meet: its status and the words the modal shows. */
const CORRECTION_ERRORS: Record<CorrectionErrorCode, { status: number; error: string }> = {
  not_found: { status: 404, error: 'No such question.' },
  not_correctable: { status: 409, error: 'This answer cannot be corrected: it was recorded without its right answer, or it was not a miss.' },
  already_corrected: { status: 409, error: 'Already corrected.' },
  not_an_option: { status: 400, error: 'That is not one of the options.' },
};

function correctionError(code: CorrectionErrorCode): { status: number; body: Record<string, unknown> } {
  const e = CORRECTION_ERRORS[code];
  return { status: e.status, body: { error: e.error, code } };
}

/**
 * `GET /api/attempts/correction?id=`: the missed question the correction modal
 * shows. Never the right answer -- the server grades a pick, the page does not.
 */
export function correctionState(db: DB, id: number): { status: number; body: Record<string, unknown> } {
  const t = correctionTarget(db, id);
  if (!t) return correctionError('not_found');
  if (!t.correctable) return correctionError('not_correctable');
  const { correct: _answer, correctable: _c, ...shown } = t;
  return { status: 200, body: shown };
}

/** `POST /api/attempts/retry`: `{ attempt_id, picked }`, one pick on the correction modal. */
export function retryAttempt(db: DB, body: unknown): { status: number; body: Record<string, unknown> } {
  const bad = (error: string) => ({ status: 400, body: { error } });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Expected a JSON object.');
  const { attempt_id: id, picked } = body as Record<string, unknown>;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return bad('attempt_id is a positive integer.');
  if (typeof picked !== 'string' || picked.length > LIMITS.option) return bad('picked is the option label, as text.');
  try {
    const out = db.transaction(() => {
      const r = recordRetry(db, id, picked, new Date());
      // A corrected miss is a pass for the level, so it can be the one that completes it.
      if (r.corrected) {
        const { repo } = db.prepare('SELECT repo FROM attempts WHERE id = ?').get(id) as { repo: string | null };
        const root = repo && repo !== GLOBAL_PROJECT ? repo : null;
        promoteIfEarned(db, loadProjectConfig(root).config, root);
      }
      return r;
    })();
    return { status: 200, body: out };
  } catch (err) {
    if (err instanceof CorrectionError) return correctionError(err.code);
    throw err;
  }
}

/** `GET /api/feedback[?id=]`: one item (the pending one without an id). Reading never acknowledges. */
export function feedbackItem(db: DB, id: string | null): { status: number; body: Record<string, unknown> } {
  const row = id === null ? feedbackPending(db) : getFeedback(db, Number(id));
  if (!row) return id === null ? { status: 200, body: { item: null } } : { status: 404, body: { error: 'not_found' } };
  const { session_id: _s, event_id: _e, model: _m, ...item } = row;
  return { status: 200, body: { item } };
}

const feedbackId = (body: unknown): number | null => {
  const id = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).id : undefined;
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 1 ? id : null;
};
const BAD_FEEDBACK_ID = { status: 400, body: { error: 'id is a positive integer.' } };
const NO_FEEDBACK = { status: 404, body: { error: 'not_found' } };

/**
 * `POST /api/feedback/acknowledge`: the only thing that sets `acknowledged_at`.
 * A repeat is a 200 `already` and writes nothing.
 */
export function acknowledgeItem(db: DB, body: unknown): { status: number; body: Record<string, unknown> } {
  const id = feedbackId(body);
  if (id === null) return BAD_FEEDBACK_ID;
  const result = acknowledgeFeedback(db, id);
  if (result === 'not_found') return NO_FEEDBACK;
  return { status: 200, body: { ok: true, result, state: feedbackSummary(db, readConfig()) } };
}

/** `POST /api/feedback/delete`: removes an item, pending or not. Not an acknowledgement. */
export function deleteItem(db: DB, body: unknown): { status: number; body: Record<string, unknown> } {
  const id = feedbackId(body);
  if (id === null) return BAD_FEEDBACK_ID;
  if (!deleteFeedback(db, id)) return NO_FEEDBACK;
  return { status: 200, body: { ok: true, state: feedbackSummary(db, readConfig()) } };
}

/** How the reader got to the Feedback page. A closed list: anything else is a typed or bookmarked link. */
const OPENED_VIA = ['greeting', 'badge', 'direct'];

/**
 * `POST /api/feedback/opened`: `{ via }`, sent once when the Feedback page opens
 * with an item waiting. Counted as `feedback:opened_<via>` in the usage
 * counters, a count and a closed word and nothing the reader wrote.
 */
export function openedItem(db: DB, body: unknown): { status: number; body: Record<string, unknown> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, body: { error: 'Expected a JSON object.' } };
  const via = (body as Record<string, unknown>).via;
  if (feedbackPending(db)) countUse(db, `feedback:opened_${OPENED_VIA.includes(via as string) ? via : 'direct'}`);
  return { status: 200, body: { ok: true } };
}

/** One write: validates its own body, never trusts it, and answers with JSON. */
export type WriteHandler = (db: DB, body: unknown) => { status: number; body: Record<string, unknown> };

/**
 * Every route that writes, and nothing else does. Exact paths, no parameters:
 * a write carries its target in its JSON body. A new write is one row here and
 * one handler; `acceptWrite` gives it the same guard as the rest, and the
 * table-driven test in `dashboard.test.ts` runs every guard against it.
 */
export const WRITES: Record<string, { handler: WriteHandler; maxBytes: number }> = {
  '/api/settings': { handler: updateSetting, maxBytes: MAX_SETTINGS_BODY },
  // An option label is at most LIMITS.option characters; 16 KiB holds one
  // JSON-escaped with room to spare.
  '/api/attempts/retry': { handler: retryAttempt, maxBytes: 16 * 1024 },
  // `{ id }` and nothing else.
  '/api/feedback/acknowledge': { handler: acknowledgeItem, maxBytes: 16 * 1024 },
  '/api/feedback/delete': { handler: deleteItem, maxBytes: 16 * 1024 },
  '/api/feedback/opened': { handler: openedItem, maxBytes: 16 * 1024 },
};

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
  // The dashboard's explainer viewer frames it (`#/artifacts/view/`); the
  // sandbox above still keeps the framed page off the API.
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * The same page framed in the dashboard's viewer (`?embed`). The dashboard
 * makes no request to any other host, and a framed page's requests are the
 * dashboard's, so the web fonts go: the template's links are cut out
 * (`withoutWebFonts`), and this CSP refuses any that an agent added.
 */
const ARTIFACT_EMBED_CSP = ARTIFACT_CSP
  .replace(" https://fonts.googleapis.com", '')
  .replace('font-src https://fonts.gstatic.com', "font-src 'none'");

/** An artifact without its Google Fonts links; it falls back to the system faces in the token stacks. */
export function withoutWebFonts(html: string): string {
  return html.replace(/<link\b[^>]*\bhref="https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/gi, '');
}

/**
 * Added to every page the viewer frames, so the window is the one scrollbar:
 * the page stops scrolling itself and reports its height, which the viewer
 * gives the frame. The height is where an empty block appended after the
 * content sits, margins included: it shrinks when the window widens
 * (`scrollHeight` cannot drop below the frame) and ignores a body set to 100%
 * of the frame. Pages on disk carry
 * `main{min-height:100vh}`, and 100vh is the frame, so that floor goes too.
 * Content that still grows with the frame (another 100vh box) outruns every
 * report: after three in a row the page asks to scroll itself
 * (`eklavya:scroll`). Past the viewer's 20000px cap it scrolls itself too.
 * Nothing is reported before the frame has a width: one word per line measures
 * tens of thousands of pixels, and if that report lands last the frame sits at
 * the cap, never resizes, and the outrun count never reaches three.
 */
// ponytail: in-flow content only, watched as it was when the script ran: an absolutely
// positioned box below the end, or a block a page script appends to <body> later, is not counted.
export const EMBED_SCRIPT = `<script>
(function () {
  if (parent === window || window.__eklavyaEmbed) return; window.__eklavyaEmbed = 1;
  var root = document.documentElement, body = document.body, kids = [].slice.call(body.children), last = 0, strikes = 0, width = innerWidth;
  var css = document.createElement('style'), end = body.appendChild(document.createElement('div')), seen = window.ResizeObserver && new ResizeObserver(post);
  css.textContent = 'html,body{overflow-y:hidden !important}.framed main{min-height:0 !important}'; end.style.clear = 'both';
  root.classList.add('framed'); (document.head || root).appendChild(css);
  function measure() {
    var s = getComputedStyle(body);
    return Math.ceil(end.getBoundingClientRect().top + scrollY + parseFloat(s.paddingBottom) + parseFloat(s.marginBottom));
  }
  function post() {
    if (!innerWidth) return; var h = strikes > 2 ? last : measure();
    css.disabled = strikes > 2 || h > 20000;
    if (h !== last) { last = h; parent.postMessage({ type: 'eklavya:height', h: h }, '*'); }
  }
  addEventListener('resize', function () {
    strikes = innerWidth === width && measure() > innerHeight + 1 ? strikes + 1 : 0; width = innerWidth;
    if (strikes > 2) { css.disabled = true; parent.postMessage({ type: 'eklavya:scroll' }, '*'); }
  });
  post(); addEventListener('DOMContentLoaded', post); addEventListener('load', post); if (document.fonts) document.fonts.ready.then(post);
  if (seen) [body].concat(kids).forEach(function (el) { seen.observe(el); });
  addEventListener('message', function (e) { var d = e.data; if (e.source === parent && d && d.type === 'eklavya:mode' && (d.mode === 'ink' || d.mode === 'paper')) root.setAttribute('data-mode', d.mode); });
})();
</script>`;

/**
 * The page as the viewer frames it: no web fonts, and `EMBED_SCRIPT` just
 * before the last `</body>` (or at the end). A 1.46.0 page carries its own
 * height report, inside the script that also holds its HTML button; renaming
 * its message keeps that button and takes the stale height out of the race.
 */
export function embedHtml(html: string): string {
  const page = withoutWebFonts(html).replace(/type:'eklavya:height'/g, "type:'eklavya:height-1.46'");
  const at = page.toLowerCase().lastIndexOf('</body>');
  return at < 0 ? page + EMBED_SCRIPT : page.slice(0, at) + EMBED_SCRIPT + page.slice(at);
}

/**
 * What makes the page installable as an app (Chrome and Edge "Install",
 * Safari "Add to Dock"), so it opens from Spotlight or the Dock in its own
 * window. Loopback counts as a secure context, so no certificate is needed, and
 * no service worker either: an offline copy of a live record would only lie.
 * The app belongs to this exact origin, port included.
 */
const MANIFEST = JSON.stringify({
  id: '/',
  name: 'Eklavya Dashboard',
  short_name: 'Eklavya',
  description: 'Your Eklavya learning progress, project memory, artifacts and settings.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#17171a',
  theme_color: '#17171a',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
});
/** Served from the bundled assets as-is; copied in from `web/public` at build. */
const APP_ICONS = new Set(['/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']);

/** Explicit mascot allowlist: no user-controlled filesystem paths. */
const MASCOT_ASSETS = new Map<string, [string, string]>([
  ['/brand/mascot/mascot.js', ['mascot/mascot.js', 'text/javascript; charset=utf-8']],
  ['/brand/mascot/mascot.css', ['mascot/mascot.css', 'text/css; charset=utf-8']],
  ['/mascot.html', ['mascot.html', 'text/html; charset=utf-8']],
]);
/** The tips library, copied from node_modules at build by `copy-assets.mjs`. */
const VENDOR: Record<string, string> = { '/vendor/driver-hints.js': 'text/javascript', '/vendor/driver-hints.css': 'text/css' };

/** What a file that only changes with a release may be kept for: this browser, an hour. */
const CACHE_HOUR = 'private, max-age=3600';

/**
 * Whether an `If-None-Match` header names `etag`. A comparison for a GET is
 * weak (RFC 9110 §13.1.2), so `W/"x"` names `"x"`; the header may be a list,
 * with any spacing, or `*` for any version at all. Anything that is not a
 * quoted tag is ignored, never matched.
 */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === '*') return true;
  return (header.match(/(?:W\/)?"[^"]*"/g) ?? []).some((tag) => tag.replace(/^W\//, '') === etag);
}

/** What every response carries: its type, `no-store`, `SECURITY_HEADERS`, then whatever the route overrides. The event stream, which is not sent in one piece, shares it. */
const headersFor = (type: string, extra: Record<string, string> = {}): Record<string, string> => ({
  'content-type': type,
  'cache-control': 'no-store',
  ...SECURITY_HEADERS,
  ...extra,
});

/**
 * Every response goes out here, so every one carries `SECURITY_HEADERS`.
 *
 * JSON is never cached (`no-store`, the default): a dashboard read from a stale
 * cache is one that lies about progress made ten seconds ago, which is the one
 * thing it is for, and the server's own memo is what makes a repeat cheap, not
 * the browser's. A file may be, because nothing about it moves with the
 * learner: the tokens, the mascot and the tips library stay an hour
 * (`CACHE_HOUR`); the page itself is `no-cache` with an `ETag`, so the browser
 * keeps it but asks, in one round trip, whether it is still the one this
 * server start wrote (the write token is in it). A caller passes `extra` to say so.
 */
function send(
  res: http.ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, headersFor(type, extra));
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

/*
 * Live updates: `GET /api/events`.
 *
 * What an open page needs is to be told that something changed, so it can fetch
 * what. The stream carries one thing, the change cursor (`changeCursor`, the
 * string `/api/state` carries in its `cursor`): `event: cursor` and `data:
 * <cursor>` at once on connect, then one more each time it moves, and a
 * `: keep-alive` comment every `keepAliveMs` so nothing between here and the
 * browser closes a quiet stream. The payload stays one source of truth: the
 * stream says *that*, `/api/state` says *what*. `/api/cursor` is unchanged, for
 * older pages and for anything that polls.
 *
 * The writers are other processes (hooks, the MCP server, the CLI, the
 * observer), so the server can only learn of a change by reading the database
 * and the filesystem, which a watcher does for as long as a stream is open and
 * not a moment longer:
 *
 * - The floor: `changeCursor` every `floorMs`. It is 0.5 to 3 ms, and it is
 *   what keeps the stream correct on a filesystem where `fs.watch` is silent
 *   (a network mount, an editor that replaces a file instead of writing it).
 * - The early trigger: `fs.watch` on the database's `-wal` file, the user's
 *   config file, the project config area and the artifacts folder, debounced by
 *   `debounceMs` into one check. Every one of those is optional. A directory
 *   that is not there yet, an `error` event: that watch is skipped or dropped
 *   and the floor carries on. The `-wal` is watched through its directory,
 *   filtered by name, because the file may not exist yet and is replaced when
 *   the database is checkpointed; `-shm` and the database file are never
 *   watched, because a reader touches them and the watcher's own reads must not
 *   retrigger it.
 *   The project config area and the artifacts folder hold their files one level
 *   down (`<folder>/<file>`), and each folder is watched by itself, not through
 *   one recursive watch: on Linux Node's recursive watch holds one watch per
 *   file inode, so the first atomic rewrite of a file (a temporary file renamed
 *   over it, which is how every config write is made, and how most editors save)
 *   leaves the new file unwatched, and every later change to it went unseen. A
 *   watch on the folder names each entry that is replaced in it, however often.
 *   The area's own watch tells of a new or removed folder, and a watch is made
 *   or dropped for it then.
 * - On a change the memo is refreshed first (the state and the inventory, so
 *   the fetch the event provokes is a repeat), then every stream is written.
 *   Between changes the watcher costs a cursor read a second and no read route
 *   waits on it; on a change it pays, once, for the rebuild the next read would
 *   have made anyway, and that rebuild is the single thread's for as long as it
 *   takes (the builders' cost, unchanged).
 * - A write the dashboard itself accepted checks at once (`bump`) instead of
 *   waiting for the floor, and does nothing when no stream is open.
 *
 * A stream that will not take a write (its buffer is full: the reader has not
 * read for a long time) is cut, not buffered for; the browser reconnects and
 * the connect event is the current cursor, so it loses nothing.
 */

/** How often the watcher reads `changeCursor` while a stream is open. The floor: correct even where `fs.watch` is not. */
export const EVENTS_FLOOR_MS = 1000;
/** How long after the last filesystem event the early check waits, so a burst of writes (a hook logging eight concepts) is one check. */
export const EVENTS_DEBOUNCE_MS = 150;
/** An open stream is written to this often when nothing changed, so a proxy or a browser does not close it for silence. */
export const EVENTS_KEEPALIVE_MS = 25_000;
/**
 * Open streams at once; the next gets a 503. A browser allows six HTTP/1.1
 * connections to one origin and every stream holds one for as long as it is
 * open, so one tab uses one of its six and leaves the page five for its own
 * fetches; the page closes its stream while its tab is hidden, which keeps the
 * count at the tabs being read. Thirty-two is several browsers with several
 * tabs each plus the odd `curl`, with room to spare, and still bounds what a
 * client that opens streams in a loop can cost: a socket and a few bytes of
 * writes each per change.
 */
export const EVENTS_MAX_STREAMS = 32;

/** The route's intervals and cap. `startDashboard` takes any of them in `opts.live`, so tests run in milliseconds. */
export interface LiveOptions {
  floorMs: number;
  debounceMs: number;
  keepAliveMs: number;
  maxStreams: number;
}

export const LIVE_DEFAULTS: Readonly<LiveOptions> = {
  floorMs: EVENTS_FLOOR_MS,
  debounceMs: EVENTS_DEBOUNCE_MS,
  keepAliveMs: EVENTS_KEEPALIVE_MS,
  maxStreams: EVENTS_MAX_STREAMS,
};

const EVENTS_PATH = '/api/events';

interface Live {
  /** Opens a stream on a GET. Throws, before anything is written, if the cursor cannot be read. */
  connect(res: http.ServerResponse): void;
  /** Checks for a change now. A no-op with no stream open. */
  bump(): void;
  /**
   * Ends every stream and stops the watcher and its timers, for good: a stream
   * asked for afterwards is refused. Harmless twice.
   */
  shutdown(): void;
}

/** A directory to watch, and which names in it are worth a check. */
interface WatchTarget {
  dir: string;
  match: (name: string) => boolean;
}

/** A directory of folders whose files the cursor reads (`<root>/<folder>/<file>`), and which file names are worth a check. */
interface WatchTree {
  root: string;
  match: (file: string) => boolean;
}

/** One watcher and its streams, for one server: nothing runs until the first stream opens and nothing outlives the last. */
function createLive(db: DB, opts: Partial<LiveOptions>): Live {
  const { floorMs, debounceMs, keepAliveMs, maxStreams } = { ...LIVE_DEFAULTS, ...opts };
  const streams = new Set<http.ServerResponse>();
  /** The cursor the open streams have been sent last. */
  let last = '';
  let floor: NodeJS.Timeout | undefined;
  let keepAlive: NodeJS.Timeout | undefined;
  let debounce: NodeJS.Timeout | undefined;
  /** Set by `shutdown` and never cleared: the server it belongs to is closing and does not open again. */
  let closed = false;
  /** Every watch that is open, so `stop` can close each one and one that failed is not closed twice. */
  const watchers = new Set<fs.FSWatcher>();

  const push = (res: http.ServerResponse, chunk: string): void => {
    if (!res.write(chunk)) res.destroy();
  };
  const emit = (cursor: string): void => {
    for (const res of streams) push(res, `event: cursor\ndata: ${cursor}\n\n`);
  };

  /**
   * Reads the cursor; when it moved and someone is listening, refreshes the memo
   * and tells them. Returns the cursor as read. Throws as `changeCursor` does.
   */
  const check = (): string => {
    const cursor = changeCursor(db);
    if (cursor === last) return cursor;
    last = cursor;
    if (streams.size > 0) {
      try {
        warmMemo(db);
      } catch {
        /* the fetch the event provokes builds it instead, and reports the error if it still fails */
      }
      emit(cursor);
    }
    return cursor;
  };
  /** A check from a timer, a file event or a write: nothing waits on it, so a failure (a busy or closed database) is only the next check's to retry. */
  const run = (): void => {
    try {
      check();
    } catch {
      /* the next check asks again */
    }
  };

  /** A file event: check once `debounceMs` after the last of a burst. */
  const early = (): void => {
    clearTimeout(debounce);
    debounce = setTimeout(run, debounceMs).unref();
  };

  const targets = (): WatchTarget[] => {
    const out: WatchTarget[] = [];
    if (!db.memory) {
      const file = path.resolve(db.name);
      out.push({ dir: path.dirname(file), match: (name) => name === `${path.basename(file)}-wal` });
    }
    const config = globalConfigPath();
    out.push({ dir: path.dirname(config), match: (name) => name === path.basename(config) });
    return out;
  };
  const trees = (): WatchTree[] => [
    { root: projectsDir(), match: (file) => file === 'config.json' },
    { root: artifactsDir(), match: () => true },
  ];

  /** One watch on one directory, not its subdirectories, or null when it cannot be made: optional, and the floor covers it. */
  const watchDir = (dir: string, onName: (name: string | null) => void): fs.FSWatcher | null => {
    try {
      const watcher = fs.watch(dir, { persistent: false, recursive: false }, (_event, name) => onName(name));
      // A watch that fails is closed and forgotten, once; the floor carries on.
      watcher.on('error', () => release(watcher));
      watchers.add(watcher);
      return watcher;
    } catch {
      return null;
    }
  };
  const release = (watcher: fs.FSWatcher): void => {
    watchers.delete(watcher);
    watcher.close();
  };

  /**
   * Which folder this is, not only what it is called: the inode and the time it was made. A watch is on a
   * folder, so one removed and made again under the same name (before the area's event is read) is a
   * folder the old watch will never hear from, and the filesystem may hand the new one the old inode: the
   * time it was made is what tells them apart. `-` when it cannot be read.
   */
  const identity = (dir: string): string => {
    try {
      const s = fs.statSync(dir, { bigint: true });
      return `${s.ino}.${s.birthtimeNs}`;
    } catch {
      return '-';
    }
  };

  /**
   * A watch on `root` for its folders, and one on each folder for its files. The
   * root's own events (a folder made, renamed or removed) adopt what is there
   * now: a watch for each new folder, none for one that has gone, a new one for
   * one that was made again. The check they also ask for is what sees a file
   * already written into a folder by the time its watch was made.
   */
  const watchTree = ({ root, match }: WatchTree): void => {
    const folders = new Map<string, { watcher: fs.FSWatcher; id: string }>();
    const adopt = (): void => {
      let present: string[];
      try {
        // The folders the cursor lists: no dot-names, no links (`artifactFiles`).
        present = fs.readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
          .map((entry) => entry.name);
      } catch {
        present = [];
      }
      for (const [name, { watcher, id }] of folders) {
        // Gone, replaced by another folder of the name, or its watch failed (and was closed): forget it, and the
        // loop below makes a new one if the folder is there.
        const open = watchers.has(watcher);
        if (open && present.includes(name) && identity(path.join(root, name)) === id) continue;
        folders.delete(name);
        if (open) release(watcher);
      }
      for (const name of present) {
        if (folders.has(name)) continue;
        const dir = path.join(root, name);
        // Read before the watch is made: a folder replaced in between is seen as changed by the next event.
        const id = identity(dir);
        const watcher = watchDir(dir, (file) => {
          if (file !== null && match(file)) early();
        });
        if (watcher) folders.set(name, { watcher, id });
      }
    };
    const rootWatch = watchDir(root, () => {
      adopt();
      early();
    });
    if (rootWatch) adopt();
  };

  const watchFiles = (): void => {
    for (const { dir, match } of targets()) {
      watchDir(dir, (name) => {
        if (name !== null && match(name)) early();
      });
    }
    for (const tree of trees()) watchTree(tree);
  };

  const start = (): void => {
    floor = setInterval(run, floorMs).unref();
    keepAlive = setInterval(() => {
      for (const res of streams) push(res, ': keep-alive\n\n');
    }, keepAliveMs).unref();
    watchFiles();
  };
  const stop = (): void => {
    clearInterval(floor);
    clearInterval(keepAlive);
    clearTimeout(debounce);
    for (const watcher of watchers) watcher.close();
    watchers.clear();
  };

  return {
    connect(res) {
      // A request already on a connection when `close()` ran (the next one of a
      // pipelined pair, or a keep-alive request that was mid-flight) still reaches
      // the handler: it must not open what `shutdown` just ended. The connection is
      // told to close too, so this refusal is not what `server.close()` waits on.
      if (closed) return send(res, 503, 'text/plain', 'The dashboard is shutting down.\n', { connection: 'close' });
      if (streams.size >= maxStreams) return send(res, 503, 'text/plain', 'Too many open event streams.\n');
      // Before anything is written, so a database that cannot be read is the
      // route's ordinary 500. With streams already open, a change since the last
      // check is sent to them first, so no stream is ever sent the same cursor twice.
      const cursor = check();
      res.writeHead(200, headersFor('text/event-stream; charset=utf-8'));
      push(res, `event: cursor\ndata: ${cursor}\n\n`);
      streams.add(res);
      // A write to a dead socket can surface as an 'error' on the response; a
      // stream that errors is a stream that is gone.
      res.on('error', () => res.destroy());
      res.on('close', () => {
        if (streams.delete(res) && streams.size === 0) stop();
      });
      if (streams.size === 1) start();
    },
    bump() {
      if (streams.size > 0) run();
    },
    shutdown() {
      closed = true;
      const open = [...streams];
      streams.clear();
      stop();
      // A finished response is what lets `server.close` take its connection, kept alive or not: an
      // idle one is closed at once, and without this the stream would hold the close open for ever.
      for (const res of open) res.end();
    },
  };
}

/**
 * `opts.live` overrides the event stream's intervals and cap (`LIVE_DEFAULTS`);
 * only tests have a reason to. `close()` ends the open streams and resolves
 * once the server has closed.
 */
export function startDashboard(
  db: DB,
  opts: { port?: number; host?: string; live?: Partial<LiveOptions> } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const host = opts.host ?? '127.0.0.1';
  const wanted = opts.port ?? dashboardPort();
  const assets = path.join(moduleDir, 'assets');
  const live = createLive(db, opts.live ?? {});

  // Per server start. Every write must carry it (see `acceptWrite`).
  const token = randomBytes(24).toString('hex');
  const json = (res: http.ServerResponse, status: number, body: Record<string, unknown>) =>
    send(res, status, 'application/json', JSON.stringify(body));

  /**
   * The guard every write goes through, and why the loopback check alone is
   * not enough for one: a sandboxed frame on any page sends `Origin: null`,
   * which the read routes accept. So a write also needs a real loopback
   * `Origin`, a JSON content type (which a cross-origin form cannot send
   * without a preflight this server never grants), and the token only this
   * page was served. Only then is the body read, capped, parsed and handed to
   * the route's handler.
   */
  const acceptWrite = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: (typeof WRITES)[string],
  ): void => {
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return json(res, 403, { error: 'A write needs a loopback Origin.' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return json(res, 415, { error: 'Send application/json.' });
    }
    const sent = Buffer.from(String(req.headers['x-eklavya-token'] ?? ''));
    const want = Buffer.from(token);
    if (sent.length !== want.length || !timingSafeEqual(sent, want)) {
      return json(res, 403, { error: 'Stale or missing dashboard token. Reload the page.' });
    }
    if (Number(req.headers['content-length'] ?? 0) > route.maxBytes) {
      return json(res, 413, { error: 'Request too large.' });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > route.maxBytes) {
        // Answer first and drop the connection only once the answer is out,
        // so the browser reads the 413 instead of a reset.
        res.on('finish', () => req.destroy());
        json(res, 413, { error: 'Request too large.' });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      // The 413 above destroys the request once it is sent, so this end only
      // arrives first when the socket is backed up.
      /* c8 ignore next -- needs socket backpressure to order 'end' before 'finish' */
      if (res.headersSent) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(res, 400, { error: 'Not valid JSON.' });
      }
      const out = route.handler(db, body);
      json(res, out.status, out.body);
      // Whatever the handler changed is told to the open streams now, not at the
      // next check; the answer above is already on its way, so the writer does not wait for it.
      live.bump();
    });
  };

  const server = http.createServer((req, res) => {
    // Loopback is not an authorisation boundary for a browser (PRD DASH-03).
    // A page the developer happens to have open can point a hostname it
    // controls at 127.0.0.1 and fetch from here -- DNS rebinding -- and the
    // same-origin policy does not help, because the page's origin *is* that
    // hostname. The risk is a write (`acceptWrite` adds a token for those) and that this payload contains the developer's prompts, code and project
    // history, and a hostile page would be reading all of it.
    //
    // The check is the standard one: the request has to have been addressed to
    // loopback by name, which a rebound hostname never is.
    if (!fromLoopback(req.headers.host, req.headers.origin)) {
      return send(res, 403, 'text/plain', 'Eklavya serves loopback only.\n');
    }
    // An absolute-form target such as `http://[` is not a URL, and a throw from
    // this callback would take the whole server down with it.
    let url: URL;
    try {
      /* c8 ignore next -- a server-side request always carries its url; the fallback is for the type */
      url = new URL(req.url ?? '/', `http://${host}`);
    } catch {
      return send(res, 400, 'text/plain', 'Bad request target.\n');
    }
    // The routes in `WRITES` take a POST, through `acceptWrite`. Everything
    // else reads, and any other method is refused rather than answered as a GET.
    const write = WRITES[url.pathname];
    if (write && req.method === 'POST') return acceptWrite(req, res, write);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'text/plain', `This route is read-only. Writes: ${Object.keys(WRITES).join(', ')}.\n`, {
        // A stream has no HEAD: there is nothing to answer without opening one.
        allow: write ? 'GET, HEAD, POST' : url.pathname === EVENTS_PATH ? 'GET' : 'GET, HEAD',
      });
    }
    try {
      // Who is serving: what SessionStart reads to decide whether to leave this
      // process alone, replace it, or stop it (`dashboard-daemon.ts`).
      if (url.pathname === '/api/health') {
        return send(res, 200, 'application/json', JSON.stringify({ app: 'eklavya', version: ownVersion(), pid: process.pid, db: dbPath() }));
      }
      // The cursor as a stream (`createLive`). A GET only: a HEAD has no stream to
      // open and falls through to the 404 it always had.
      if (url.pathname === EVENTS_PATH && req.method === 'GET') return live.connect(res);
      // The reads below are served from the per-cursor memo (`memoFor`): the cursor
      // is asked for first, and a build runs only when it moved or a minute passed.
      // Not memoized, on purpose: `/api/cursor`, which must always say what the
      // database says now; `/api/health`, which names the process; one feedback
      // item, which a POST acknowledges; and a correction, which is graded live.
      const pageKey = url.pathname + url.search;
      const reply = (body: Buffer | null) =>
        body === null ? send(res, 404, 'application/json', '{"error":"no such entry"}') : send(res, 200, 'application/json', body);
      if (url.pathname === SETTINGS_PATH) {
        const memo = memoFor(db);
        const project = url.searchParams.get('project');
        return reply(pageBody(memo, pageKey, () => JSON.stringify(settingsState(db, project)), {
          expires: true,
          stamp: () => settingsStamp(memo, db, project),
        }));
      }
      if (url.pathname === '/api/cursor') {
        return send(res, 200, 'application/json', JSON.stringify({ cursor: changeCursor(db) }));
      }
      if (url.pathname === '/api/state') {
        return reply(stateBody(memoFor(db), db));
      }
      // The memory timeline is a paged resource rather than part of the state
      // payload: the corpus is the one thing here that grows without bound.
      if (url.pathname === '/api/memory') {
        const g = (k: string) => url.searchParams.get(k);
        return reply(pageBody(memoFor(db), pageKey, () => JSON.stringify(
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
        )));
      }
      if (url.pathname === '/api/projects') {
        return reply(Buffer.from(JSON.stringify(inventoryOf(memoFor(db), db).value)));
      }
      if (url.pathname === '/api/memory/sessions') {
        const g = (k: string) => url.searchParams.get(k);
        return reply(pageBody(memoFor(db), pageKey, () => JSON.stringify(
          memorySessionPage(db, {
            project: g('project'),
            session: g('session'),
            page: Number(g('page')) || 1,
            per: Number(g('per')) || MEMORY_PER,
          }),
        )));
      }
      if (url.pathname === '/api/feedback') {
        const out = feedbackItem(db, url.searchParams.get('id'));
        return send(res, out.status, 'application/json', JSON.stringify(out.body));
      }
      if (url.pathname === '/api/feedback/list') {
        const g = (k: string) => url.searchParams.get(k);
        return reply(pageBody(memoFor(db), pageKey, () => JSON.stringify(
          listAcknowledged(db, { project: g('project'), page: Number(g('page')) || 1, per: Number(g('per')) || 20 }),
        )));
      }
      if (url.pathname === '/api/attempts/correction') {
        const out = correctionState(db, Number(url.searchParams.get('id')));
        return send(res, out.status, 'application/json', JSON.stringify(out.body));
      }
      if (url.pathname === '/api/memory/entry') {
        return reply(pageBody(memoFor(db), pageKey, () => {
          const entry = memoryEntry(db, Number(url.searchParams.get('id')));
          return entry ? JSON.stringify(entry) : null;
        }));
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
        // `?thumb=ink|paper`: the page's first diagram (or a cover), for the gallery. The
        // gallery's URL carries the file size, so a rewritten page is refetched.
        const thumb = url.searchParams.get('thumb');
        if (thumb !== null) {
          if (thumb !== 'ink' && thumb !== 'paper') return send(res, 400, 'text/plain', 'thumb is ink or paper');
          return send(res, 200, 'image/svg+xml; charset=utf-8', artifactThumb(file, thumb), {
            'content-security-policy': ARTIFACT_CSP,
            'cache-control': CACHE_HOUR,
          });
        }
        const embed = url.searchParams.has('embed');
        return send(res, 200, 'text/html; charset=utf-8', embed ? embedHtml(fs.readFileSync(file, 'utf8')) : fs.readFileSync(file), {
          'content-security-policy': embed ? ARTIFACT_EMBED_CSP : ARTIFACT_CSP,
          'x-frame-options': 'SAMEORIGIN',
        });
      }
      if (url.pathname === '/manifest.webmanifest') {
        return send(res, 200, 'application/manifest+json', MANIFEST);
      }
      if (APP_ICONS.has(url.pathname)) {
        return send(res, 200, 'image/png', fs.readFileSync(path.join(assets, url.pathname.slice(1))));
      }
      const vendor = VENDOR[url.pathname];
      if (vendor) {
        return send(res, 200, vendor, fs.readFileSync(path.join(assets, url.pathname.slice(1))), {
          'cache-control': 'max-age=3600',
        });
      }
      const mascotAsset = MASCOT_ASSETS.get(url.pathname);
      if (mascotAsset) {
        return send(res, 200, mascotAsset[1], fs.readFileSync(path.join(assets, mascotAsset[0])), { 'cache-control': CACHE_HOUR });
      }
      if (url.pathname === '/tokens.css') {
        return send(res, 200, 'text/css', localTokens(fs.readFileSync(path.join(assets, 'tokens.css'), 'utf8')), {
          'cache-control': CACHE_HOUR,
        });
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        // The write token rides in the page itself: a hostile origin cannot read
        // this response, so it cannot learn the token to send back.
        const html = fs.readFileSync(path.join(assets, 'dashboard.html'), 'utf8')
          .replace('<meta name="eklavya-token" content="">', `<meta name="eklavya-token" content="${token}">`);
        // The tag is a hash of what is sent, so a new server start (a new token)
        // changes it, and so does an edit to the file on disk, which the page's
        // own development loop relies on a reload to pick up.
        const etag = `"${createHash('sha256').update(html).digest('hex').slice(0, 32)}"`;
        const headers = { etag, 'cache-control': 'no-cache' };
        if (etagMatches(req.headers['if-none-match'], etag)) return send(res, 304, 'text/html; charset=utf-8', '', headers);
        return send(res, 200, 'text/html; charset=utf-8', html, headers);
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
      /* c8 ignore next -- a TCP listener's address() is always an object; a string is a pipe */
      const port = typeof addr === 'object' && addr ? addr.port : wanted;
      // The daemon starts at SessionStart, long before anyone opens the page, so
      // the first build is made now rather than by the first request. After
      // 'listening' and off the current turn, so neither the bind nor a probe of
      // `/api/health` waits on it; unref'd, so it never holds a process or a test
      // open; cancelled by `close()`; and a failure of any kind (a database that
      // is closed, busy or locked) only means the first request builds it instead.
      const warming = setImmediate(() => {
        try {
          warmMemo(db);
        } catch {
          /* the first request builds it, and reports the error if it still fails */
        }
      });
      warming.unref();
      resolve({
        url: `http://${host}:${port}`,
        // Ends every open stream first: `server.close` waits for every connection,
        // and an event stream never ends by itself. Resolves once the server has
        // closed; calling it again is harmless and resolves too.
        close: () => {
          clearImmediate(warming);
          live.shutdown();
          return new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
    server.listen(wanted, host);
  });
}
