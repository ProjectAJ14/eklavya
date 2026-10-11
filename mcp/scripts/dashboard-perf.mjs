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
// What it measures, and what it does not: the server's side of opening the
// dashboard (the builders, their queries, the payload's size and caps, the
// routes' caching). Without `--live` it never loads dashboard.html or starts a
// browser, so a change that touches only the page leaves every number it prints
// unchanged; the page's own render times come from the browser (the page-transition
// probe in the browser suite, and the method in issue #171's reproduction section).
//
// With `--live` it does start one: headless Chromium (through playwright-core)
// opens the dashboard on the Review page, a second database connection writes a row
// the way a hook does, and the script times the gap from the write to the moment the
// new row is on screen, split into the server noticing and rebuilding, the page's
// two reads, and its redraw. Without a Chromium it says why and skips that part.
//
// Comparing commits: the data is seeded from a fixed PRNG and every timestamp is
// counted back from midnight UTC at the start of the current day, not from the
// moment the script runs, so two runs on one machine on the same UTC date seed
// byte-identical rows and print the same payload bytes (and, on a quiet machine,
// timings within noise). What still moves the bytes is the environment, never
// the code under test, and only one key moves: `daily`, one row per local day
// and project, so a different time zone (days are the learner's local days)
// changes how many rows there are, and a run on another date is not promised the
// same count. Decayed scores do not move anything: they decay in whole weeks and
// the seeded review dates are never that overdue. Every row also names its
// repository by path, so payload sizes move with the length of the temporary
// directory (TMPDIR). Compare runs from the same day, time zone and TMPDIR
// length. Build each commit into its own dist directory and diff the --json
// output:
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
const DAY_MS = 864e5;

/** The sizes in issue #171's table: attempts, logged rows, evidence events, memory entries, sessions. */
const SCALES = {
  small: { attempts: 200, logged: 400, evidence: 1000, entries: 200, sessions: 40 },
  medium: { attempts: 2000, logged: 5000, evidence: 20000, entries: 3000, sessions: 400 },
  large: { attempts: 10000, logged: 20000, evidence: 100000, entries: 10000, sessions: 1500 },
};
const SCALE_NAMES = Object.keys(SCALES);

/** How many writes `--live` times per variant, unless `--writes=N` says otherwise: the median of these is what it prints. */
const LIVE_WRITES = 5;
/** The issue's targets for a write to reach the screen at the medium scale, in ms. */
const LIVE_TARGET = { 'fs.watch': 500, 'floor only': 2000 };

/** What the page asks for, in the order the HTTP section times them. */
const ROUTES = ['/api/state', '/api/projects', '/api/settings', '/api/memory/sessions', '/api/cursor'];
/** The two requests the page issues together at boot. */
const BOOT_ROUTES = ['/api/state', '/api/projects'];

