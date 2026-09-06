#!/usr/bin/env node
/**
 * The question-quality eval.
 *
 * Eklavya's claim is that the developer learns. 426 tests next door check the
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(evalDir);
const dist = path.join(repoRoot, 'mcp', 'dist');

/**
 * `import()` of a bare absolute path throws ERR_UNSUPPORTED_ESM_URL_SCHEME on
 * Windows, and this repo takes cross-platform seriously enough to have one
 * hooks/run.mjs for all of them.
 */
const fromDist = (rel) => import(pathToFileURL(path.join(dist, rel)).href);

/** Everything the eval needs out of the built server, with one clear failure. */
async function loadDist(rel) {
  try {
    return await fromDist(rel);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      fail('mcp/dist is missing or stale. Run `npm run build` in mcp/ first.');
    }
    throw err;
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Flags that take a value, so the value is not mistaken for a positional. */
const VALUE_FLAGS = new Set(['focus', 'difficulty', 'limit', 'model', 'db']);

function flag(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  return VALUE_FLAGS.has(name) ? (process.argv[i + 1] ?? dflt) : true;
}

/**
 * Positional arguments, with flag values removed.
 *
 * `argv.filter(a => !a.startsWith('--'))` drops flag names and keeps their
 * values, so `score --model sonnet <run>` read the run directory as "sonnet"
 * and failed on sonnet/questions.json.
 */
function positionals() {
  const out = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      if (VALUE_FLAGS.has(arg.slice(2))) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
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

  const { openDb } = await loadDist('db.js');
  const { logSessionConcepts } = await loadDist('tools/log_session_concepts.js');
  const { upsertConcepts } = await loadDist('tools/upsert_concepts.js');
  const { getSessionQuizPlan } = await loadDist('tools/get_session_quiz_plan.js');

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
    // `concept` focus returns context: null on purpose -- the code is withheld
    // so the model reaches for the idea. The generator has to be shown exactly
    // what the product shows it, or a non-project focus is graded on a
    // generator that saw more than the real one would.
    code_shown: item.context != null,
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

  // Closed before the directory is removed: an open handle makes the rm fail
  // outright on Windows and leaves WAL sidecars behind everywhere else.
  db.close();
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
  const res = spawnSync('claude', args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    // A stage that can hang has no place in something meant to be run
    // unattended, and one wedged call would otherwise stall the whole run.
    timeout: Number(process.env.EKLAVYA_EVAL_TIMEOUT_MS ?? 180000),
  });
  if (res.error) throw new Error(`claude not runnable: ${res.error.message}`);
  if (res.signal) throw new Error(`claude timed out (${res.signal})`);
  if (res.status !== 0) throw new Error(`claude exited ${res.status}: ${(res.stderr || '').slice(0, 400)}`);
  return res.stdout ?? '';
}

