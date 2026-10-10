#!/usr/bin/env node
// Dashboard performance harness (issue #171, Phase 0).
//
// Seeds a throwaway learner database at one of three sizes, then measures what
// opening the dashboard costs on the server: the builders it calls in-process,
// the size of the /api/state payload by key, and the real HTTP round trips
// against a server this script starts on a free loopback port.
//
//   node mcp/scripts/dashboard-perf.mjs [dist] [small|medium|large|all] [--json]
//
// Everything runs against a temporary EKLAVYA_HOME and EKLAVYA_DB that are
// removed afterwards, also on failure; the real ~/.eklavya is never opened.
// Plain Node ESM with no dependencies beyond the built mcp/dist.
//
// Comparing commits: the data is seeded from a fixed PRNG, so two runs produce
// the same rows, payload sizes within a fraction of a percent (decayed scores
// read the clock) and, on a quiet machine, timings within noise. Every row names its
// repository by path, so payload sizes also move with the length of the
// temporary directory (TMPDIR): compare runs that share it. Build each commit
// into its own dist directory and diff the --json output:
//
//   node mcp/scripts/dashboard-perf.mjs /path/to/dist-before all --json > before.json
//   node mcp/scripts/dashboard-perf.mjs /path/to/dist-after  all --json > after.json
//
// Adding a measurement: write one function that returns its result, call it
// from `runScale`, and print it in `formatText`. A builder that a dist does not
// export yet (a later phase adds some) is reported as n/a, not as a crash.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const DEFAULT_DIST = path.resolve(path.dirname(SCRIPT), '..', 'dist');

/** Every timing is the median of this many runs, with the fastest and slowest beside it. */
const RUNS = 5;
/** Fixed so two runs seed the same rows. */
const SEED = 171;
const PROJECTS = 6;

/** The sizes in issue #171's table: attempts, logged rows, evidence events, memory entries, sessions. */
const SCALES = {
  small: { attempts: 200, logged: 400, evidence: 1000, entries: 200, sessions: 40 },
  medium: { attempts: 2000, logged: 5000, evidence: 20000, entries: 3000, sessions: 400 },
  large: { attempts: 10000, logged: 20000, evidence: 100000, entries: 10000, sessions: 1500 },
};
const SCALE_NAMES = Object.keys(SCALES);

/** What the page asks for, in the order the HTTP section times them. */
const ROUTES = ['/api/state', '/api/projects', '/api/settings', '/api/memory/sessions', '/api/cursor'];
/** The two requests the page issues together at boot. */
const BOOT_ROUTES = ['/api/state', '/api/projects'];

const USAGE = `Usage: node mcp/scripts/dashboard-perf.mjs [dist] [small|medium|large|all] [--json]

  dist     the built runtime to measure (default: the mcp/dist next to this script)
  scale    small, medium (default), large, or all three, each in its own
           temporary home and process
  --json   print machine-readable results instead of text: one object for a
           single scale, an array of three objects for "all"
  --help   print this

Seeds a temporary EKLAVYA_HOME (removed afterwards; ~/.eklavya is never read),
then prints, for the scale:
  - in-process timings, median of ${RUNS} with min and max: dashboardState,
    JSON.stringify of it, projectInventory, settingsState, memorySessionPage
    and changeCursor (n/a for an export the dist does not have yet)
  - the /api/state payload in bytes, total and per top-level key, largest first,
    with attempts_shown / attempts_total (and logged_shown / logged_total when
    the state carries them)
  - HTTP round trips to a server started on a free port, each route requested
    twice in a row (first, second), and the page's two boot requests together
Build first: cd mcp && npm run build
`;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { dist: DEFAULT_DIST, scale: 'medium', json: false, help: false };
  const positional = [];
  for (const arg of argv) {
    if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  const isScale = (s) => s === 'all' || SCALE_NAMES.includes(s);
  // `dashboard-perf.mjs large` is read as a scale, not as a directory named large.
  if (positional.length === 1 && isScale(positional[0])) positional.unshift(DEFAULT_DIST);
  if (positional.length > 2) throw new Error('Too many arguments');
  if (positional[0]) out.dist = path.resolve(positional[0]);
  if (positional[1]) {
    if (!isScale(positional[1])) throw new Error(`Unknown scale "${positional[1]}" (small, medium, large or all)`);
    out.scale = positional[1];
  }
  return out;
}

// ------------------------------------------------------------------- helpers

