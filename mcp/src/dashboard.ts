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
import { dbPath } from './paths.js';
import { receiptTotals } from './memory/store.js';
import { ESTIMATOR, savingsFrom, savingsLine } from './memory/tokens.js';
import { queueDepth } from './memory/worker.js';
import { droppedCount } from './memory/spool.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/**
 * High, unassigned, and deliberately boring to collide with.
 *
 * The low 5000s are where every dev server lands — Vite alone walks 5173, 5174,
 * 5175 upward as it finds ports taken — so a default down there is a default
 * you have to override. This sits above the registered services in /etc/services
 * and below the 49152+ ephemeral range the OS hands out for outbound sockets,
 * so neither end can claim it first. (1729 is the Hardy–Ramanujan number, which
 * is as good a reason as any to remember it.)
 */
export const DEFAULT_PORT = 41729;
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
       FROM context_receipts GROUP BY delivery`,
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
       FROM context_receipts r ORDER BY r.id DESC LIMIT ?`,
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
      pruned_at: one<{ value: string } | undefined>(db, "SELECT value FROM meta WHERE key = 'memory_pruned_at'")?.value ?? null,
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
    where.push('(e.title LIKE ? OR e.narrative LIKE ? OR e.facts LIKE ? OR e.files LIKE ?)');
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

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    'content-type': type,
    // A dashboard read from a stale cache is a dashboard that lies about
    // progress made ten seconds ago, which is the one thing it is for.
    'cache-control': 'no-store',
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
      if (url.pathname === '/api/memory/entry') {
        const entry = memoryEntry(db, Number(url.searchParams.get('id')));
        if (!entry) return send(res, 404, 'application/json', '{"error":"no such entry"}');
        return send(res, 200, 'application/json', JSON.stringify(entry));
      }
      if (url.pathname === '/tokens.css') {
        return send(res, 200, 'text/css', fs.readFileSync(path.join(assets, 'tokens.css')));
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
