#!/usr/bin/env node
/**
 * The memory-use eval: does a saved fact that is in neither the prompt nor the
 * repository change what a real session builds, and does memory that is not
 * about the task leave it alone?
 *
 * The retrieval eval measures whether the right entries are found on a fixed
 * corpus; `memory-usage.mjs` reads a developer's own transcripts. Neither can
 * tell use from coincidence. This runs the same task in whole `claude`
 * sessions under controlled arms and checks the code that comes out:
 *
 *   relevant    memory on; the project remembers a decision the task depends
 *               on (CSV exports use `;` for the finance importer), plus the
 *               superseded entry it corrected (`,`), plus newer unrelated work
 *   off         the same database, `memory.enabled: false`
 *   irrelevant  memory on; only the unrelated work
 *   titleonly   memory on; the same decision, worded so that prompt recall does
 *               not match it (cosine under its 0.35 gate): the session sees one
 *               timeline title and has to fetch the entry to learn the rule
 *   searchonly  memory on; the same decision, a month old behind sixty newer
 *               entries, so neither the session-start timeline nor prompt
 *               recall shows it: only a search finds it
 *   discover    memory on; the session is asked to call memory_search, which
 *               shows the tools are discoverable and callable in a fresh session
 *
 *   node eval/memory-use-harness.mjs run --plugin <dir> --label <name> [--arms relevant,off] [--trials 3]
 *   node eval/memory-use-harness.mjs score <run-dir> [<run-dir> ...]
 *
 * The fact never appears in the prompt or the fixture, so a `;` delimiter with
 * memory off would be a guess, and the `off` arm measures how often that guess
 * happens. Success is read from the code (`exportCsv` run on a sample, and the
 * fixture's tests), not from whether the answer cites memory: a citation is not
 * use, and use without a citation still counts.
 *
 * Isolation follows `delegation-harness.mjs`: project/local settings only,
 * exactly one `--plugin-dir`, no claude.ai connectors, a fresh `EKLAVYA_HOME`
 * per trial with its database seeded before the session starts, questions,
 * updates, telemetry and the dashboard off. All fixture memory is synthetic.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as usage from './usage.mjs';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(evalDir, 'fixtures', 'memory-use', 'project');

const VALUE_FLAGS = new Set(['plugin', 'label', 'trials', 'arms', 'parallel', 'out', 'timeout-min', 'model']);
function flag(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  return VALUE_FLAGS.has(name) ? (process.argv[i + 1] ?? dflt) : true;
}
function positionals() {
  const out = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a.slice(2))) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}
function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

const TASK =
  'Add an `exportCsv(rows)` function in src/export.js that turns an array of plain objects into CSV text: a header line from the first object\'s keys, then one line per row, lines joined with "\\n". Export it, add tests in test/export.test.js, and run `npm test`. Follow this project\'s conventions for exports. When you are done, reply with one line saying which field delimiter you used and why.';

const ARMS = {
  relevant: { memory: true, seed: 'relevant', prompt: TASK },
  off: { memory: false, seed: 'relevant', prompt: TASK },
  irrelevant: { memory: true, seed: 'irrelevant', prompt: TASK },
  titleonly: { memory: true, seed: 'titleonly', prompt: TASK },
  searchonly: { memory: true, seed: 'searchonly', prompt: TASK },
  discover: {
    memory: true,
    seed: 'relevant',
    prompt:
      "Use Eklavya's memory_search tool to search this project's memory for \"finance importer\". Reply with only the entry ids it returned, comma-separated, or NONE if the tool is not available to you.",
  },
};

/** Newer work that is not about exports, so the decision is not the newest entry. */
const FILLER = [
  ['Dashboard sidebar collapses below 900px', 'change'],
  ['Monthly report title uses the fiscal month name', 'change'],
  ['summarize skips rows without a category', 'bugfix'],
  ['README lists each helper with one line', 'change'],
  ['Node test runner replaces mocha', 'decision'],
  ['Category names are trimmed before totals', 'bugfix'],
  ['Chart colours come from the shared palette', 'change'],
  ['Report footer shows the generation date', 'change'],
  ['Currency amounts stay integers in cents', 'decision'],
  ['CI runs npm test on every push', 'change'],
  ['Empty input returns an empty totals object', 'bugfix'],
  ['Rounding happens only at display time', 'decision'],
];