/** A small seeded PRNG (mulberry32): the same seed always gives the same sequence. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (n) => Math.round(n * 100) / 100;
const bytesOf = (text) => Buffer.byteLength(text ?? '');

/** { median, min, max } in milliseconds of a list of samples. */
function summarize(samples) {
  const s = [...samples].sort((x, y) => x - y);
  return { median: round(s[Math.floor(s.length / 2)]), min: round(s[0]), max: round(s[s.length - 1]) };
}

/** Runs `fn` RUNS times; returns its timing summary and the last value it returned. */
function sample(fn) {
  const ms = [];
  let value;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    value = fn();
    ms.push(performance.now() - t0);
  }
  return { stats: summarize(ms), value };
}

const log = (message) => process.stderr.write(`dashboard-perf: ${message}\n`);

function removeHome(home) {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    // A leftover temp directory must not hide the result.
  }
}

// -------------------------------------------------------------------- seeding

/**
 * Fills the migrated schema with one synthetic learner, the way the issue's
 * reproduction does: attempts, mastery, logged concepts, evidence, memory
 * entries with a tag, and one gate per session. Dates run back 365 days from
 * `now`, so the heatmap, the daily rows and the decayed scores have a year in them.
 */
function seed(db, repos, n, rand) {
  const now = Date.now();
  const ids = db.prepare('SELECT id FROM concepts').all().map((r) => r.id);
  const rnd = (k) => Math.floor(rand() * k);
  const sess = (i) => 'sess-' + (i % n.sessions);
  const repo = (i) => repos[i % PROJECTS];
  const sql = (d, h = 0) => new Date(now - d * 864e5 - h * 36e5).toISOString().slice(0, 19).replace('T', ' ');
  const iso = (d, h = 0) => new Date(now - d * 864e5 - h * 36e5).toISOString();
  db.transaction(() => {
    const g = db.prepare(
      `INSERT OR IGNORE INTO gates (session_id, mode, required, answered, passed, repo) VALUES (?, 'ambient', 1, 1, 1, ?)`,
    );
    for (let i = 0; i < n.sessions; i++) g.run(sess(i), repo(i));

    const a = db.prepare(
      `INSERT INTO attempts (concept_id, session_id, question, answer, grade, difficulty, feedback, ts, repo, level, outcome, format, options)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'medium', 'answered', 'mcq', ?)`,
    );
    const options = JSON.stringify(['option one', 'option two', 'option three', 'option four']);
    for (let i = 0; i < n.attempts; i++) {
      a.run(
        ids[rnd(ids.length)], sess(i),
        'Why does a refresh token rotate on every use? '.repeat(4),
        'Because a stolen token is then single-use.',
        rnd(6), 1 + rnd(3),
        'A rotated token is invalidated when used. '.repeat(5),
        sql(rnd(365), rnd(24)), repo(i), options,
      );
    }

    const m = db.prepare(
      `INSERT OR IGNORE INTO mastery (concept_id, score, ease, interval_d, reps, next_review, last_seen) VALUES (?, ?, 2.5, ?, ?, ?, ?)`,
    );
    for (const id of ids) if (rand() < 0.6) m.run(id, rand(), 1 + rnd(30), rnd(6), iso(-rnd(30)), iso(rnd(60)));

    const s = db.prepare(
      `INSERT OR IGNORE INTO session_concepts (session_id, concept_id, context, ts, origin) VALUES (?, ?, ?, ?, 'work')`,
    );
    for (let i = 0; i < n.logged; i++) {
      s.run(sess(i), ids[rnd(ids.length)], 'set httpOnly on the refresh cookie in src/auth/cookie.ts', sql(rnd(365)));
    }

    const e = db.prepare(
      `INSERT INTO evidence_events (event_uid, project, checkout, session_id, kind, tool, title, body, occurred_at, status)
       VALUES (?, ?, ?, ?, 'tool_use', 'Edit', 'edit', ?, ?, ?)`,
    );
    const body = 'tool output '.repeat(50);
    for (let i = 0; i < n.evidence; i++) {
      e.run('ev-' + i, repo(i), repo(i), sess(i), body, iso(rnd(365), rnd(24)), i % 3 ? 'summarized' : 'accepted');
    }

    const en = db.prepare(
      `INSERT INTO memory_entries (entry_uid, project, session_id, kind, type, title, narrative, facts, files, occurred_at)
       VALUES (?, ?, ?, 'observation', ?, ?, ?, '["fact"]', '["src/a.ts"]', ?)`,
    );
    const tg = db.prepare(`INSERT OR IGNORE INTO memory_entry_tags (entry_id, tag) VALUES (?, ?)`);
    const narrative = 'narrative '.repeat(120);
    for (let i = 0; i < n.entries; i++) {
      const r = en.run('en-' + i, repo(i), sess(i), ['bugfix', 'feature', 'decision'][i % 3], 'Observation ' + i, narrative, iso(rnd(365)));
      tg.run(r.lastInsertRowid, 'auth');
    }
  })();
}

