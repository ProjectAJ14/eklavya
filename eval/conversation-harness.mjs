#!/usr/bin/env node
/**
 * The conversation eval: does the tutor do the right thing at one frozen moment
 * of a session?
 *
 * `harness.mjs` measures a question before anyone answers it. The rules that
 * decide a session -- what a blank earns, what a decline earns, whether a
 * checkpoint stays one question, whether a missing-context complaint grades the
 * learner, whether a parallel tutor hands the explainer everything -- sit in
 * `grading.md` and `agents/tutor.md`, which the question eval never loads.
 *
 *   node eval/conversation-harness.mjs run --root <checkout> --label baseline --trials 3
 *   node eval/conversation-harness.mjs score <run-dir>
 *
 * Each scenario (eval/fixtures/conversation/scenarios.json) freezes the plan, the
 * question asked and what the learner said. The model gets the shipped tutor
 * pedagogy from `--root` (a checkout, so a baseline and a candidate can be run
 * against the same scenarios) and replies with the tool calls and message it
 * would produce next, as JSON. `mcp/src/eval/conversation-score.ts` judges that
 * reply against the scenario's rules. Nothing here touches a learner database.
 *
 * What this cannot tell you: it is one turn, the model is told which situation
 * it is in (a real session has to work that out), and tool results are scripted.
 * It catches contract regressions; it does not show that real sessions go well.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as usage from './usage.mjs';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(evalDir);
const VALUE_FLAGS = new Set(['root', 'label', 'trials', 'parallel', 'out', 'model', 'scenarios']);

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

const strip = (f) => fs.readFileSync(f, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();

/** The pedagogy a tutor in this scenario would have loaded, from `root`. */
export function pedagogy(root, scenario) {
  const tutor = path.join(root, 'skills', 'tutor');
  const files = [path.join(tutor, 'SKILL.md')];
  for (const r of ['grading.md', 'focus-and-level.md', 'writing-mcq.md']) files.push(path.join(tutor, 'references', r));
  if (scenario.plan?.presentation === 'panel') files.push(path.join(tutor, 'references', 'panel.md'));
  if (/parallel eklavya-tutor/.test(scenario.setting)) files.push(path.join(root, 'agents', 'tutor.md'));
  return files.filter((f) => fs.existsSync(f)).map((f) => `--- ${path.relative(root, f)} ---\n${strip(f)}`).join('\n\n');
}

export function buildPrompt(root, scenario, question) {
  const asked = scenario.asked;
  return [
    'You are the Eklavya tutor. Follow the pedagogy below exactly. This is a simulation: reply with what you would do next, not with a real tool call.',
    '',
    '=== PEDAGOGY (the shipped files) ===',
    pedagogy(root, scenario),
    '',
    '=== THE SITUATION ===',
    scenario.setting,
    '',
    '=== THE PLAN ITEM (authoritative) ===',
    JSON.stringify(scenario.plan, null, 2),
    '',
    ...(asked
      ? ['=== THE QUESTION YOU ASKED ===', JSON.stringify({ stem: asked.stem, options: asked.options, correct_option: asked.options[asked.correct - 1], option_notes: asked.option_notes }, null, 2), '']
      : ['=== THE QUESTION BANK (for the concept above; write your own question if you ask one) ===', JSON.stringify({ example_stem_style: question.stem }, null, 2), '']),
    scenario.learner === null || scenario.learner === undefined
      ? '=== THE LEARNER ===\n(no reply yet)'
      : `=== THE LEARNER ===\n${scenario.learner}`,
    ...(scenario.tool_results ? ['', '=== RESULT OF YOUR record_attempt CALL ===', JSON.stringify(scenario.tool_results, null, 2)] : []),
    '',
    'Reply with a single JSON object and nothing else:',
    '{"tool_calls": [{"tool": "<tool name, e.g. record_attempt, AskUserQuestion, present_question, get_session_quiz_plan, Agent>", "args": {...}}], "message": "<exactly what the learner would read, or an empty string>"}',
    'List only the calls you make in THIS turn, in order, with the real arguments you would pass. An empty list is valid.',
  ].join('\n');
}

