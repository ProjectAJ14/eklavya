/**
 * `eklavya dashboard` — the learning state as a local web page.
 *
 * The terminal report has to fit in twenty lines, so it answers "what now?".
 * This answers "am I getting better?", which needs history, per-project
 * comparison and the full concept list — none of which fit in a paragraph.
 *
 * Deliberately a static page plus one JSON endpoint: no framework, no build
 * step, same rule the landing page follows. It binds to loopback only, which
 * is the whole security model — the data never leaves the machine, and that
 * is a promise the landing page makes on Eklavya's behalf.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.js';
import { decayedScore, isDue, isKnown } from './srs.js';
import { GLOBAL_PROJECT } from './store.js';

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
/** Enough history to see a trend, short enough to stay one screen wide. */
const TIMELINE_DAYS = 30;

interface AttemptRow {
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
  last_active: string;
}

interface ConceptRow {
  slug: string;
  name: string;
  domain: string;
  tier: number;
  score: number | null;
  reps: number | null;
  next_review: string | null;
  attempts: number;
  last_grade: number | null;
  last_context: string | null;
  last_repo: string | null;
  last_seen: string | null;
}

export function dashboardState(db: DB): Record<string, unknown> {
  const now = new Date();

  // One row per calendar day, split three ways. `grade >= 3` is the same pass
  // line the level ladder uses, so the chart and the promotion agree.
  const timeline = db
    .prepare(
      `SELECT date(ts) AS day,
              NULLIF(trim(COALESCE(repo, '')), '') AS repo,
              sum(CASE WHEN grade >= 3 THEN 1 ELSE 0 END) AS passed,
              sum(CASE WHEN grade < 3 AND (outcome IS NULL OR outcome = 'answered') THEN 1 ELSE 0 END) AS missed,
              sum(CASE WHEN outcome IN ('declined','dont_know') THEN 1 ELSE 0 END) AS skipped
       FROM attempts
       WHERE ts >= date('now', ?)
       GROUP BY day, repo
       ORDER BY day`,
    )
    .all(`-${TIMELINE_DAYS} days`) as AttemptRow[];

  // A null repo is the pre-migration-003 bucket. It is kept, not dropped:
  // hiding those rows would silently shrink every total on the page.
  const projects = db
    .prepare(
      `SELECT NULLIF(trim(COALESCE(a.repo, '')), '') AS repo,
              count(*) AS answers,
              sum(CASE WHEN a.grade >= 3 THEN 1 ELSE 0 END) AS passed,
              sum(CASE WHEN a.outcome IN ('declined','dont_know') THEN 1 ELSE 0 END) AS skipped,
              count(DISTINCT a.concept_id) AS concepts,
              max(a.ts) AS last_active
       FROM attempts a
       GROUP BY repo
       ORDER BY last_active DESC`,
    )
    .all() as ProjectRow[];

  const levels = new Map(
    (db.prepare('SELECT repo, level, promoted_at FROM project_levels').all() as {
      repo: string;
      level: string;
      promoted_at: string | null;
    }[]).map((r) => [r.repo, r]),
  );

  const conceptRows = db
    .prepare(
      `SELECT c.slug, c.name, c.domain, c.tier,
              m.score, m.reps, m.next_review, m.last_seen,
              (SELECT count(*) FROM attempts a WHERE a.concept_id = c.id) AS attempts,
              (SELECT a.grade FROM attempts a WHERE a.concept_id = c.id ORDER BY a.id DESC LIMIT 1) AS last_grade,
              (SELECT sc.context FROM session_concepts sc
                WHERE sc.concept_id = c.id AND sc.context IS NOT NULL
                ORDER BY sc.ts DESC LIMIT 1) AS last_context,
              (SELECT a.repo FROM attempts a
                WHERE a.concept_id = c.id AND a.repo IS NOT NULL AND trim(a.repo) <> ''
                ORDER BY a.id DESC LIMIT 1) AS last_repo
       FROM concepts c
       LEFT JOIN mastery m ON m.concept_id = c.id`,
    )
    .all() as ConceptRow[];

  const domains = new Map<string, { domain: string; mastered: number; learning: number; unseen: number }>();
  const concepts: Record<string, unknown>[] = [];

  for (const row of conceptRows) {
    const bucket = domains.get(row.domain) ?? { domain: row.domain, mastered: 0, learning: 0, unseen: 0 };
    domains.set(row.domain, bucket);

    if (row.attempts === 0) {
      bucket.unseen += 1;
      continue;
    }

    // Read-time decay only, exactly as the profile computes it — two surfaces
    // disagreeing about the same score is worse than either being wrong.
    const score = decayedScore(row.score ?? 0, row.next_review, now);
    const mastered = isKnown({ score, reps: row.reps ?? 0 });
    if (mastered) bucket.mastered += 1;
    else bucket.learning += 1;

    concepts.push({
      slug: row.slug,
      name: row.name,
      domain: row.domain,
      tier: row.tier,
      score: Number(score.toFixed(2)),
      reps: row.reps ?? 0,
      attempts: row.attempts,
      last_grade: row.last_grade,
      mastered,
      due: isDue(row.next_review, now),
      next_review: row.next_review,
      last_seen: row.last_seen,
      context: row.last_context,
      repo: row.last_repo,
    });
  }

  concepts.sort((a, b) => (a.score as number) - (b.score as number));

  const skipped = db
    .prepare(
      `SELECT c.slug AS slug, c.name AS name, c.domain AS domain,
              a.outcome AS outcome, a.repo AS repo, a.ts AS ts, a.question AS question
       FROM attempts a JOIN concepts c ON c.id = a.concept_id
       WHERE a.outcome IN ('declined','dont_know')
       ORDER BY a.ts DESC`,
    )
    .all();

  const recent = db
    .prepare(
      `SELECT c.slug AS slug, c.domain AS domain, sc.context AS context, sc.ts AS ts, g.repo AS repo
       FROM session_concepts sc
       JOIN concepts c ON c.id = sc.concept_id
       LEFT JOIN gates g ON g.session_id = sc.session_id
       WHERE sc.context IS NOT NULL AND trim(sc.context) <> ''
       ORDER BY sc.ts DESC
       LIMIT 40`,
    )
    .all();

  const totals = timeline.reduce(
    (acc, d) => ({
      passed: acc.passed + d.passed,
      missed: acc.missed + d.missed,
      skipped: acc.skipped + d.skipped,
    }),
    { passed: 0, missed: 0, skipped: 0 },
  );

  const allTime = db
    .prepare(
      `SELECT count(*) AS answers,
              sum(CASE WHEN grade >= 3 THEN 1 ELSE 0 END) AS passed,
              sum(CASE WHEN outcome IN ('declined','dont_know') THEN 1 ELSE 0 END) AS skipped
       FROM attempts`,
    )
    .get() as { answers: number; passed: number | null; skipped: number | null };

  return {
    generated_at: now.toISOString(),
    timeline_days: TIMELINE_DAYS,
    totals: {
      answers: allTime.answers,
      passed: allTime.passed ?? 0,
      skipped: allTime.skipped ?? 0,
      mastered: concepts.filter((c) => c.mastered).length,
      due: concepts.filter((c) => c.due).length,
      touched: concepts.length,
      catalogue: conceptRows.length,
      window: totals,
    },
    timeline,
    projects: projects.map((p) => ({
      ...p,
      level: levels.get(p.repo ?? GLOBAL_PROJECT)?.level ?? 'easy',
      promoted_at: levels.get(p.repo ?? GLOBAL_PROJECT)?.promoted_at ?? null,
    })),
    domains: [...domains.values()].sort((a, b) => b.mastered + b.learning - (a.mastered + a.learning)),
    concepts,
    skipped,
    recent,
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