async function generate(run, model) {
  const { extractJson } = await loadDist('eval/extract-json.js');
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
      ...(item.code_shown
        ? ['=== THE CODE THE DEVELOPER JUST WATCHED YOU WRITE ===', `File: ${item.source}`, '```ts', item.diff, '```', '']
        : [
            '=== THE CODE IS DELIBERATELY WITHHELD ===',
            'This focus returns context: null so the question reaches for the idea rather than the file.',
            '',
          ]),
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
  const { scoreAll } = await loadDist('eval/question-checks.js');
  const generated = read(run, 'questions.json');
  const { scored, summary } = scoreAll(generated.questions);

  // Carried through, and printed, because a run where nine of twelve items
  // produced nothing would otherwise report "3/3 passed every check" and a slot
  // histogram over three questions. Every rate here is out of what was
  // generated, not out of what was planned.
  const planned = read(run, 'plan.json').items.length;
  const failures = generated.failures?.length ?? 0;
  write(run, 'score.json', { summary, planned, generation_failures: failures, scored });

  if (failures > 0) {
    process.stdout.write(
      `\n${failures} of ${planned} planned item(s) produced no question -- every rate below is out of the ${summary.questions} that did\n`,
    );
  }
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
 * The five questions counting cannot answer.
 *
 * Kept to three on purpose. Every criterion handed to a judge is a criterion
 * whose verdict moves between runs, so anything decidable by `score` is
 * decided there instead. The judge is also told to give a reason, because a
 * bare verdict from a model is not evidence of anything.
 */
async function judge(run, model) {
  const { extractJson } = await loadDist('eval/extract-json.js');
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
      item.code_shown
        ? 'Code the question writer was shown:'
        : 'Code the question writer was NOT shown (this focus withholds it on purpose); it is here only so you can judge the concept:',
      '```ts',
      item.diff ?? '(no code for this fixture)',
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

/* ------------------------------------------------------------ extraction --- */

/**
 * Does `log_session_concepts` name the concepts a diff actually exercises?
 *
 * Upstream of everything else here. If extraction picks the wrong concepts,
 * every question after it is well-formed and about the wrong thing, and `score`
 * would call that run clean -- a good question about an irrelevant concept is
 * still a good question.
 *
 * Same shape as `generate`: the model gets the shipped skill and a diff, and
 * produces the call it would have made. No session, no hooks.
 *
 * The judge pass exists because of the denominator. An extracted slug matching
 * no label is either a false positive or a concept the labeller did not think
 * of, and scoring every unmatched slug as wrong would grade the model against
 * one person's reading of the diff. Only the unmatched ones are judged, and the
 * report gives precision both ways.
 */
async function extract(model) {
  const { extractJson } = await loadDist('eval/extract-json.js');
  const scorer = await loadDist('eval/extraction-score.js');

  const tutor = path.join(repoRoot, 'skills', 'tutor');
  const skill = fs.readFileSync(path.join(tutor, 'SKILL.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();

  const results = [];
  const shapes = [];
  const unlabelled = [];

  for (const fixture of fixtures()) {
    const prompt = [
      'You are the Eklavya tutor, working alongside a developer. Follow the pedagogy below.',
      '',
      '=== PEDAGOGY (the shipped skill) ===',
      skill,
      '',
      '=== THE CODE YOU JUST WROTE ===',
      `File: ${fixture.source}`,
      '```ts',
      fixture.diff,
      '```',
      '',
      'Produce the log_session_concepts call you would make for this work.',
      'Reply with a single JSON object and nothing else:',
      '{"concepts": [{"slug": "kebab-case", "context": "one line naming the real code"}]}',
    ].join('\n');

    let parsed = null;
    try {
      parsed = extractJson(ask(prompt, model));
    } catch (err) {
      process.stdout.write(`  ${fixture.id}: ${String(err.message ?? err)}\n`);
      continue;
    }
    const concepts = Array.isArray(parsed?.concepts) ? parsed.concepts : [];
    if (concepts.length === 0) {
      process.stdout.write(`  ${fixture.id}: no parsable concepts in the reply\n`);
      continue;
    }

    const labels = fixture.concepts.map((cpt) => cpt.slug);
    const result = scorer.scoreExtraction(fixture.id, labels, concepts);
    results.push(result);
    shapes.push({ fixture: fixture.id, checks: scorer.checkExtractionShape(concepts, fixture.diff) });
    for (const slug of result.unlabelled) unlabelled.push({ fixture: fixture.id, slug, diff: fixture.diff });
    process.stdout.write(
      `  ${fixture.id}: ${result.matched.length}/${labels.length} labels found, ${result.unlabelled.length} unlabelled\n`,
    );
  }

  if (results.length === 0) fail('No fixture produced a parsable extraction.');
  const summary = scorer.summarizeExtraction(results);

  // Semantic recall, because the strict number is not measuring extraction.
  //
  // The first run scored 0/8 recall while a judge called 15 of the 20 logged
  // concepts genuinely exercised. The labels are one person's phrasing, and
  // slug overlap cannot bridge ordinary naming variation: `wal-journal-mode`
  // against `sqlite-wal-mode` scores 0.50 on the product's own matcher, well
  // under its 0.8 threshold, and they are the same idea. So a missed label is
  // asked about directly -- did anything logged cover it -- one call per
  // fixture rather than per label.
  const coverage = [];
  for (const result of results.filter((r) => r.missed.length > 0)) {
    const logged = [...result.matched, ...result.unlabelled];
    const prompt = [
      'Answer only with JSON. Below are concept names a tool logged for a piece of code, and concepts a human labelled the same code with. For each labelled concept, say whether any logged concept covers the same idea, even under a different name.',
      '',
      `Logged: ${logged.join(', ')}`,
      '',
      'Labelled:',
      ...result.missed.map((m) => `  - ${m}`),
      '',
      'Answer: {"covered": ["<labelled concept>", ...], "why": "one sentence"}',
      'Include a labelled concept in "covered" only if a logged name means the same thing, not merely something adjacent.',
    ].join('\n');
    try {
      const v = extractJson(ask(prompt, model));
      const covered = Array.isArray(v?.covered) ? v.covered.filter((x) => result.missed.includes(x)) : [];
      coverage.push({ fixture: result.fixture, covered, why: v?.why ?? null });
    } catch (err) {
      coverage.push({ fixture: result.fixture, covered: [], error: String(err.message ?? err) });
    }
  }
  const coveredCount = coverage.reduce((n, c) => n + c.covered.length, 0);
  const semanticRecall = summary.labels > 0 ? (summary.matched + coveredCount) / summary.labels : 0;

  // Judge only the unmatched slugs. Each one is a single yes/no about whether
  // the diff genuinely exercises it, which is the cheapest useful judgement in
  // this whole directory.
  const verdicts = [];
  for (const item of unlabelled) {
    const prompt = [
      'Answer only with JSON. A tool logged a concept as being exercised by the code below. Is it?',
      '',
      '```ts',
      item.diff,
      '```',
      '',
      `Concept: ${item.slug}`,
      '',
      'Answer: {"exercised": true|false, "why": "one sentence"}',
      '"exercised" is true only if someone would learn something real about this concept by reading this code.',
    ].join('\n');
    try {
      const v = extractJson(ask(prompt, model));
      verdicts.push({ ...item, diff: undefined, exercised: Boolean(v?.exercised), why: v?.why ?? null });
    } catch (err) {
      verdicts.push({ ...item, diff: undefined, error: String(err.message ?? err) });
    }
  }

  const judgedReal = verdicts.filter((v) => v.exercised).length;
  const generous = summary.extracted > 0 ? (summary.matched + judgedReal) / summary.extracted : 0;

  const out = path.join(evalDir, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}-extraction.json`);
  fs.writeFileSync(
    out,
    `${JSON.stringify(
      { model: model ?? 'default', summary, semanticRecall, generousPrecision: generous, results, shapes, coverage, verdicts },
      null,
      2,
    )}\n`,
  );

  const pc = (n) => `${(100 * n).toFixed(0)}%`;
  process.stdout.write(`\n${summary.matched}/${summary.labels} labelled concepts matched by slug (strict recall ${pc(summary.recall)})\n`);
  process.stdout.write(
    `${summary.matched + coveredCount}/${summary.labels} covered once a judge allows a different name ` +
      `(semantic recall ${pc(semanticRecall)})\n`,
  );
  process.stdout.write(`${summary.matched}/${summary.extracted} logged concepts matched a label (precision ${pc(summary.precision)})\n`);
  process.stdout.write(
    `of the ${summary.unlabelled} unlabelled, a judge called ${judgedReal} genuinely exercised ` +
      `-- precision counting those as right: ${pc(generous)}\n`,
  );
  process.stdout.write(`\nshape checks\n`);
  for (const s of shapes) {
    for (const check of s.checks.filter((x) => !x.ok)) {
      process.stdout.write(`  FAIL ${s.fixture}: ${check.id} -- ${check.detail}\n`);
    }
  }
  process.stdout.write(`\nwritten to ${path.relative(repoRoot, out)}\n`);
  return summary;
}

/* --------------------------------------------------------------- history --- */

/**
 * What a real answer history says about the promises the product makes.
 *
 * Everything above measures questions before anyone answers them. This reads an
 * actual knowledge.db and asks whether the claims survived contact -- above all
 * the repeat rate, because *never the same question twice* is the promise the
 * whole tool rests on and it needs no new harness to check.
 *
 * Read-only, and aggregates only. The output file is committed, and the repo
 * rule is that a learner's data never is, so nothing here reads a stem into the
 * report -- the statistics module is handed the rows and hands back numbers.
 */
async function history(dbFile) {
  const stats = await loadDist('eval/history-stats.js');

  // Resolved from mcp/, not from here: node looks for node_modules relative to
  // the importing file, and eval/ has none. The driver is the server's
  // dependency, not the harness's.
  let Database;
  try {
    Database = createRequire(pathToFileURL(path.join(repoRoot, 'mcp', 'package.json')).href)('better-sqlite3');
  } catch {
    fail('better-sqlite3 could not be loaded. Run `npm ci` in mcp/.');
  }

  const file = dbFile ?? path.join(os.homedir(), '.eklavya', 'knowledge.db');
  if (!fs.existsSync(file)) fail(`No database at ${file}. Pass --db <path>.`);

  // Read-only on purpose: a measurement that can write to the thing it measures
  // is a measurement nobody should trust, and this one is pointed at a real
  // learner's history by default.
  const db = new Database(file, { readonly: true });
  const rows = db
    .prepare('SELECT id, concept_id, question, grade, difficulty, outcome, ts FROM attempts ORDER BY id')
    .all();
  const span = db.prepare('SELECT min(ts) AS first, max(ts) AS last FROM attempts').get();
  db.close();

  if (rows.length === 0) fail(`${file} has no attempts yet -- nothing to measure.`);

  const repeat = stats.repeatStats(rows);
  const tiers = stats.tierReadings(rows);
  const gaps = stats.gapStats(rows, 1);
  const outcomes = stats.outcomeStats(rows);
  const report = { source: path.basename(file), span, repeat, tiers, gaps, outcomes };

  const pct = (n, d) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
  process.stdout.write(`\n${repeat.attempts} attempts on ${repeat.concepts} concepts, ${span.first} -> ${span.last}\n`);
  process.stdout.write(
    `\nrepeat rate: ${repeat.repeats}/${repeat.repeatable} (${pct(repeat.repeats, repeat.repeatable)}) ` +
      `-- of the ${repeat.repeatable} attempt(s) that had an earlier question on the same concept\n`,
  );
  process.stdout.write(`  the planner had it in asked_before (a broken promise): ${repeat.plannerSaw}\n`);
  process.stdout.write(`  only the recorder saw it, and it does not reject:      ${repeat.recorderOnly}\n`);
  process.stdout.write(`  outside both windows:                                 ${repeat.outsideBoth}\n`);

  // Both readings, always. Choosing one and printing it alone is a judgement
  // call wearing a measurement's clothes -- on the first run it was the
  // difference between tier 2 sitting below the pass threshold and above it.
  for (const [label, t] of [
    ['all graded rows (unknown outcomes kept)', tiers.allGraded],
    ['known outcomes only', tiers.knownOutcome],
  ]) {
    process.stdout.write(`\n${label}\ntier   n   mean   pass\n`);
    for (const r of t.rows) {
      process.stdout.write(`  ${r.tier}  ${String(r.attempts).padStart(3)}   ${r.meanGrade.toFixed(2)}   ${pct(r.passRate, 1)}\n`);
    }
    process.stdout.write(`  grades fall as tiers rise: ${t.monotonic ? 'yes' : 'NO'}`);
    process.stdout.write(` (${t.excludedDeclines} decline(s), ${t.excludedUnknown} unknown-outcome row(s) excluded)\n`);
  }

  process.stdout.write(
    `\ngaps where something had been held: ${gaps.held}/${gaps.pairs} still passed ` +
      `(${gaps.skippedNoPriorPass} gap(s) skipped -- nothing had passed before them)\n`,
  );
  process.stdout.write(
    `outcomes: ${outcomes.answered} answered, ${outcomes.dontKnow} blank, ${outcomes.declined} declined, ${outcomes.unrecorded} unrecorded\n`,
  );

  // Timestamped, not just dated. The dated file is a published record; a second
  // run on the same day -- or a run against someone else's --db -- used to
  // overwrite it in place.
  const out = path.join(evalDir, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}-history.json`);
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nnumbers written to ${path.relative(repoRoot, out)}\n`);
  return report;
}

/* ------------------------------------------------------------------- io --- */

const write = (run, name, data) =>
  fs.writeFileSync(path.join(run, name), `${JSON.stringify(data, null, 2)}\n`);
const read = (run, name) => JSON.parse(fs.readFileSync(path.join(run, name), 'utf8'));

const [command, maybeRun] = positionals();
const model = flag('model');

switch (command) {
  case 'plan':
    await plan();
    break;
  case 'generate':
    await generate(maybeRun ?? fail('usage: harness.mjs generate <run-dir>'), model);
    break;
  case 'score':
    await score(maybeRun ?? fail('usage: harness.mjs score <run-dir>'));
    break;
  case 'judge':
    await judge(maybeRun ?? fail('usage: harness.mjs judge <run-dir>'), model);
    break;
  case 'history':
    await history(flag('db'));
    break;
  case 'extract':
    await extract(model);
    break;
  case 'run': {
    const run = await plan();
    await generate(run, model);
    await score(run);
    await judge(run, model);
    process.stdout.write(`\nrun written to ${path.relative(repoRoot, run)}\n`);
    break;
  }
  default:
    fail('usage: harness.mjs plan|generate|score|judge|run|extract|history [<run-dir>] [--focus f] [--difficulty d] [--limit n] [--model m] [--db path]');
}
