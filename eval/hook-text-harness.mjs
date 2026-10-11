#!/usr/bin/env node
/**
 * The hook-text eval: does the model do what the checkpoint and Stop hooks
 * tell it to, at the moment their text arrives?
 *
 * The conversation eval starts after a question is already in flight. This one
 * starts a step earlier, mid-task, when `checkpoint-quiz.ts` or
 * `stop-quiz-check.ts` hands the model its instruction: plan with `max: 1`, ask
 * ONE question, grade it, give a verdict and resume; or log first, then plan,
 * within the turn.
 *
 *   node eval/hook-text-harness.mjs run --scenarios checkpoint-tool-correct,stop-log-first --trials 1   # a first, small run
 *   node eval/hook-text-harness.mjs run --root <checkout> --label baseline --trials 5
 *   node eval/hook-text-harness.mjs score <run-dir>
 *
 * Cost: one `claude -p` call per trial, about 44k input tokens each (most of it
 * Claude Code's own context, cached after the first). 12 scenarios x 5 trials
 * is 60 calls, about 3M input tokens. `--limit` caps the calls.
 *
 * Each scenario (eval/fixtures/hook-text/scenarios.json) freezes a build task
 * part-way through, the hook's arguments, and what each tool returns. The hook
 * text itself comes from `--root`'s `mcp/dist/hooks/quiz-text-lib.js`, and the
 * plan's instruction fields from its `planGuidance`, so a baseline and a
 * candidate checkout are scored on the same scenarios with their own wording.
 * The model replies with every tool call it makes until its turn ends and the
 * text it shows, as JSON; `mcp/src/eval/conversation-score.ts` judges that.
 *
 * What this cannot tell you: the model is told the situation and the tool
 * results in advance, the tutor skill is not loaded (the hook text is measured
 * on its own, which is the case when the skill never triggers), and a clean
 * trial shows the rule is followed when read, not that real sessions improve.
 * The delegation harness remains the whole-session check.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as usage from './usage.mjs';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(evalDir);
const VALUE_FLAGS = new Set(['root', 'label', 'trials', 'parallel', 'out', 'model', 'scenarios', 'limit']);

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

async function load(root, rel) {
  const file = path.join(root, 'mcp', 'dist', rel);
  if (!fs.existsSync(file)) fail(`${file} is missing. Run \`npm run build\` in ${path.join(root, 'mcp')} first.`);
  return import(pathToFileURL(file).href);
}

const fixtures = () => JSON.parse(fs.readFileSync(path.join(evalDir, 'fixtures', 'hook-text', 'scenarios.json'), 'utf8'));

/** The plan `get_session_quiz_plan` would return, with `root`'s instruction fields. */
function planFor(fx, s, planGuidance, LEVEL_FRAMING) {
  const first = { ...fx.concept, ...s.concept };
  const items = [first, ...(s.plan.extra ?? []).map((c) => ({ ...fx.concept, ...c }))];
  const max = s.hook === 'checkpoint' ? 1 : s.text.asked;
  const concepts = items.slice(0, max);
  return {
    session_id: 's-1',
    questions_needed: concepts.length,
    focus: s.plan.focus,
    ...planGuidance(s.plan.focus, !!s.plan.enforced, s.plan.presentation, concepts.length),
    level: 'medium',
    level_framing: LEVEL_FRAMING.medium,
    level_progress: { passed: 9, needed: 20, concepts: 6, needed_concepts: 10, accuracy: 0.69, min_accuracy: 0.7, next: 'hard' },
    concepts,
  };
}

/** The Eklavya tools as a session sees them: name, description and input schema, from `root`. */
async function toolDefs(root) {
  const { z } = await import(pathToFileURL(path.join(root, 'mcp', 'node_modules', 'zod', 'index.js')).href);
  const { getSessionQuizPlan } = await load(root, 'tools/get_session_quiz_plan.js');
  const { recordAttempt } = await load(root, 'tools/record_attempt.js');
  const { logSessionConcepts } = await load(root, 'tools/log_session_concepts.js');
  const { presentQuestionTool } = await load(root, 'tools/panel_tools.js');
  return [getSessionQuizPlan, recordAttempt, logSessionConcepts, presentQuestionTool]
    .map((t) => `${t.name}: ${t.description}\ninput schema: ${JSON.stringify(z.toJSONSchema(z.object(t.inputSchema)))}`)
    .join('\n\n');
}

