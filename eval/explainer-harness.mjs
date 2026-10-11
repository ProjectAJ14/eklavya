#!/usr/bin/env node
/**
 * The explainer eval: does the page `agents/explainer.md` writes keep the
 * contract that file states, and does it explain?
 *
 *   node eval/explainer-harness.mjs run --root <checkout> --label baseline --trials 3
 *   node eval/explainer-harness.mjs run --cases wrong-pick-debounce --trials 1   # a first, small run
 *   node eval/explainer-harness.mjs score <run-dir> [--no-judge] [--rejudge]
 *   node eval/explainer-harness.mjs compare <baseline-dir> <candidate-dir>      # blind, one judge call per pair
 *
 * Cost: each trial is a whole agent run with tools, roughly 60k-100k input
 * tokens over several calls, plus one judge call per page that passes the
 * gates. 10 cases x 3 trials is 30 agent runs. `--limit` caps the trials.
 *
 * Each trial gets a fresh `EKLAVYA_HOME`, a throwaway project holding the
 * case's code, and an `eklavya` on PATH that runs this checkout's real CLI
 * (`mcp/dist/cli.js`) but records its arguments, snapshots the page `new`
 * wrote, and makes `open` print instead of launching a browser. Then
 * `claude -p` runs with the agent's instructions from `--root` as the system
 * prompt and the agent's tool set, and the brief the tutor would hand it.
 *
 * Claude Code cannot run under a throwaway HOME (it loses its login), so the
 * two home paths the agent names are rewritten to per-trial copies: the
 * artifact skill (`--skill on` copies `user-skill/eklavya-artifacts` from
 * `--root`; `off`, the default, leaves it absent, so the eval measures the
 * agent file and not whatever skill is installed) and the runtime `.bin`. A
 * session that mentions the real paths fails the `isolated` gate.
 *
 * What this cannot tell you: a subagent's real system prompt carries Claude
 * Code's environment block too; judge and generator come from one model
 * family; and ten cases are a sample.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as usage from './usage.mjs';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(evalDir);
const VALUE_FLAGS = new Set(['root', 'label', 'trials', 'parallel', 'out', 'model', 'cases', 'skill', 'limit', 'judge-model']);
const TOOLS = 'Read,Write,Edit,Bash,Glob,Grep';

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

const fixtures = () => JSON.parse(fs.readFileSync(path.join(evalDir, 'fixtures', 'explainer', 'cases.json'), 'utf8')).cases;
const letter = (i) => String.fromCharCode(65 + i);

/** The agent's instructions from `root`, with its home paths pointed at this trial. */
function agentPrompt(root, pointHome, { skill, runtimeBin, cwd }) {
  const body = fs.readFileSync(path.join(root, 'agents', 'explainer.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  return `${pointHome(body, { skill, runtimeBin }, true)}\n\nWorking directory: ${cwd}\nPlatform: ${process.platform}`;
}

/** An `eklavya` that runs the real CLI, logs its argv, keeps `new`'s page, and never opens a browser. */
function stub(file, dir) {
  const cli = path.join(repoRoot, 'mcp', 'dist', 'cli.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/eklavya-calls.log"
if [ "$1" = artifacts ] && [ "$2" = open ]; then printf '%s\\n' "$3"; exit 0; fi
out=$("${process.execPath}" "${cli}" "$@"); code=$?
printf '%s\\n' "$out"
if [ "$1" = artifacts ] && [ "$2" = new ] && [ "$code" = 0 ] && [ -f "$out" ] && [ ! -f "${dir}/template.html" ]; then cp "$out" "${dir}/template.html"; fi
exit $code
`,
  );
  fs.chmodSync(file, 0o755);
}

/** PATH without any directory that already holds an `eklavya`, so only the stub resolves. The stub names node by path, since node often shares that directory. */
function cleanPath() {
  return (process.env.PATH ?? '').split(path.delimiter).filter((d) => d && !fs.existsSync(path.join(d, 'eklavya'))).join(path.delimiter);
}

function setup(root, c, dir, skillMode, pointHome) {
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  const bin = path.join(dir, 'bin');
  const runtimeBin = path.join(dir, 'runtime', '.bin', 'eklavya');
  const skill = path.join(dir, 'skills', 'eklavya-artifacts', 'SKILL.md');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  // The code lives in the file its first comment names, so the agent can open it.
  const named = /^(?:\/\/|#|--)\s*([\w./-]+\.\w+)\s*$/m.exec(c.code ?? '')?.[1];
  const src = path.join(project, named ?? 'snippet.txt');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, `${c.code ?? ''}\n`);
  execFileSync('git', ['init', '-q'], { cwd: project });
  stub(runtimeBin, dir);
  if (c.binary !== 'runtime') stub(path.join(bin, 'eklavya'), dir);
  if (skillMode === 'on') {
    const text = fs.readFileSync(path.join(root, 'user-skill', 'eklavya-artifacts', 'SKILL.md'), 'utf8');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, pointHome(text, { runtimeBin }, false));
  }
  const env = {
    ...process.env,
    EKLAVYA_HOME: home,
    EKLAVYA_DB: path.join(home, 'knowledge.db'),
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    PATH: c.binary === 'runtime' ? cleanPath() : `${bin}${path.delimiter}${cleanPath()}`,
  };
  return { home, project, env, system: agentPrompt(root, pointHome, { skill, runtimeBin, cwd: project }) };
}

function session({ prompt, system, cwd, env, log, model }) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--system-prompt', system, '--tools', TOOLS, '--allowedTools', TOOLS,
      '--permission-mode', 'bypassPermissions', '--setting-sources', 'project,local', '--strict-mcp-config',
      '--no-session-persistence', '--disable-slash-commands', '--output-format', 'stream-json', '--verbose'];
    if (model) args.push('--model', model);
    const out = fs.openSync(log, 'w');
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', out, 'pipe'] });
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), Number(process.env.EKLAVYA_EVAL_TIMEOUT_MS ?? 600000));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ error: `claude not runnable: ${e.message}` }));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(out);
      resolve(signal ? { error: `claude timed out (${signal})` } : code !== 0 ? { error: `claude exited ${code}: ${err.slice(0, 300)}` } : {});
    });
  });
}

function lastResult(log) {
  let last = null;
  for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
    if (!line.includes('"type":"result"')) continue;
    try {
      last = JSON.parse(line);
    } catch {
      /* a partial line */
    }
  }
  return last;
}

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

function progress(out, body) {
  try {
    fs.writeFileSync(path.join(out, 'progress.tmp'), JSON.stringify({ ...body, updated: Date.now() / 1000 }));
    fs.renameSync(path.join(out, 'progress.tmp'), path.join(out, 'progress.json'));
  } catch {
    /* a dashboard that cannot be written never stops an eval */
  }
}

async function run() {
  const root = path.resolve(flag('root', repoRoot));
  const label = flag('label', 'run');
  const trials = Number(flag('trials', 1));
  const skillMode = flag('skill', 'off');
  const only = flag('cases') ? new Set(String(flag('cases')).split(',')) : null;
  const model = flag('model');
  if (!fs.existsSync(path.join(repoRoot, 'mcp', 'dist', 'cli.js'))) fail('mcp/dist is missing. Run `npm run build` in mcp/ first.');
  const { brief, pointHome } = await loadDist('eval/explainer-score.js');
  const out = path.resolve(flag('out') ?? fs.mkdtempSync(path.join(os.tmpdir(), `eklavya-explainer-${label}-`)));
  fs.mkdirSync(out, { recursive: true });
  let jobs = fixtures().filter((c) => !only || only.has(c.id)).flatMap((c) => Array.from({ length: trials }, (_, t) => ({ c, t })));
  if (flag('limit')) jobs = jobs.slice(0, Number(flag('limit')));
  const started = Date.now() / 1000;
  const totals = [];
  let done = 0;
  process.stdout.write(`${jobs.length} agent runs, root ${root}, skill ${skillMode}, out ${out}\n`);
  progress(out, { label, state: 'running', trials_done: 0, trials_total: jobs.length, started });
  await pool(jobs, Number(flag('parallel', 3)), async ({ c, t }) => {
    const dir = path.join(out, `${c.id}.${t}`);
    fs.rmSync(dir, { recursive: true, force: true });
    let trial;
    try {
      trial = setup(root, c, dir, skillMode, pointHome);
    } catch (err) {
      fail(String(err.message ?? err));
    }
    const { project, env, system } = trial;
    const log = path.join(dir, 'session.jsonl');
    const res = await session({ prompt: brief(c), system, cwd: project, env, log, model });
    const result = fs.existsSync(log) ? lastResult(log) : null;
    const u = fs.existsSync(log) ? usage.fromStream(log) : null;
    totals.push(u);
    const record = { case: c.id, trial: t, error: res.error ?? (result ? undefined : 'no result event'), reply: result?.result ?? '', duration_ms: result?.duration_ms ?? null, num_turns: result?.num_turns ?? null, usage: u };
    fs.writeFileSync(path.join(dir, 'trial.json'), JSON.stringify(record, null, 1));
    done += 1;
    progress(out, { label, state: 'running', trials_done: done, trials_total: jobs.length, started, calls: usage.sum(totals).calls, tokens: usage.summary(usage.sum(totals)) });
    process.stdout.write(`  ${c.id} #${t} ${record.error ? `ERROR ${record.error}` : `ok ${Math.round((record.duration_ms ?? 0) / 1000)}s`}\n`);
  });
  const total = usage.sum(totals);
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ label, root, trials, skill: skillMode, model: model ?? 'default', at: new Date().toISOString(), usage: usage.summary(total) }, null, 1));
  progress(out, { label, state: 'done', trials_done: done, trials_total: jobs.length, started, tokens: usage.summary(total) });
  process.stdout.write(`agent ${usage.line(total)}\n`);
  await score(out);
}