function seed(plugin, home, repo, kind) {
  const url = (f) => JSON.stringify(pathToFileURL(path.join(plugin, 'mcp', 'dist', f)).href);
  const script = `
    const { openDb } = await import(${url('db.js')});
    const { insertEntry, supersedeEntry } = await import(${url('memory/store.js')});
    const { findRepoConfig } = await import(${url('config.js')});
    const { projectKey } = await import(${url('store.js')});
    const project = projectKey(findRepoConfig(${JSON.stringify(repo)}).repoRoot);
    const db = openDb();
    const ago = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
    const ids = {};
    if (${JSON.stringify(kind)} === 'relevant') {
      ids.stale = insertEntry(db, { project, sessionId: 'past-1', type: 'decision', title: 'CSV export delimiter chosen', narrative: 'CSV exports use a comma between fields.', files: ['src/export.js'], occurredAt: ago(240) });
      ids.decision = insertEntry(db, { project, sessionId: 'past-2', type: 'decision', title: 'CSV export convention for the finance importer', narrative: 'The finance importer rejects comma-separated files: every CSV export in this project must use a semicolon (;) between fields. This replaces the earlier comma decision.', facts: ['CSV exports use ; as the field delimiter'], files: ['src/export.js'], occurredAt: ago(72) });
      supersedeEntry(db, ids.stale, ids.decision);
    } else if (${JSON.stringify(kind)} === 'titleonly' || ${JSON.stringify(kind)} === 'searchonly') {
      const old = ${JSON.stringify(kind)} === 'searchonly';
      ids.decision = insertEntry(db, { project, sessionId: 'past-2', type: 'decision', title: 'Finance team importer quirk', narrative: 'Their importer refuses commas between values; give it semicolons.', occurredAt: ago(old ? 720 : 72) });
      if (old) for (let i = 0; i < 60; i++) insertEntry(db, { project, sessionId: 'past-old', type: 'change', title: 'Layout tweak ' + i + ' on the summary page', narrative: 'Spacing.', occurredAt: ago(600 - i * 8) });
    } else {
      ids.unrelated = insertEntry(db, { project, sessionId: 'past-2', type: 'decision', title: 'Report PDFs use A4 portrait', narrative: 'Finance prints on A4, so the PDF report is A4 portrait with 2cm margins.', occurredAt: ago(72) });
    }
    ${JSON.stringify(FILLER)}.forEach(([title, type], i) =>
      insertEntry(db, { project, sessionId: 'past-3', type, title, narrative: title + '.', occurredAt: ago(48 - i * 3) }));
    db.close();
    process.stdout.write(JSON.stringify({ project, ids }));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, EKLAVYA_HOME: home, EKLAVYA_DB: path.join(home, 'knowledge.db') },
  });
  if (res.status !== 0) fail(`seeding failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@example.com', GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@example.com' };
function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (res.status !== 0) fail(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

function prepare(trialDir, plugin, arm) {
  const repo = path.join(trialDir, 'reportkit');
  fs.cpSync(fixture, repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'chore: initial reportkit');
  const home = path.join(trialDir, 'eklavya-home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ auto_update: false, telemetry: false, dashboard_autostart: false, quiz: { enabled: false }, memory: { enabled: arm.memory } }, null, 2),
  );
  const seeded = seed(plugin, home, fs.realpathSync(repo), arm.seed);
  return { repo, home, seeded };
}

const sessions = [];
function sessionUsage(trialDir) {
  const u = usage.fromStream(path.join(trialDir, 'stream.jsonl'));
  sessions.push(u);
  return u;
}

function drive({ cwd, prompt, plugin, env, out, timeoutMs, model }) {
  return new Promise((resolve) => {
    const args = [
      '-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-hook-events',
      '--permission-mode', 'bypassPermissions', '--setting-sources', 'project,local', '--plugin-dir', plugin,
    ];
    if (model) args.push('--model', model);
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(out);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (d) => log.write(d));
    child.stderr.on('data', (d) => log.write(`${JSON.stringify({ type: 'harness_stderr', text: String(d).slice(0, 2000) })}\n`));
    child.on('close', (code) => {
      clearTimeout(timer);
      log.end(() => resolve({ code, timedOut }));
    });
  });
}