function ask(prompt, model) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json'];
    if (model) args.push('--model', model);
    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), Number(process.env.EKLAVYA_EVAL_TIMEOUT_MS ?? 240000));
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`claude not runnable: ${e.message}`)));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error(`claude timed out (${signal})`));
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      try {
        resolve(usage.unwrap(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

async function loadDist(rel) {
  try {
    return await import(pathToFileURL(path.join(repoRoot, 'mcp', 'dist', rel)).href);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') fail('mcp/dist is missing or stale. Run `npm run build` in mcp/ first.');
    throw err;
  }
}

const fixtures = () => JSON.parse(fs.readFileSync(path.join(evalDir, 'fixtures', 'conversation', 'scenarios.json'), 'utf8'));

async function run() {
  const root = path.resolve(flag('root', repoRoot));
  const label = flag('label', 'run');
  const trials = Number(flag('trials', 2));
  const only = flag('scenarios') ? new Set(String(flag('scenarios')).split(',')) : null;
  const model = flag('model');
  const out = flag('out') ?? fs.mkdtempSync(path.join(os.tmpdir(), `eklavya-conversation-${label}-`));
  fs.mkdirSync(out, { recursive: true });
  const { question, scenarios } = fixtures();
  const jobs = scenarios.filter((s) => !only || only.has(s.id)).flatMap((s) => Array.from({ length: trials }, (_, t) => ({ s, t })));
  process.stdout.write(`${jobs.length} calls, root ${root}, out ${out}\n`);
  await pool(jobs, Number(flag('parallel', 4)), async ({ s, t }) => {
    const file = path.join(out, `${s.id}.${t}.json`);
    let record;
    try {
      record = { scenario: s.id, trial: t, reply: await ask(buildPrompt(root, s, question), model) };
    } catch (err) {
      record = { scenario: s.id, trial: t, error: String(err.message ?? err) };
    }
    fs.writeFileSync(file, JSON.stringify(record, null, 1));
    process.stdout.write(`  ${s.id} #${t} ${record.error ? 'ERROR' : 'ok'}\n`);
  });
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ label, root, trials, model: model ?? 'default', at: new Date().toISOString(), usage: usage.summary() }, null, 1));
  process.stdout.write(`${usage.line()}\n`);
  await score(out);
}

async function score(dir) {
  const { extractJson } = await loadDist('eval/extract-json.js');
  const { checkTurn, summarise } = await loadDist('eval/conversation-score.js');
  const byId = new Map(fixtures().scenarios.map((s) => [s.id, s]));
  const results = [];
  for (const f of fs.readdirSync(dir).filter((n) => /\.\d+\.json$/.test(n)).sort()) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const scenario = byId.get(rec.scenario);
    if (!scenario) continue;
    if (rec.error) {
      results.push({ scenario: rec.scenario, trial: rec.trial, unparsed: rec.error, verdicts: [] });
      continue;
    }
    let turn = null;
    try {
      turn = extractJson(rec.reply);
    } catch {
      /* falls through to unparsed */
    }
    if (!turn || !Array.isArray(turn.tool_calls) || typeof turn.message !== 'string') {
      results.push({ scenario: rec.scenario, trial: rec.trial, unparsed: 'reply was not the requested JSON', verdicts: [] });
      continue;
    }
    results.push({ scenario: rec.scenario, trial: rec.trial, verdicts: checkTurn(turn, scenario.rules) });
  }
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 1));
  const sum = summarise(results);
  process.stdout.write(`\n${sum.clean}/${sum.trials} trials clean (${sum.unparsed} unparsed or errored)\n`);
  for (const [id, row] of Object.entries(sum.byScenario)) {
    const failed = Object.entries(row.failed).map(([k, n]) => `${k} x${n}`).join(', ');
    process.stdout.write(`  ${row.clean === row.trials ? 'PASS' : 'FAIL'} ${id}: ${row.clean}/${row.trials}${row.unparsed ? `, ${row.unparsed} unparsed` : ''}${failed ? ` -- ${failed}` : ''}\n`);
  }
}

const cmd = positionals()[0];
if (cmd === 'run') await run();
else if (cmd === 'score' && positionals()[1]) await score(path.resolve(positionals()[1]));
else fail('usage: conversation-harness.mjs run [--root <checkout>] [--label l] [--trials n] [--parallel n] [--scenarios a,b] [--model m] [--out dir] | score <run-dir>');