function pagesUnder(dir) {
  const found = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.html')) found.push(f);
    }
  };
  walk(dir);
  return found;
}

function judgePrompt(c, sections, page) {
  const asked = c.stem
    ? [`Question: ${c.stem}`, ...(c.options ?? []).map((o, i) => `${letter(i)}. ${o}`), `The developer answered: ${c.dont_know ? "I don't know" : c.typed ?? `${letter(c.pick)}. ${c.options[c.pick]}`}`, `Right answer: ${typeof c.right === 'number' ? c.options[c.right] : c.right}`]
    : [`The developer asked: ${c.request}`];
  return [
    'You are reviewing a page written to teach one programming concept to a developer who has not learned it yet. Read it as that developer would.',
    '',
    `Concept: ${c.concept.name}`,
    ...asked,
    '',
    '=== THE SHORT ANSWER SECTION ===',
    sections.short ?? '(missing)',
    '',
    '=== THE "WHERE THE ANSWER WENT WRONG" SECTION ===',
    sections.wrong ?? '(none)',
    '',
    '=== THE WHOLE PAGE, AS TEXT (diagrams removed) ===',
    page.slice(0, 12000),
    '',
    'Answer three things:',
    '1. misconception_named: does the "went wrong" section name the specific mistaken belief behind the answer the developer actually gave (not a generic mistake, not a different option), and say why it is tempting? null when the section is absent and no wrong answer was given.',
    '2. newcomer_can_repeat: after reading only the short answer, could a developer new to this concept repeat in their own words what the thing does? It fails if it leans on undefined jargon, names the concept without saying what it does, or runs past three sentences.',
    '3. clarity: 1-5, how well a developer who did not know this concept would understand the mechanism, and be able to predict the behaviour in their own code, after one read. 5 = they could explain it to a colleague; 3 = they follow it but could not apply it; 1 = confusing or wrong.',
    '',
    'Reply with one JSON object and nothing else:',
    '{"misconception_named": true|false|null, "newcomer_can_repeat": true|false, "clarity": 1-5, "why": "<one sentence per answer>"}',
  ].join('\n');
}