/** What the code does, not what the answer says. */
function inspectCode(repo) {
  const tests = spawnSync('npm', ['test', '-s'], { cwd: repo, encoding: 'utf8' }).status === 0;
  const probe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(path.join(repo, 'src', 'export.js')).href)}); process.stdout.write(String(m.exportCsv([{ a: 1, b: 2 }])));`],
    { encoding: 'utf8' },
  );
  const header = probe.status === 0 ? probe.stdout.split('\n')[0] : null;
  const delimiter = header === null ? null : header.includes(';') ? ';' : header.includes(',') ? ',' : header.includes('\t') ? 'tab' : 'other';
  return { tests, delimiter, header };
}

function dbFacts(home) {
  const db = path.join(home, 'knowledge.db');
  const q = (sql) => {
    const out = spawnSync('sqlite3', ['-json', db, sql], { encoding: 'utf8' }).stdout.trim();
    return out ? JSON.parse(out) : [];
  };
  return {
    receipts: q('SELECT scope, delivery, item_count, delivered_tokens FROM context_receipts ORDER BY id'),
    reads: q('SELECT tool, receipt_id, entry_ids, outcome, latency_ms, result_tokens FROM memory_reads ORDER BY id'),
  };
}

async function runCommand() {
  const plugin = path.resolve(flag('plugin') ?? fail('--plugin <eklavya checkout with mcp/dist> is required'));
  if (!fs.existsSync(path.join(plugin, 'mcp', 'dist', 'db.js'))) fail(`${plugin}/mcp/dist is missing. Build it first.`);
  const label = flag('label', 'run');
  const trials = Number(flag('trials', '3'));
  const arms = (flag('arms') ?? 'relevant,off,irrelevant,discover').split(',');
  const parallel = Number(flag('parallel', '4'));
  const timeoutMs = Number(flag('timeout-min', '15')) * 60_000;
  const outDir = path.resolve(flag('out') ?? fs.mkdtempSync(path.join(os.tmpdir(), `memory-use-${label}-`)));
  fs.mkdirSync(outDir, { recursive: true });
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: plugin, encoding: 'utf8' }).stdout.trim() || 'not a git checkout';
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: plugin, encoding: 'utf8' }).stdout.trim() !== '';
  const version = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const host = spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(
    path.join(outDir, 'run.json'),
    JSON.stringify({ label, plugin, revision, dirty, version, host, trials, arms, model: flag('model') ?? 'host default', started: new Date().toISOString() }, null, 2),
  );

  const jobs = [];
  for (let t = 1; t <= trials; t++) for (const name of arms) jobs.push({ name, t });
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { name, t } = jobs[next++];
      const arm = ARMS[name] ?? fail(`unknown arm ${name}`);
      const trialDir = path.join(outDir, `${name}-${t}`);
      fs.rmSync(trialDir, { recursive: true, force: true });
      fs.mkdirSync(trialDir, { recursive: true });
      const { repo, home, seeded } = prepare(trialDir, plugin, arm);
      const env = { ...process.env, EKLAVYA_HOME: home, EKLAVYA_DB: path.join(home, 'knowledge.db'), ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };
      const started = Date.now();
      process.stderr.write(`start ${name}-${t}\n`);
      const res = await drive({ cwd: repo, prompt: arm.prompt, plugin, env, out: path.join(trialDir, 'stream.jsonl'), timeoutMs, model: flag('model') });
      fs.writeFileSync(
        path.join(trialDir, 'trial.json'),
        JSON.stringify({ arm: name, trial: t, ...res, usage: sessionUsage(trialDir), seconds: Math.round((Date.now() - started) / 1000), seeded, code: name === 'discover' ? null : inspectCode(repo), db: dbFacts(home) }, null, 2),
      );
      process.stderr.write(`done  ${name}-${t} in ${Math.round((Date.now() - started) / 1000)}s${res.timedOut ? ' (timed out)' : ''}\n`);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  process.stderr.write(`${usage.line(usage.sum(sessions))}\n`);
  process.stdout.write(`${outDir}\n`);
}

// ---------------------------------------------------------------- scoring

/** Every string in a JSON value, JSON-encoded strings (hook output) opened too. */
function strings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    if (value.startsWith('{')) {
      try {
        strings(JSON.parse(value), out);
      } catch {
        /* not JSON */
      }
    }
  } else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

const BLOCK = /<eklavya-memory\b[^>]*>[\s\S]*?<\/eklavya-memory>/g;
const MEMORY_TOOL = /memory_(search|get|timeline|file_history)$/;

export function scoreTrial(dir) {
  const trial = JSON.parse(fs.readFileSync(path.join(dir, 'trial.json'), 'utf8'));
  const lines = fs.readFileSync(path.join(dir, 'stream.jsonl'), 'utf8').split('\n').filter(Boolean);
  let init = null;
  let result = null;
  const toolUses = [];
  const blocks = new Set();
  let finalText = '';
  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'system' && o.subtype === 'init') init = o;
    if (o.type === 'result') result = o;
    if (o.type === 'assistant') {
      for (const c of o.message?.content ?? []) {
        if (c.type === 'tool_use') toolUses.push(c.name);
        if (c.type === 'text') finalText = c.text;
      }
    }
    // Recall reaches the model as hook context; the model's own tool results
    // are counted separately, as fetches.
    if (o.type !== 'assistant' && !(o.type === 'user' && o.message?.content?.some?.((c) => c.type === 'tool_result'))) {
      for (const s of strings(o)) for (const m of s.match(BLOCK) ?? []) blocks.add(m);
    }
  }
  const decision = trial.seeded.ids.decision;
  const recalledBlocks = [...blocks];
  // The host's own built-ins load in every session; anything else is contamination.
  const plugins = (init?.plugins ?? []).filter((p) => p.path !== 'builtin').map((p) => p.name ?? p);
  const tools = init?.tools ?? [];
  return {
    arm: trial.arm,
    trial: trial.trial,
    model: init?.model ?? null,
    valid: !trial.timedOut && result?.is_error === false && plugins.every((p) => /eklavya/.test(p)),
    memory_tools_listed: tools.filter((t) => MEMORY_TOOL.test(t)).length,
    tool_search_calls: toolUses.filter((t) => t === 'ToolSearch').length,
    memory_tool_calls: toolUses.filter((t) => MEMORY_TOOL.test(t)).length,
    memory_tools_called: [...new Set(toolUses.filter((t) => MEMORY_TOOL.test(t)))],
    decision_fetched: decision ? trial.db.reads.some((r) => r.tool === 'memory_get' && JSON.parse(r.entry_ids).includes(decision)) : null,
    recall_blocks: recalledBlocks.length,
    recall_tokens: Math.ceil(recalledBlocks.join('').length / 4),
    // Retrieval relevance: was the decision in front of the model at all, and in
    // full (the narrative) or only as a timeline title it would have to fetch.
    decision_listed: decision ? recalledBlocks.some((b) => b.includes(`#${decision}]`)) : null,
    decision_in_full: decision ? recalledBlocks.some((b) => /rejects comma-separated files|refuses commas/.test(b)) : null,
    stale_shown: trial.seeded.ids.stale ? recalledBlocks.some((b) => b.includes(`#${trial.seeded.ids.stale}]`)) : null,
    reads_logged: trial.db.reads.length,
    reads_linked: trial.db.reads.filter((r) => r.receipt_id !== null).length,
    receipts: trial.db.receipts.map((r) => `${r.scope}:${r.delivery}`),
    delimiter: trial.code?.delimiter ?? null,
    tests_pass: trial.code?.tests ?? null,
    answer: finalText.slice(0, 300),
    seconds: trial.seconds,
    duration_ms: result?.duration_ms ?? null,
    input_tokens: result?.usage ? (result.usage.input_tokens ?? 0) + (result.usage.cache_read_input_tokens ?? 0) + (result.usage.cache_creation_input_tokens ?? 0) : null,
    output_tokens: result?.usage?.output_tokens ?? null,
  };
}