export async function buildPrompt(root, fx, s) {
  const { checkpointText, stopText } = await load(root, 'hooks/quiz-text-lib.js');
  const { planGuidance, LEVEL_FRAMING } = await load(root, 'tools/get_session_quiz_plan.js');
  const t = fx.task;
  const steps = [...(s.skipLog ? t.so_far.filter((x) => !/log_session_concepts/.test(x)) : t.so_far), ...(s.extra_steps ?? [])];
  const next = s.next_step ?? t.next_step;
  const hook =
    s.hook === 'checkpoint'
      ? [
          `Your last tool call was ${s.trigger ?? 'log_session_concepts'}. It succeeded, and its result came back with this attached:`,
          '<system-reminder>',
          `PostToolUse:${s.trigger ?? 'mcp__plugin_eklavya_eklavya__log_session_concepts'} hook additional context: ${checkpointText(s.text)}`,
          '</system-reminder>',
        ]
      : [
          'You had finished the task and ended your turn with a short report to the developer. The Stop hook blocked the stop and continued your turn with:',
          `Stop hook feedback:\n${stopText(s.text)}`,
        ];
  const results = { get_session_quiz_plan: planFor(fx, s, planGuidance, LEVEL_FRAMING), ...s.results };
  return [
    'You are Claude Code, partway through a coding task for a developer. The Eklavya plugin is installed: it teaches the developer the concepts behind the code you write. This is a simulation: reply with what you would do next, not with real tool calls.',
    '',
    'Tools you have include AskUserQuestion, Edit, Write, Bash, Read, Skill, and the Eklavya MCP tools below. The Eklavya server says: "Log the concepts your work touches, and quiz from the learner profile rather than from scratch -- never ask about a concept already mastered."',
    '',
    '=== EKLAVYA TOOLS ===',
    await toolDefs(root),
    '',
    '=== THE TASK ===',
    `The developer asked: "${t.request}"`,
    'So far you have:',
    ...steps.map((x) => `- ${x}`),
    s.hook === 'checkpoint' ? `Your next step was: ${next}` : `You then wrote the test (${next.replace(/^Write /, '').replace(/\.$/, '')}), ran it green, and reported back.`,
    '',
    '=== WHAT JUST HAPPENED ===',
    ...hook,
    '',
    '=== WHAT YOUR CALLS WILL RETURN (scripted) ===',
    ...Object.entries(results).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v, null, 1)}`),
    'Any other tool call succeeds.',
    '',
    'Reply with a single JSON object and nothing else:',
    '{"tool_calls": [{"tool": "<tool name>", "args": {...}}], "message": "<the text the developer reads, in order, or an empty string>"}',
    s.hook === 'checkpoint'
      ? 'List every call you make from now, in order, with the real arguments you would pass, up to and including the first call that continues the task; stop there. "message" is the text the developer reads before that call.'
      : 'List every call you make from now until your turn ends, in order, with the real arguments you would pass.',
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
  const only = flag('scenarios') ? new Set(String(flag('scenarios')).split(',')) : null;
  const model = flag('model');
  const out = path.resolve(flag('out') ?? fs.mkdtempSync(path.join(os.tmpdir(), `eklavya-hook-text-${label}-`)));
  fs.mkdirSync(out, { recursive: true });
  const fx = fixtures();
  let jobs = fx.scenarios.filter((s) => !only || only.has(s.id)).flatMap((s) => Array.from({ length: trials }, (_, t) => ({ s, t })));
  if (flag('limit')) jobs = jobs.slice(0, Number(flag('limit')));
  const started = Date.now() / 1000;
  let done = 0;
  process.stdout.write(`${jobs.length} calls, root ${root}, out ${out}\n`);
  progress(out, { label, state: 'running', trials_done: 0, trials_total: jobs.length, started });
  await pool(jobs, Number(flag('parallel', 4)), async ({ s, t }) => {
    const prompt = await buildPrompt(root, fx, s);
    let record;
    try {
      record = { scenario: s.id, trial: t, reply: await ask(prompt, model) };
    } catch (err) {
      record = { scenario: s.id, trial: t, error: String(err.message ?? err) };
    }
    fs.writeFileSync(path.join(out, `${s.id}.${t}.json`), JSON.stringify(record, null, 1));
    done += 1;
    progress(out, { label, state: 'running', trials_done: done, trials_total: jobs.length, started, calls: usage.summary().calls, tokens: usage.summary() });
    process.stdout.write(`  ${s.id} #${t} ${record.error ? `ERROR ${record.error}` : 'ok'}\n`);
  });
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ label, root, trials, model: model ?? 'default', at: new Date().toISOString(), usage: usage.summary() }, null, 1));
  progress(out, { label, state: 'done', trials_done: done, trials_total: jobs.length, started, tokens: usage.summary() });
  process.stdout.write(`${usage.line()}\n`);
  await score(out);
}

async function score(dir) {
  const { extractJson } = await load(repoRoot, 'eval/extract-json.js');
  const { checkTurn, summarise } = await load(repoRoot, 'eval/conversation-score.js');
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

async function show(id) {
  const fx = fixtures();
  const s = fx.scenarios.find((x) => x.id === id) ?? fail(`no scenario ${id}`);
  process.stdout.write(`${await buildPrompt(path.resolve(flag('root', repoRoot)), fx, s)}\n`);
}

const cmd = positionals()[0];
if (cmd === 'run') await run();
else if (cmd === 'score' && positionals()[1]) await score(path.resolve(positionals()[1]));
else if (cmd === 'show' && positionals()[1]) await show(positionals()[1]);
else fail('usage: hook-text-harness.mjs run [--root <checkout>] [--label l] [--trials n] [--parallel n] [--scenarios a,b] [--limit n] [--model m] [--out dir] | score <run-dir> | show <scenario> [--root <checkout>]');