const USAGE = `Usage: node mcp/scripts/dashboard-perf.mjs [dist] [small|medium|large|all] [--json] [--live [--writes=N]]

  dist     the built runtime to measure (default: the mcp/dist next to this script)
  scale    small, medium (default), large, or all three, each in its own
           temporary home and process
  --json   print machine-readable results instead of text: one object for a
           single scale, an array of three objects for "all"
  --live   also time a live update in headless Chromium: the median of ${LIVE_WRITES} writes
           (--writes=N for another count), from a write through a second database
           connection to the new row on screen, with the early trigger (fs.watch) and
           on the one-second floor alone. The browser is EKLAVYA_TEST_BROWSER, else
           Playwright's own install; with neither it says so and skips
  --help   print this

Seeds a temporary EKLAVYA_HOME (removed afterwards; ~/.eklavya is never read),
then prints, for the scale:
  - in-process timings, median of ${RUNS} with min and max: dashboardState,
    JSON.stringify of it, projectInventory, settingsState, memorySessionPage
    and changeCursor (n/a for an export the dist does not have yet)
  - the /api/state payload in bytes, total and per top-level key, largest first,
    with attempts_shown / attempts_total (and logged_shown / logged_total when
    the state carries them); KB and MB are decimal (1,000 and 1,000,000 bytes)
  - HTTP round trips to a server started on a free port, each route requested
    twice in a row (first, second), and the page's two boot requests together
Build first: cd mcp && npm run build
`;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { dist: DEFAULT_DIST, scale: 'medium', json: false, help: false, live: false, writes: LIVE_WRITES };
  const positional = [];
  // What is wrong with the line is said only when the help was not asked for: it is never an error about the rest of the line.
  const problems = [];
  for (const arg of argv) {
    if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--live') out.live = true;
    else if (arg.startsWith('--writes=')) {
      out.writes = Number(arg.slice('--writes='.length));
      if (!Number.isInteger(out.writes) || out.writes < 1) problems.push(`--writes wants a whole number of at least 1, not "${arg.slice(9)}"`);
    } else if (arg.startsWith('-')) problems.push(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  if (out.help) return out;
  if (problems.length) throw new Error(problems[0]);
  const isScale = (s) => s === 'all' || SCALE_NAMES.includes(s);
  // A lone argument is a scale or a dist directory. `large` is read as the scale, not as a directory
  // named large; a word that is neither a scale nor a place on disk ("larg", "Medium") is a mistyped
  // scale, and saying the build is missing would send the contributor to the wrong fix.
  if (positional.length === 1) {
    const [only] = positional;
    if (isScale(only)) positional.unshift(DEFAULT_DIST);
    else if (!/[\\/]/.test(only) && !isDirectory(only)) {
      throw new Error(`Unknown scale "${only}" (small, medium, large or all), and no directory of that name`);
    }
  }
  if (positional.length > 2) throw new Error('Too many arguments');
  if (positional[0]) out.dist = path.resolve(positional[0]);
  if (positional[1]) {
    if (!isScale(positional[1])) throw new Error(`Unknown scale "${positional[1]}" (small, medium, large or all)`);
    out.scale = positional[1];
  }
  return out;
}

// ------------------------------------------------------------------- helpers

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

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
 * The instant every seeded timestamp is counted back from: midnight UTC at the
 * start of the current day. Counting back from the moment the script runs put
 * each row on a different UTC calendar day (and either side of the daily
 * query's `date('now', ...)` cutoff) depending on the hour, so two runs an hour
 * apart gave different `daily` rows and different bytes. From midnight, any two
 * runs on the same UTC date seed the same timestamps. It is never in the future,
 * so nothing is seeded as having happened later than it was run.
 */
function seedAnchor() {
  return Math.floor(Date.now() / DAY_MS) * DAY_MS;
}

/**
 * Fills the migrated schema with one synthetic learner, the way the issue's
 * reproduction does: attempts, mastery, logged concepts, evidence, memory
 * entries with a tag, and one gate per session. Dates run back 365 days from
 * `now` (the anchor above), so the heatmap and the daily rows have a year in them.
 */
function seed(db, repos, n, rand, now) {
  const ids = db.prepare('SELECT id FROM concepts').all().map((r) => r.id);
  const rnd = (k) => Math.floor(rand() * k);
  const sess = (i) => 'sess-' + (i % n.sessions);
  const repo = (i) => repos[i % PROJECTS];
  const sql = (d, h = 0) => new Date(now - d * DAY_MS - h * 36e5).toISOString().slice(0, 19).replace('T', ' ');
  const iso = (d, h = 0) => new Date(now - d * DAY_MS - h * 36e5).toISOString();
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

// ------------------------------------------------------------ live measurement
// `--live`: headless Chromium on the Review page, a second database connection writing a
// row the way a hook does, and the gap from that write to the new row being on screen.
// Two variants, each with its own server and page: the early trigger (fs.watch on the
// database's -wal, debounced 150 ms) and the one-second floor alone (the early trigger
// made to never fire), which is what a filesystem where fs.watch is silent gets.

/** The two ways a write reaches an open page, as `startDashboard`'s `live` options. */
const LIVE_VARIANTS = [
  { name: 'fs.watch', live: {} },
  // A debounce this long never ends: only the floor's check is left to notice a write.
  { name: 'floor only', live: { debounceMs: 2_000_000_000 } },
];

/** Where a Chromium is, or why there is none: EKLAVYA_TEST_BROWSER, then Playwright's own install. */
function findBrowser(chromium) {
  const explicit = process.env.EKLAVYA_TEST_BROWSER;
  if (explicit) return fs.existsSync(explicit) ? { path: explicit } : { why: `EKLAVYA_TEST_BROWSER names ${explicit}, which is not there` };
  try {
    const own = chromium.executablePath();
    if (own && fs.existsSync(own)) return { path: own };
  } catch {
    // Not installed: the next place.
  }
  return { why: 'no Chromium found (set EKLAVYA_TEST_BROWSER, or run: npx playwright-core install chromium)' };
}

/**
 * One row that is new on the Review list: a concept of its own with an answer and a review date a year past, so
 * it is due, is first in the list, and is a name no other row has. Written in one transaction, so one change.
 */
function writeDueConcept(db, n) {
  const slug = `live-probe-${n}`;
  const name = liveName(n);
  db.transaction(() => {
    const id = db.prepare(`INSERT INTO concepts (slug, name, domain, tier, source) VALUES (?, ?, 'perf', 1, 'llm')`).run(slug, name).lastInsertRowid;
    db.prepare(
      `INSERT INTO attempts (concept_id, session_id, question, answer, grade, difficulty, feedback, repo, level, outcome, format)
       VALUES (?, 'sess-0', 'Why does it matter?', 'not sure', 1, 2, 'a note', ?, 'medium', 'answered', 'mcq')`,
    ).run(id, writeRepo);
    // Each a day more overdue than the one before, so the newest is the first row and never falls to a second page.
    db.prepare(
      `INSERT INTO mastery (concept_id, score, ease, interval_d, reps, next_review, last_seen) VALUES (?, 0.3, 2.5, 1, 1, ?, ?)`,
    ).run(id, new Date(Date.now() - (400 + n) * DAY_MS).toISOString(), new Date(Date.now() - (401 + n) * DAY_MS).toISOString());
  })();
  return name;
}

/** The name a probe's concept has on the Review list: padded, so no name is the start of another. */
const liveName = (n) => `Live probe ${String(n).padStart(4, '0')}`;
/** The checkout the probes' answers are attributed to. */
let writeRepo = null;

/** Times `writes` writes against one server: how long each took to be on screen, and in which part. */
async function timeLiveWrites(page, writer, writes, firstN) {
  const out = [];
  for (let i = 0; i < writes; i++) {
    // A stream that has been idle, as one is between a person's writes: nothing from the last one is still in flight.
    await page.waitForTimeout(1500);
    const name = liveName(firstN + i);
    // Watching for the row, and marking where the page was, before the write is made. The page's own clock is wall time
    // on this machine too, so a time in it and one here are on one scale.
    const watched = page.evaluate((label) => new Promise((resolve) => {
      const clock = () => performance.timeOrigin + performance.now();
      const t = { heard: 0, adopt: 0, drawn: 0 };
      const { liveHeard, liveAdopt } = window;
      window.liveHeard = (cursor) => { t.heard ||= clock(); return liveHeard(cursor); };
      window.liveAdopt = (s, inv) => { t.adopt = clock(); const r = liveAdopt(s, inv); t.drawn = clock(); return r; };
      const view = document.getElementById('view');
      const there = () => view.textContent.includes(label);
      const done = () => {
        // On screen: the frame after the one the change was made in.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          Object.assign(window, { liveHeard, liveAdopt });
          resolve({ ...t, painted: clock() });
        }));
      };
      if (there()) return done();
      const mo = new MutationObserver(() => { if (there()) { mo.disconnect(); done(); } });
      mo.observe(view, { childList: true, subtree: true, characterData: true });
    }), name);
    const wrote = writeDueConcept(writer, firstN + i);
    const at = Date.now();
    if (wrote !== name) throw new Error('the row written is not the one watched for');
    let giveUp;
    const t = await Promise.race([
      watched,
      new Promise((_, reject) => { giveUp = setTimeout(() => reject(new Error(`the row "${name}" was not on screen 15 s after it was written`)), 15000); }),
    ]).finally(() => clearTimeout(giveUp));
    out.push({
      total: round(t.painted - at),
      // The server notices (the early trigger or the floor), rebuilds, and the page hears.
      heard: round(t.heard - at),
      // The page reads /api/state and /api/projects, and parses them.
      read: round(t.adopt - t.heard),
      // adoptState, the redraw and the frame it lands in.
      paint: round(t.painted - t.adopt),
      // Of that, the synchronous draw itself.
      draw: round(t.drawn - t.adopt),
    });
  }
  return out;
}