function scoreCommand() {
  const dirs = positionals().slice(1);
  if (!dirs.length) fail('score <run-dir> [<run-dir> ...]');
  const rows = [];
  for (const runDir of dirs) {
    const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    for (const sub of fs.readdirSync(runDir).sort()) {
      if (!fs.existsSync(path.join(runDir, sub, 'trial.json'))) continue;
      rows.push({ label: run.label, ...scoreTrial(path.join(runDir, sub)) });
    }
  }
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.label}/${r.arm}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const summary = [...groups].map(([k, rs]) => {
    const valid = rs.filter((r) => r.valid);
    const n = valid.length;
    const count = (f) => valid.filter(f).length;
    return {
      group: k,
      valid: `${n}/${rs.length}`,
      semicolon: `${count((r) => r.delimiter === ';')}/${n}`,
      comma: `${count((r) => r.delimiter === ',')}/${n}`,
      tests_pass: `${count((r) => r.tests_pass)}/${n}`,
      fetched: `${count((r) => r.memory_tool_calls > 0)}/${n}`,
      decision_listed: `${count((r) => r.decision_listed)}/${n}`,
      decision_in_full: `${count((r) => r.decision_in_full)}/${n}`,
      stale_shown: `${count((r) => r.stale_shown)}/${n}`,
      mean_recall_tokens: mean(valid.map((r) => r.recall_tokens)),
      mean_seconds: mean(valid.map((r) => r.duration_ms / 1000)),
      mean_input_tokens: mean(valid.map((r) => r.input_tokens)),
    };
  });
  process.stdout.write(`${JSON.stringify({ trials: rows, summary }, null, 2)}\n`);
}

const command = positionals()[0];
if (command === 'run') await runCommand();
else if (command === 'score') scoreCommand();
else fail('usage: memory-use-harness.mjs run --plugin <dir> --label <name> | score <run-dir> ...');
