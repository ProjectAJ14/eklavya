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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.js';
import { decayedScore, isDue, isKnown, MS_PER_DAY } from './srs.js';
import { GLOBAL_PROJECT, levelStanding, PASSING_GRADE } from './store.js';
import { loadConfig, DEFAULT_CONFIG, type EklavyaConfig } from './config.js';
import { dbPath } from './paths.js';

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
const DEFAULT_PORT = 41729;
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
    .all() as Record<string, unknown>[];

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

  return {
    generated_at: now.toISOString(),
    db_path: dbPath(),
    timeline_days: TIMELINE_DAYS,
    attempts_shown: attempts.length,
    attempts_total: allTime.answers,
    config: {
      mode: config.mode,
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
  };
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
export function startDashboard(
  db: DB,
  opts: { port?: number; host?: string } = {},
): Promise<{ url: string; close: () => void }> {
  const host = opts.host ?? '127.0.0.1';
  const wanted = opts.port ?? DEFAULT_PORT;
  const assets = path.join(moduleDir, 'assets');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    try {
      if (url.pathname === '/api/state') {
        return send(res, 200, 'application/json', JSON.stringify(dashboardState(db)));
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