/**
 * The live-update measurement, or why there is none: `{ skipped }`. Never throws for a missing browser; a browser
 * that is there and fails is a failure.
 */
async function measureLive(dash, openDb, db, repo, writes) {
  let playwright;
  try {
    playwright = await import('playwright-core');
  } catch {
    return { skipped: 'playwright-core is not installed (npm ci in mcp/ installs it)' };
  }
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  const found = findBrowser(chromium);
  if (found.why) return { skipped: found.why };
  if (typeof dash.startDashboard !== 'function') return { skipped: 'this dist cannot serve the dashboard' };

  const browser = await chromium.launch({ headless: true, executablePath: found.path });
  // The server reads through `db`; the writes come through this second connection, as they do from a hook.
  const writer = openDb();
  writeRepo = repo;
  const variants = [];
  let next = 1;
  try {
    for (const variant of LIVE_VARIANTS) {
      const server = await dash.startDashboard(db, { port: 0, live: variant.live });
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto(`${server.url}/#/learning/review`);
        await page.waitForFunction(() => document.documentElement.dataset.rendered === location.hash
          && !document.querySelector('.booting, #view .loader'), null, { timeout: 60000 });
        // The stream is open once the page has booted: wait for it, so the first write is not the one that finds it closed.
        await page.waitForFunction(() => LIVE.es?.readyState === 1, null, { timeout: 10000 });
        const runs = await timeLiveWrites(page, writer, writes, next);
        next += writes;
        const stat = (key) => summarize(runs.map((r) => r[key]));
        variants.push({
          name: variant.name,
          runs,
          total: stat('total'), heard: stat('heard'), read: stat('read'), paint: stat('paint'), draw: stat('draw'),
        });
      } finally {
        await context.close();
        await server.close();
      }
    }
  } finally {
    await browser.close();
    writer.close();
  }
  return { browser: found.path, writes, variants };
}