/** What is actually in the database, since an INSERT OR IGNORE can drop duplicates. */
function countRows(db) {
  const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  return {
    concepts: count('concepts'),
    attempts: count('attempts'),
    logged: count('session_concepts'),
    evidence: count('evidence_events'),
    entries: count('memory_entries'),
    sessions: count('gates'),
    projects: PROJECTS,
  };
}

// ----------------------------------------------------- in-process measurements
// One function per measurement. Each returns { stats, value }: `stats` is the
// { median, min, max } summary in milliseconds, null when the dist has no such
// export yet, or { error } when it threw; `value` is the last result.

function timeExport(dash, name, args) {
  if (typeof dash[name] !== 'function') return { stats: null, value: undefined };
  try {
    return sample(() => dash[name](...args));
  } catch (err) {
    return { stats: { error: err instanceof Error ? err.message : String(err) }, value: undefined };
  }
}

const timeDashboardState = (dash, db) => timeExport(dash, 'dashboardState', [db]);
const timeProjectInventory = (dash, db) => timeExport(dash, 'projectInventory', [db]);
const timeSettingsState = (dash, db) => timeExport(dash, 'settingsState', [db, null]);
const timeMemorySessionPage = (dash, db) => timeExport(dash, 'memorySessionPage', [db, {}]);
const timeChangeCursor = (dash, db) => timeExport(dash, 'changeCursor', [db]);

/** The serialization half of serving /api/state. */
function timeStateStringify(state) {
  if (state === undefined) return null;
  return sample(() => JSON.stringify(state)).stats;
}

/** The payload in bytes: the whole, then every top-level key, largest first. */
function measurePayload(state) {
  if (state === undefined) return null;
  const keys = Object.entries(state)
    .map(([key, value]) => [key, bytesOf(JSON.stringify(value))])
    .sort((x, y) => y[1] - x[1]);
  const out = {
    bytes: bytesOf(JSON.stringify(state)),
    keys: Object.fromEntries(keys),
    // The caps, so a truncated history cannot pass for a complete one.
    attempts_shown: state.attempts_shown ?? null,
    attempts_total: state.attempts_total ?? null,
    logged_rows: Array.isArray(state.logged) ? state.logged.length : null,
  };
  // `attempts` discloses its cap as shown/total; a capped `logged` would do the same. Print the pair when present.
  if ('logged_shown' in state) out.logged_shown = state.logged_shown;
  if ('logged_total' in state) out.logged_total = state.logged_total;
  return out;
}

// ----------------------------------------------------------- HTTP measurements

/** One GET: wall time to the last byte, the body's size and the status. */
function get(agent, base, route) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.get(base + route, { agent, timeout: 120000 }, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => (bytes += chunk.length));
      res.on('end', () => resolve({ ms: round(performance.now() - t0), bytes, status: res.statusCode }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`${route} timed out`)));
    req.on('error', reject);
  });
}

/**
 * Each route twice in a row. The first request pays for whatever the server
 * builds; a later memo shows up as a faster second.
 */
async function measureRoundTrips(agent, base) {
  const out = {};
  for (const route of ROUTES) {
    const first = await get(agent, base, route);
    const second = await get(agent, base, route);
    out[route] = { first, second };
  }
  return out;
}

/**
 * The page's boot: /api/state and /api/projects requested together
 * (Promise.all in dashboard.html), the wall time until both are in. The server
 * is single-threaded and its database access synchronous, so the two builds run
 * one after the other and the pair costs about the sum of the two. Median of
 * RUNS pairs, taken after the routes above, so a memo is warm: a reload. The
 * client shares this process's event loop with the server, so only the pair's
 * wall time means anything here, not which of the two answers lands first.
 */
