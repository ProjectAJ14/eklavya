#!/usr/bin/env node
/**
 * The question-quality eval.
 *
 * Eklavya's claim is that the developer learns. 445 tests next door check the
 * machinery -- SM-2, plan sizing, gate arithmetic, migrations -- and none of
 * them check the product, which is a question. This measures the question.
 *
 * Four stages, each writing its output so any one can be re-run or inspected
 * on its own:
 *
 *   plan      real planner, real config, throwaway database -> plan.json
 *   generate  a model writes a question per plan item        -> questions.json
 *   score     deterministic checks, no model, free           -> score.json
 *   judge     a model reads each question                    -> judge.json
 *
 * `plan` drives the actual `get_session_quiz_plan` handler against a temporary
 * home rather than inventing plan items, and that is the point: `tier_to_ask`,
 * `framing`, `level_framing` and `answer_position` are all server-side
 * decisions, so a harness that mocked them would grade the model on a plan the
 * product never produces. It also means this eval covers the planner.
 *
 *   node eval/harness.mjs plan --focus project --difficulty hard
 *   node eval/harness.mjs score <run-dir>
 *   node eval/harness.mjs run --limit 3          # all four stages
 *
 * Nothing here runs in CI. `score` is free and deterministic, but `generate`
 * and `judge` each cost a model call per question, so they are opt-in by
 * design. See eval/README.md for the method and for what would disprove it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(evalDir);
const dist = path.join(repoRoot, 'mcp', 'dist');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function flag(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? true) : dflt;
}

const fixtures = () =>
  fs
    .readdirSync(path.join(evalDir, 'fixtures'))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(evalDir, 'fixtures', f), 'utf8')));

/* ------------------------------------------------------------------ plan --- */

/**
 * A throwaway home, a throwaway repo, and a repo config the real loader reads.
 *
 * The config goes through `.eklavya.json` rather than being passed in, so the
 * run exercises the same merge order a developer's machine does -- and so a
 * result file can record the config as the product would have resolved it.
 */
async function plan() {
  const focus = flag('focus', 'project');
  const difficulty = flag('difficulty', 'hard');
  const limit = Number(flag('limit', 12));

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-eval-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-eval-repo-'));
  process.env.EKLAVYA_HOME = home;
  delete process.env.EKLAVYA_SESSION_ID;

  fs.writeFileSync(
    path.join(cwd, '.eklavya.json'),
    JSON.stringify(
      {
        mode: 'ambient',
        focus,
        difficulty,
        cadence: 'end',
        min_minutes_between_quizzes: 0,
        max_questions_per_task: limit,
      },
      null,
      2,
    ),
  );

  const { openDb } = await import(path.join(dist, 'db.js'));
  const { logSessionConcepts } = await import(path.join(dist, 'tools/log_session_concepts.js'));
  const { upsertConcepts } = await import(path.join(dist, 'tools/upsert_concepts.js'));
  const { getSessionQuizPlan } = await import(path.join(dist, 'tools/get_session_quiz_plan.js'));

  const db = openDb(path.join(home, 'knowledge.db'));
  const ctx = { db };
  const all = fixtures();

  // Real concepts first, so the plan sees an honest tier and domain rather than
  // the bare tier-2 placeholder a bare log would create.
  upsertConcepts.handler(
    {
      cwd,
      concepts: all.flatMap((f) =>
        f.concepts.map((c) => ({
          slug: c.slug,
          name: c.slug.replace(/-/g, ' '),
          domain: c.domain,
          tier: c.tier,
          description: c.description,
          prerequisite_of: c.prerequisite_of ?? [],
        })),
      ),
    },
    ctx,
  );

  logSessionConcepts.handler(
    {
      cwd,
      concepts: all.flatMap((f) => f.concepts.map((c) => ({ slug: c.slug, context: c.context }))),
    },
    ctx,
  );

  const result = getSessionQuizPlan.handler({ cwd, max: limit, ignore_cooldown: true }, ctx);
  const bySlug = new Map(all.flatMap((f) => f.concepts.map((c) => [c.slug, f])));

  const items = (result.concepts ?? []).map((item) => ({
    ...item,
    fixture: bySlug.get(item.slug)?.id ?? null,
    diff: bySlug.get(item.slug)?.diff ?? null,
    source: bySlug.get(item.slug)?.source ?? null,
  }));

  const run = path.join(evalDir, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(run, { recursive: true });
  write(run, 'plan.json', {
    generated_at: new Date().toISOString(),
    config: { focus, difficulty, limit },
    questions_needed: result.questions_needed,
    reason: result.reason ?? null,
    level: result.level ?? null,
    level_framing: result.level_framing ?? null,
    framing: result.framing ?? null,
    items,
  });

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });

  process.stdout.write(`${run}\n`);
  process.stdout.write(`planned ${items.length} question(s), focus=${focus} difficulty=${difficulty}\n`);
  for (const i of items) process.stdout.write(`  tier ${i.tier_to_ask} slot ${i.answer_position}  ${i.slug}\n`);
  return run;
}