// -------------------------------------------------------------------- one scale

async function runScale(dist, scale, opts = {}) {
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
    const anchor = seedAnchor();
    const t0 = performance.now();
    seed(db, repos, sizes, mulberry32(SEED), anchor);
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
      seed: {
        prng: 'mulberry32', value: SEED, anchor: new Date(anchor).toISOString(), ms: seedMs, requested: sizes, rows,
        repo_path_chars: repos[0].length,
      },
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
      ...(opts.live ? { live: await measureLive(dash, openDb, db, repos[0], opts.writes ?? LIVE_WRITES) } : {}),
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
function runScaleInChild(dist, scale, opts = {}) {
  const flags = opts.live ? ['--live', `--writes=${opts.writes ?? LIVE_WRITES}`] : [];
  const run = spawnSync(process.execPath, [SCRIPT, dist, scale, '--json', ...flags], {
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
// Decimal, the unit the issue's budgets are written in ("under 1.5 MB" is 1,500,000 bytes), with the exact count beside it.
const human = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} KB`);

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
    `seeded in ${ms(r.seed.ms)} ms, prng ${r.seed.prng}(${r.seed.value}), dates counted back from ${r.seed.anchor}: ` +
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
  if (r.live !== undefined) out.push('', ...formatLive(r));
  return out.join('\n');
}

/** The live-update section: a total per variant against the issue's target, and where the time went. */
function formatLive(r) {
  const live = r.live;
  const out = [];
  if (live.skipped !== undefined) {
    out.push(`Live update: skipped, ${live.skipped}`);
    return out;
  }
  out.push(
    `Live update, median of ${live.writes} writes (min, max), in ms: a second database connection writes a due concept; the Review page is open in ` +
      `headless Chromium (${live.browser}); timed from the write to the new row on screen`,
  );
  for (const v of live.variants) {
    const target = LIVE_TARGET[v.name];
    const verdict = r.scale === 'medium' && target !== undefined ? `  target ${target} ms: ${v.total.median < target ? 'met' : 'MISSED'}` : '';
    out.push(`  ${v.name.padEnd(11)}total ${statsText(v.total)}${verdict}`);
    out.push(
      `  ${''.padEnd(11)}the server notices, rebuilds and says so ${ms(v.heard.median)}, the page reads both ${ms(v.read.median)}, ` +
        `it redraws and paints ${ms(v.paint.median)} (the draw itself ${ms(v.draw.median)})`,
    );
  }
  const rebuild = (r.in_process_ms.dashboardState?.median ?? 0) + (r.in_process_ms.projectInventory?.median ?? 0);
  out.push(`  the server's rebuild at this scale, cold: dashboardState + projectInventory = ${ms(rebuild)} ms (in process, above)`);
  return out;
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
        const child = runScaleInChild(opts.dist, scale, opts);
        result = child.result;
        status = Math.max(status, child.status);
      } else {
        result = await runScale(opts.dist, scale, opts);
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
