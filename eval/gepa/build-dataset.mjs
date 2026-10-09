#!/usr/bin/env node
/**
 * Builds the pilot's dataset from the real planner.
 *
 *   node eval/gepa/build-dataset.mjs            # writes eval/gepa/dataset.json
 *
 * Every example is genuine `get_session_quiz_plan` output for a fixture
 * concept, under one focus and difficulty setting, so `tier_to_ask`,
 * `framing`, `level_framing` and `answer_position` are what the product would
 * hand the tutor. Fixtures are the anonymised ones in `eval/gepa/fixtures/` plus
 * the question eval's own (`eval/fixtures/*.json`, this repository's code). No
 * learner database is read.
 *
 * Splits are by fixture, not by example: the same code appears under six
 * settings, and those near-duplicates must land on one side of the boundary or
 * the test set would leak. The assignment is a hash of the fixture id, so it
 * does not move when a fixture is added elsewhere.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const dist = (rel) => import(pathToFileURL(path.join(repoRoot, 'mcp', 'dist', rel)).href);

const SETTINGS = [
  ['project', 'easy'],
  ['project', 'hard'],
  ['concept', 'easy'],
  ['concept', 'medium'],
  ['concept', 'hard'],
  ['project', 'medium'],
];
/** Fractions of fixtures, by hash rank. */
const SPLIT = [['train', 0.5], ['val', 0.2], ['test', 0.3]];

function readFixtures() {
  const dirs = [path.join(here, 'fixtures'), path.join(repoRoot, 'eval', 'fixtures')];
  return dirs
    .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => path.join(d, f)))
    .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
    .filter((f) => f.id && Array.isArray(f.concepts));
}

export function assignSplits(ids) {
  const ranked = [...ids].sort((a, b) => hash(a).localeCompare(hash(b)));
  const out = {};
  let i = 0;
  for (const [name, frac] of SPLIT) {
    const n = name === 'test' ? ranked.length - i : Math.round(ranked.length * frac);
    for (const id of ranked.slice(i, i + n)) out[id] = name;
    i += n;
  }
  return out;
}
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');

async function planFor(fixtures, focus, difficulty) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-gepa-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-gepa-repo-'));
  process.env.EKLAVYA_HOME = home;
  delete process.env.EKLAVYA_SESSION_ID;
  // `max_new_concepts_per_session` is raised: past its default every further
  // concept is rejected by `upsert_concepts` and then created bare by the log
  // call, so half the plan items would arrive without a description.
  // User-level config: a repository's own `.eklavya.json` is untrusted and
  // ignored for these keys, which would leave every setting at its default.
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ focus, difficulty, cadence: 'end', min_minutes_between_quizzes: 0, max_questions_per_task: 60, max_new_concepts_per_session: 100, quiz: { enabled: true } }),
  );
  const { openDb } = await dist('db.js');
  const { upsertConcepts } = await dist('tools/upsert_concepts.js');
  const { logSessionConcepts } = await dist('tools/log_session_concepts.js');
  const { getSessionQuizPlan } = await dist('tools/get_session_quiz_plan.js');
  const db = openDb(path.join(home, 'knowledge.db'));
  const ctx = { db };
  const all = fixtures.flatMap((f) => f.concepts.map((c) => ({ f, c })));
  upsertConcepts.handler(
    { cwd, concepts: all.map(({ c }) => ({ slug: c.slug, name: c.slug.replace(/-/g, ' '), domain: c.domain, tier: c.tier, description: c.description, prerequisite_of: c.prerequisite_of ?? [] })) },
    ctx,
  );
  logSessionConcepts.handler({ cwd, concepts: all.map(({ c }) => ({ slug: c.slug, context: c.context })) }, ctx);
  const plan = getSessionQuizPlan.handler({ cwd, max: 60, ignore_cooldown: true }, ctx);
  const owner = new Map(all.map(({ f, c }) => [c.slug, f]));
  // Widening and review items name seeded concepts no fixture owns; they carry no
  // code to write a question about, so they are not examples.
  const items = (plan.concepts ?? []).filter((item) => owner.has(item.slug)).map((item) => ({
    group: owner.get(item.slug)?.id,
    focus,
    difficulty,
    code: item.context != null ? owner.get(item.slug)?.diff ?? null : null,
    source: item.context != null ? owner.get(item.slug)?.source ?? null : null,
    plan: {
      slug: item.slug,
      description: item.description,
      context: item.context ?? null,
      tier_to_ask: item.tier_to_ask,
      answer_position: item.answer_position,
      framing: plan.framing ?? null,
      level: plan.level ?? null,
      level_framing: plan.level_framing ?? null,
      asked_before: item.asked_before ?? [],
    },
  }));
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  return items;
}

async function main() {
  const fixtures = readFixtures();
  const splits = assignSplits(fixtures.map((f) => f.id));
  const examples = [];
  for (const [focus, difficulty] of SETTINGS) {
    for (const it of await planFor(fixtures, focus, difficulty)) {
      examples.push({ id: `${it.group}:${it.plan.slug}:${focus}:${difficulty}`, split: splits[it.group], ...it });
    }
  }
  const counts = Object.fromEntries(SPLIT.map(([n]) => [n, examples.filter((e) => e.split === n).length]));
  const out = {
    version: 1,
    built_from: 'real get_session_quiz_plan output; fixtures are anonymised or this repository\'s own code; no learner data',
    settings: SETTINGS,
    split_by: 'fixture id (hash-ranked); near-duplicates share a side',
    fixtures: Object.fromEntries(fixtures.map((f) => [f.id, splits[f.id]])),
    counts,
    examples,
  };
  fs.writeFileSync(path.join(here, 'dataset.json'), JSON.stringify(out, null, 1));
  process.stdout.write(`${examples.length} examples from ${fixtures.length} fixtures: ${JSON.stringify(counts)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