async function measureBoot(agent, base) {
  const wall = [];
  const bytes = {};
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const results = await Promise.all(BOOT_ROUTES.map((route) => get(agent, base, route)));
    wall.push(performance.now() - t0);
    results.forEach((r, k) => (bytes[BOOT_ROUTES[k]] = r.bytes));
  }
  return { wall: summarize(wall), bytes };
}

/** Starts the real server on port 0 and times the round trips; null if the dist cannot serve. */
async function measureHttp(dash, db) {
  if (typeof dash.startDashboard !== 'function') return null;
  const server = await dash.startDashboard(db, { port: 0 });
  const agent = new http.Agent({ keepAlive: true });
  try {
    const routes = await measureRoundTrips(agent, server.url);
    const boot = await measureBoot(agent, server.url);
    return { routes, boot };
  } finally {
    agent.destroy();
    server.close();
  }
}

// Phase 4 adds the live-update measurement here: write a row from this process
// (the way a hook would), open an EventSource on /api/events, and time the gap
// from the write to the cursor event and to the page's redraw. Target: under
// 2 s on the one-second floor, under 500 ms when fs.watch fires. Not built yet.

// -------------------------------------------------------------------- one scale

async function runScale(dist, scale) {
  const sizes = SCALES[scale];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ek-perf-'));
  const onSignal = (signal) => () => {
    removeHome(home);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const handlers = ['SIGINT', 'SIGTERM'].map((signal) => [signal, onSignal(signal)]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  let db;
  try {
    // Before the first import: the runtime reads both when it opens its files.
    process.env.EKLAVYA_HOME = home;
    process.env.EKLAVYA_DB = path.join(home, 'eklavya.db');
    const repos = Array.from({ length: PROJECTS }, (_, i) => {
      const dir = path.join(home, 'repo' + i);
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      return dir;
    });
    const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
    const { openDb } = await load('db.js');
    const dash = await load('dashboard.js');

    log(`seeding ${scale} into ${home}`);
    db = openDb();
    const t0 = performance.now();
    seed(db, repos, sizes, mulberry32(SEED));
    const seedMs = round(performance.now() - t0);
    const rows = countRows(db);

    log(`measuring ${scale}`);
    const state = timeDashboardState(dash, db);
    const inventory = timeProjectInventory(dash, db);
    const settings = timeSettingsState(dash, db);
    const sessions = timeMemorySessionPage(dash, db);
    const cursor = timeChangeCursor(dash, db);
    return {
      scale,
      dist,
      node: process.version,
      // The repo path rides in every attempt, logged, daily and session row, so
      // payload sizes move with the length of the temporary directory.
      seed: { prng: 'mulberry32', value: SEED, ms: seedMs, requested: sizes, rows, repo_path_chars: repos[0].length },
      in_process_ms: {
        dashboardState: state.stats,
        stateStringify: timeStateStringify(state.value),
        projectInventory: inventory.stats,
        settingsState: settings.stats,
        memorySessionPage: sessions.stats,
        changeCursor: cursor.stats,
      },
      payload: measurePayload(state.value),
      http: await measureHttp(dash, db),
    };
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    try {
      db?.close();
    } catch {
      // Already closed or never opened.
    }
    removeHome(home);
  }
}

/** Runs one scale in a fresh process: its own module state, its own home, no warm memo carried over. */
function runScaleInChild(dist, scale) {
  const run = spawnSync(process.execPath, [SCRIPT, dist, scale, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  let result;
  try {
    result = JSON.parse(run.stdout);
  } catch {
    throw new Error(`the ${scale} run failed (exit ${run.status ?? run.signal}); see the messages above`);
  }
  return { result, status: run.status ?? 1 };
}

// ---------------------------------------------------------------------- output

const pad = (value, width) => String(value).padStart(width);
const ms = (n) => (n === undefined || n === null ? 'n/a' : n.toFixed(1));
const num = (n) => (n === undefined || n === null ? 'n/a' : n.toLocaleString('en-US'));
const human = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);

/** "124.0 ms  (min 118.2, max 131.0)", n/a, or the error the call threw. */
function statsText(stats) {
  if (stats === null || stats === undefined) return pad('n/a', 9);
  if (stats.error !== undefined) return `error: ${stats.error}`;
  return `${pad(ms(stats.median), 9)} ms  (min ${ms(stats.min)}, max ${ms(stats.max)})`;
}

function formatText(r) {
  const out = [];
  const { rows, requested } = r.seed;
  out.push(`dashboard-perf  ${r.scale}  (node ${r.node}, ${r.dist})`);
  out.push(
    `seeded in ${ms(r.seed.ms)} ms, prng ${r.seed.prng}(${r.seed.value}): ` +
      `attempts ${num(rows.attempts)}, logged ${num(rows.logged)} (of ${num(requested.logged)} inserted), ` +
      `evidence ${num(rows.evidence)}, memory entries ${num(rows.entries)}, ` +
      `sessions ${num(rows.sessions)}, projects ${rows.projects}, concepts ${num(rows.concepts)}; ` +
      `repo paths are ${r.seed.repo_path_chars} chars`,
  );
  out.push('');
  out.push(`In process, median of ${RUNS} (min, max)`);
  const labels = {
    dashboardState: 'dashboardState(db)',
    stateStringify: 'JSON.stringify(state)',
    projectInventory: 'projectInventory(db)',
    settingsState: 'settingsState(db, null)',
    memorySessionPage: 'memorySessionPage(db, {})',
    changeCursor: 'changeCursor(db)',
  };
  for (const [key, label] of Object.entries(labels)) out.push(`  ${label.padEnd(27)}${statsText(r.in_process_ms[key])}`);

  out.push('');
  const p = r.payload;
  if (p === null) {
    out.push('/api/state payload: n/a');
  } else {
    out.push(`/api/state payload: ${num(p.bytes)} bytes (${human(p.bytes)}), by top-level key, largest first`);
    for (const [key, bytes] of Object.entries(p.keys)) {
      out.push(`  ${key.padEnd(18)}${pad(num(bytes), 12)}  ${pad(((bytes / p.bytes) * 100).toFixed(1), 5)}%`);
    }
    out.push(`  attempts_shown / attempts_total  ${num(p.attempts_shown)} / ${num(p.attempts_total)}`);
    out.push(`  logged rows in the payload       ${num(p.logged_rows)}`);
    if (p.logged_shown !== undefined || p.logged_total !== undefined) {
      out.push(`  logged_shown / logged_total      ${num(p.logged_shown)} / ${num(p.logged_total)}`);
    }
  }

  out.push('');
  if (r.http === null) {
    out.push('HTTP round trips: n/a');
  } else {
    out.push('HTTP round trips, ms (a real server on a free loopback port; each route requested twice in a row)');
    out.push(`  ${'route'.padEnd(24)}${pad('first', 9)}${pad('second', 9)}${pad('bytes', 12)}  status`);
    for (const [route, { first, second }] of Object.entries(r.http.routes)) {
      const status = first.status === 200 && second.status === 200 ? '' : `  ${first.status}/${second.status}`;
      out.push(`  ${route.padEnd(24)}${pad(ms(first.ms), 9)}${pad(ms(second.ms), 9)}${pad(num(second.bytes), 12)}${status}`);
    }
    const { boot } = r.http;
    out.push('');
    out.push(`Page boot: ${BOOT_ROUTES.join(' + ')} together, median of ${RUNS} pairs`);
    out.push(`  both answered in  ${statsText(boot.wall)}`);
  }
  return out.join('\n');
}

/** Whether a builder threw or a route answered something other than 200: a number or n/a is not a failure. */
const hasError = (r) =>
  Object.values(r.in_process_ms).some((s) => s && s.error !== undefined) ||
  Object.values(r.http?.routes ?? {}).some(({ first, second }) => first.status !== 200 || second.status !== 200);

// ------------------------------------------------------------------------ main

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  for (const file of ['db.js', 'dashboard.js']) {
    if (!fs.existsSync(path.join(opts.dist, file))) {
      process.stderr.write(`${path.join(opts.dist, file)} not found. Build first: cd mcp && npm run build\n`);
      return 2;
    }
  }

  const scales = opts.scale === 'all' ? SCALE_NAMES : [opts.scale];
  const results = [];
  let status = 0;
  try {
    for (const scale of scales) {
      let result;
      if (opts.scale === 'all') {
        const child = runScaleInChild(opts.dist, scale);
        result = child.result;
        status = Math.max(status, child.status);
      } else {
        result = await runScale(opts.dist, scale);
        if (hasError(result)) status = 1;
      }
      results.push(result);
      if (!opts.json) process.stdout.write(`${formatText(result)}\n${scales.length > 1 ? '\n' : ''}`);
    }
  } catch (err) {
    process.stderr.write(`dashboard-perf: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(opts.scale === 'all' ? results : results[0], null, 2)}\n`);
  }
  return status;
}

process.exitCode = await main();