/* -------------------------------------------------------------- generate --- */

/**
 * The skill text the model is actually given.
 *
 * Read from `skills/tutor/` rather than restated here, so the eval measures
 * the shipped pedagogy. If the skill is edited, the next run reflects it --
 * that is the whole reason the eval is worth having.
 */
function pedagogy() {
  const tutor = path.join(repoRoot, 'skills', 'tutor');
  const strip = (f) => fs.readFileSync(f, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  return [strip(path.join(tutor, 'SKILL.md')), strip(path.join(tutor, 'references', 'writing-mcq.md'))].join(
    '\n\n',
  );
}

/** One model call. Returns the raw text, or throws with the stderr attached. */
function ask(prompt, model) {
  const args = ['-p', prompt];
  if (model) args.push('--model', model);
  const res = spawnSync('claude', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (res.error) throw new Error(`claude not runnable: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`claude exited ${res.status}: ${(res.stderr || '').slice(0, 400)}`);
  return res.stdout ?? '';
}

/**
 * The last balanced JSON object in the text.
 *
 * Last rather than first, and balanced rather than greedy: a model asked for
 * JSON often narrates first, and a question's own options can contain braces.
 */
export function extractJson(text) {
  for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function generate(run, model) {
  const plan = read(run, 'plan.json');
  const skill = pedagogy();
  const questions = [];
  const failures = [];

  for (const item of plan.items) {
    const prompt = [
      'You are the Eklavya tutor. Follow the pedagogy below exactly.',
      '',
      '=== PEDAGOGY (the shipped skill) ===',
      skill,
      '',
      '=== THE CODE THE DEVELOPER JUST WATCHED YOU WRITE ===',
      `File: ${item.source}`,
      '```ts',
      item.diff,
      '```',
      '',
      '=== THE PLAN ITEM (authoritative) ===',
      JSON.stringify(
        {
          slug: item.slug,
          description: item.description,
          context: item.context ?? null,
          tier_to_ask: item.tier_to_ask,
          answer_position: item.answer_position,
          framing: plan.framing,
          level: plan.level,
          level_framing: plan.level_framing,
          asked_before: item.asked_before ?? [],
        },
        null,
        2,
      ),
      '',
      'Write ONE multiple-choice question for this plan item.',
      'Reply with a single JSON object and nothing else:',
      '{"stem": "...", "options": ["...","...","...","..."], "correct": <1-4>}',
      '`correct` is the 1-based index of the correct option as you ordered them.',
    ].join('\n');

    let parsed = null;
    try {
      parsed = extractJson(ask(prompt, model));
    } catch (err) {
      failures.push({ slug: item.slug, error: String(err.message ?? err) });
      continue;
    }
    if (!parsed?.stem || !Array.isArray(parsed.options)) {
      failures.push({ slug: item.slug, error: 'no parsable question in the reply' });
      continue;
    }

    questions.push({
      fixture: item.fixture,
      slug: item.slug,
      tier_to_ask: item.tier_to_ask,
      answer_position: item.answer_position,
      stem: String(parsed.stem),
      options: parsed.options.map(String),
      correct: Number(parsed.correct),
    });
    process.stdout.write(`  generated ${item.slug}\n`);
  }

  write(run, 'questions.json', { model: model ?? 'default', generated: questions.length, failures, questions });
  if (failures.length > 0) process.stdout.write(`  ${failures.length} generation failure(s)\n`);
  return questions;
}

/* ----------------------------------------------------------------- score --- */

async function score(run) {
  const { scoreAll } = await import(path.join(dist, 'eval/question-checks.js'));
  const { questions } = read(run, 'questions.json');
  const { scored, summary } = scoreAll(questions);
  write(run, 'score.json', { summary, scored });

  process.stdout.write(`\n${summary.clean}/${summary.questions} questions passed every check\n`);
  for (const [id, row] of Object.entries(summary.byCheck)) {
    const mark = row.failed === 0 ? 'ok  ' : 'FAIL';
    process.stdout.write(`  ${mark} ${id.padEnd(22)} ${row.passed}/${row.passed + row.failed}\n`);
  }
  process.stdout.write(`  answer landed in slot 1/2/3/4: ${summary.slots.join(' / ')}  (expect ~even)\n`);
  const pct = summary.questions > 0 ? Math.round((100 * summary.correctLongest) / summary.questions) : 0;
  process.stdout.write(
    `  correct option was the longest: ${summary.correctLongest}/${summary.questions} (${pct}%, chance is 25%)\n`,
  );
  for (const s of scored) {
    for (const c of s.checks.filter((c) => !c.ok)) {
      process.stdout.write(`\n  ${s.question.slug}: ${c.id} -- ${c.detail}\n    ${s.question.stem}\n`);
    }
  }
  return summary;
}

/* ----------------------------------------------------------------- judge --- */

/**
 * The three questions counting cannot answer.
 *
 * Kept to three on purpose. Every criterion handed to a judge is a criterion
 * whose verdict moves between runs, so anything decidable by `score` is
 * decided there instead. The judge is also told to give a reason, because a
 * bare verdict from a model is not evidence of anything.
 */
function judge(run, model) {
  const { questions } = read(run, 'questions.json');
  const plan = read(run, 'plan.json');
  const byslug = new Map(plan.items.map((i) => [i.slug, i]));
  const verdicts = [];

  for (const q of questions) {
    const item = byslug.get(q.slug) ?? {};
    const prompt = [
      'You are auditing one multiple-choice question written for a developer who watched an agent write the code below. Be strict and answer only with JSON.',
      '',
      `Concept: ${q.slug} -- ${item.description ?? ''}`,
      `Tier asked for: ${q.tier_to_ask} (1 recall, 2 mechanism, 3 judgement, 4 failure modes, 5 design)`,
      '',
      'Code:',
      '```ts',
      item.diff ?? '(withheld: this focus deliberately hides the code)',
      '```',
      '',
      `Question: ${q.stem}`,
      ...q.options.map((o, i) => `  ${i + 1}. ${o}${i + 1 === q.correct ? '   <- marked correct' : ''}`),
      '',
      'Answer with exactly this JSON:',
      '{"answerable": true|false, "answerable_why": "...",',
      ' "correct_is_correct": true|false, "correct_why": "...",',
      ' "plausible_distractors": <0-3>, "distractors_why": "...",',
      ' "tier_match": "below"|"match"|"above", "tier_why": "...",',
      ' "one_idea": true|false}',
      '',
      '"answerable": could someone who understands the concept answer from what is shown.',
      '"correct_is_correct": is the option marked correct actually the right answer.',
      '"plausible_distractors": how many of the three wrong options a competent person could believe.',
    ].join('\n');

    let parsed = null;
    try {
      parsed = extractJson(ask(prompt, model));
    } catch (err) {
      verdicts.push({ slug: q.slug, error: String(err.message ?? err) });
      continue;
    }
    verdicts.push({ slug: q.slug, ...(parsed ?? { error: 'unparsable verdict' }) });
    process.stdout.write(`  judged ${q.slug}\n`);
  }

  const graded = verdicts.filter((v) => !v.error);
  const summary = {
    judged: graded.length,
    errors: verdicts.length - graded.length,
    answerable: graded.filter((v) => v.answerable).length,
    correct_is_correct: graded.filter((v) => v.correct_is_correct).length,
    one_idea: graded.filter((v) => v.one_idea).length,
    tier: {
      below: graded.filter((v) => v.tier_match === 'below').length,
      match: graded.filter((v) => v.tier_match === 'match').length,
      above: graded.filter((v) => v.tier_match === 'above').length,
    },
    distractors_total: graded.reduce((n, v) => n + (Number(v.plausible_distractors) || 0), 0),
    distractors_possible: graded.length * 3,
  };

  write(run, 'judge.json', { model: model ?? 'default', summary, verdicts });
  process.stdout.write(
    `\njudge: ${summary.answerable}/${summary.judged} answerable, ` +
      `${summary.correct_is_correct}/${summary.judged} keyed right, ` +
      `${summary.distractors_total}/${summary.distractors_possible} plausible distractors, ` +
      `tier ${summary.tier.match} match / ${summary.tier.below} below / ${summary.tier.above} above\n`,
  );
  return summary;
}

/* ------------------------------------------------------------------- io --- */

const write = (run, name, data) =>
  fs.writeFileSync(path.join(run, name), `${JSON.stringify(data, null, 2)}\n`);
const read = (run, name) => JSON.parse(fs.readFileSync(path.join(run, name), 'utf8'));

const [command, maybeRun] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const model = flag('model');

switch (command) {
  case 'plan':
    await plan();
    break;
  case 'generate':
    generate(maybeRun ?? fail('usage: harness.mjs generate <run-dir>'), model);
    break;
  case 'score':
    await score(maybeRun ?? fail('usage: harness.mjs score <run-dir>'));
    break;
  case 'judge':
    judge(maybeRun ?? fail('usage: harness.mjs judge <run-dir>'), model);
    break;
  case 'run': {
    const run = await plan();
    generate(run, model);
    await score(run);
    judge(run, model);
    process.stdout.write(`\nrun written to ${path.relative(repoRoot, run)}\n`);
    break;
  }
  default:
    fail('usage: harness.mjs plan|generate|score|judge|run [<run-dir>] [--focus f] [--difficulty d] [--limit n] [--model m]');
}