function ask(prompt, model) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', 'project,local', '--no-session-persistence'];
    if (model) args.push('--model', model);
    const child = spawn('claude', args, { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      try {
        resolve(usage.unwrap(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function loadDist(rel) {
  try {
    return await import(pathToFileURL(path.join(repoRoot, 'mcp', 'dist', rel)).href);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') fail('mcp/dist is missing or stale. Run `npm run build` in mcp/ first.');
    throw err;
  }
}

async function score(dir) {
  const { scorePage, sectionText, contentOf, text, summarise } = await loadDist('eval/explainer-score.js');
  const { extractJson } = await loadDist('eval/extract-json.js');
  const byId = new Map(fixtures().map((c) => [c.id, c]));
  const judge = !flag('no-judge');
  const results = [];
  const trialDirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && /\.\d+$/.test(e.name)).map((e) => e.name).sort();
  for (const name of trialDirs) {
    const d = path.join(dir, name);
    const rec = JSON.parse(fs.readFileSync(path.join(d, 'trial.json'), 'utf8'));
    const c = byId.get(rec.case);
    if (!c) continue;
    const pages = pagesUnder(path.join(d, 'home', 'artifacts'));
    const tplFile = path.join(d, 'template.html');
    if (rec.error || !pages.length || !fs.existsSync(tplFile)) {
      results.push({ case: rec.case, trial: rec.trial, error: rec.error ?? (pages.length ? 'eklavya artifacts new never ran through the stub' : 'no page written'), gates: [] });
      continue;
    }
    const page = fs.readFileSync(pages[0], 'utf8');
    const template = fs.readFileSync(tplFile, 'utf8');
    const calls = fs.existsSync(path.join(d, 'eklavya-calls.log')) ? fs.readFileSync(path.join(d, 'eklavya-calls.log'), 'utf8').split('\n') : [];
    const opened = calls.filter((l) => l.startsWith('artifacts open ')).map((l) => path.normalize(l.slice('artifacts open '.length).trim()));
    const { gates, metrics } = scorePage({ page, template, case: c, files: pages.length, opened, reply: rec.reply, path: pages[0] });
    const log = fs.readFileSync(path.join(d, 'session.jsonl'), 'utf8');
    const leaked = [path.join(os.homedir(), '.claude', 'skills', 'eklavya-artifacts'), path.join(os.homedir(), '.eklavya')].filter((p) => log.includes(p));
    gates.push({ id: 'isolated', ok: leaked.length === 0, detail: leaked.join(' ') });
    const row = { case: c.id, trial: rec.trial, gates, metrics, duration_ms: rec.duration_ms, usage: rec.usage };
    // A saved verdict is reused, so adding a gate re-scores for free; --rejudge asks again.
    const saved = fs.existsSync(path.join(d, 'score.json')) ? JSON.parse(fs.readFileSync(path.join(d, 'score.json'), 'utf8')).judge : null;
    const judgeable = gates.filter((g) => g.id !== 'short_answer_brief').every((g) => g.ok);
    if (saved && !saved.error && !flag('rejudge')) row.judge = saved;
    else if (judge && judgeable) {
      try {
        const reply = await ask(judgePrompt(c, sectionText(page, template), text(contentOf(page, template).replace(/<svg[\s\S]*?<\/svg>/g, ' '))), flag('judge-model'));
        row.judge = extractJson(reply);
      } catch (err) {
        row.judge = { error: String(err.message ?? err) };
      }
    }
    results.push(row);
    fs.writeFileSync(path.join(d, 'score.json'), JSON.stringify(row, null, 1));
  }
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 1));
  const sum = summarise(results);
  const judged = results.filter((r) => r.judge && !r.judge.error);
  const rate = (k) => {
    const xs = judged.filter((r) => r.judge[k] !== null && r.judge[k] !== undefined);
    return xs.length ? `${xs.filter((r) => r.judge[k] === true).length}/${xs.length}` : 'n/a';
  };
  const mean = (xs) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : 'n/a');
  const scored = results.filter((r) => r.metrics);
  process.stdout.write(`\n${sum.clean}/${sum.trials} pages pass every gate (${sum.errored} errored)\n`);
  process.stdout.write(`failing gates: ${Object.entries(sum.failed).map(([k, n]) => `${k} x${n}`).join(', ') || 'none'}\n`);
  process.stdout.write(`judge on ${judged.length} pages: misconception named ${rate('misconception_named')}, short answer repeatable ${rate('newcomer_can_repeat')}, clarity ${mean(judged.map((r) => r.judge.clarity))}/5\n`);
  process.stdout.write(`page words ${mean(scored.map((r) => r.metrics.words))}, figures ${mean(scored.map((r) => r.metrics.figures))}, own-code names ${mean(scored.map((r) => r.metrics.identifiers_used / Math.max(1, r.metrics.identifiers_offered)))} of offered, time to path line ${mean(scored.map((r) => (r.duration_ms ?? 0) / 1000))}s\n`);
  for (const [id, row] of Object.entries(sum.byCase)) process.stdout.write(`  ${row.clean === row.trials ? 'PASS' : 'FAIL'} ${id}: ${row.clean}/${row.trials}\n`);
  if (judged.length) process.stdout.write(`judge ${usage.line()}\n`);
}

function comparePrompt(c, first, second) {
  const asked = c.stem
    ? [`Question: ${c.stem}`, `The developer answered: ${c.dont_know ? "I don't know" : c.typed ?? `${c.options[c.pick]}`}`, `Right answer: ${typeof c.right === 'number' ? c.options[c.right] : c.right}`]
    : [`The developer asked: ${c.request}`];
  return [
    'Two pages were written to teach the same programming concept to a developer who has not learned it yet. Diagram labels appear inline as text.',
    '',
    `Concept: ${c.concept.name}`,
    ...asked,
    '',
    '=== PAGE 1 ===',
    first.slice(0, 12000),
    '',
    '=== PAGE 2 ===',
    second.slice(0, 12000),
    '',
    'Which page would leave that developer better able to explain the mechanism and predict what their own code does? Judge understanding, not length or polish: a shorter page that lands the idea wins. Say "tie" only when you cannot choose.',
    'Reply with one JSON object and nothing else: {"better": "1"|"2"|"tie", "why": "<one sentence>"}',
  ].join('\n');
}

/** Blind pairwise judging: trial t of run A against trial t of run B, order flipped by hash. */
async function compare(dirA, dirB) {
  const { contentOf, text } = await loadDist('eval/explainer-score.js');
  const { extractJson } = await loadDist('eval/extract-json.js');
  const byId = new Map(fixtures().map((c) => [c.id, c]));
  const read = (dir, name) => {
    const d = path.join(dir, name);
    const pages = pagesUnder(path.join(d, 'home', 'artifacts'));
    const tpl = path.join(d, 'template.html');
    if (!pages.length || !fs.existsSync(tpl)) return null;
    const body = contentOf(fs.readFileSync(pages[0], 'utf8'), fs.readFileSync(tpl, 'utf8'));
    return body === null ? null : text(body);
  };
  const names = fs.readdirSync(dirA).filter((n) => /\.\d+$/.test(n) && fs.existsSync(path.join(dirB, n))).sort();
  const tally = { a: 0, b: 0, tie: 0, skipped: 0 };
  const rows = [];
  await pool(names, Number(flag('parallel', 4)), async (name) => {
    const c = byId.get(name.replace(/\.\d+$/, ''));
    const a = read(dirA, name);
    const b = read(dirB, name);
    if (!c || !a || !b) {
      tally.skipped += 1;
      return;
    }
    const flip = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 2 === 1;
    try {
      const j = extractJson(await ask(comparePrompt(c, flip ? b : a, flip ? a : b), flag('judge-model')));
      const winner = j.better === 'tie' ? 'tie' : (j.better === '1') !== flip ? 'a' : 'b';
      tally[winner] += 1;
      rows.push({ trial: name, winner, why: j.why });
    } catch (err) {
      tally.skipped += 1;
      rows.push({ trial: name, error: String(err.message ?? err) });
    }
  });
  rows.sort((x, y) => x.trial.localeCompare(y.trial));
  fs.writeFileSync(path.join(dirB, `compare-vs-${path.basename(dirA)}.json`), JSON.stringify({ a: dirA, b: dirB, tally, rows }, null, 1));
  process.stdout.write(`A ${path.basename(dirA)} wins ${tally.a}, B ${path.basename(dirB)} wins ${tally.b}, ties ${tally.tie}, skipped ${tally.skipped}\n`);
  for (const r of rows) process.stdout.write(`  ${r.trial}: ${r.winner ?? 'ERROR'} -- ${r.why ?? r.error}\n`);
  process.stdout.write(`judge ${usage.line()}\n`);
}

const cmd = positionals()[0];
if (cmd === 'run') await run();
else if (cmd === 'score' && positionals()[1]) await score(path.resolve(positionals()[1]));
else if (cmd === 'compare' && positionals()[2]) await compare(path.resolve(positionals()[1]), path.resolve(positionals()[2]));
else fail('usage: explainer-harness.mjs run [--root <checkout>] [--label l] [--trials n] [--cases a,b] [--skill on|off] [--limit n] [--parallel n] [--model m] [--out dir] | score <run-dir> [--no-judge] [--rejudge] [--judge-model m] | compare <run-a> <run-b>');
