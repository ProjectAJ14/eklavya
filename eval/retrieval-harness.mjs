#!/usr/bin/env node
/**
 * The retrieval eval.
 *
 * The question eval next door measures whether a question is good. This
 * measures whether the evidence handed to the model was the right evidence --
 * the other half of the product, and the half a savings percentage cannot see.
 * Omitting useful history looks like an excellent saving (PRD MET-01), so
 * recall is reported beside precision and neither is blended away.
 *
 * Unlike the question eval this one costs nothing and is deterministic: no
 * model call anywhere, a fixed synthetic corpus, and a scorer that is pure
 * arithmetic (`mcp/src/eval/retrieval-score.ts`). It can be run on every change
 * to `mcp/src/memory/search.ts` or to the embedder.
 *
 *   node eval/retrieval-harness.mjs               # all three modes, print a table
 *   node eval/retrieval-harness.mjs --k 3         # at a tighter budget
 *   node eval/retrieval-harness.mjs --json        # machine-readable, for a results file
 *   node eval/retrieval-harness.mjs --split dev   # while changing the retriever
 *
 * What would disprove the claim it supports: `ADR-03` says the local embedder
 * generalises over morphology and typos but NOT over synonymy. The fixture
 * contains queries of each kind, and the ones beyond the documented ceiling are
 * labelled `expectedMiss` -- if hybrid ever starts finding one, the ADR's honest
 * ceiling has moved and the manual should say so.
 *
 * Only two things fail the build, because on a corpus built to be hard most
 * misses are a measurement rather than a defect:
 *
 *   - `mustFind` -- a query the product's own documentation guarantees (an exact
 *     term, the ADR-03 morphology claim, a scope filter that is a SQL clause).
 *   - `noLeak` -- a query whose `forbidden` entries are excluded by SQL, not by
 *     ranking: another project's rows, a superseded correction, a row outside a
 *     date window. One of those in the results means a filter was not applied.
 *
 * Everything else is reported: per category, per split, and as a leak rate for
 * the adversarial pairs, where a stale row outranking its correction is the
 * finding rather than the failure.
 *
 * The `heldout` split was assigned before the first run against this corpus and
 * is not revised after reading its numbers. Nothing stops a reader looking at
 * it -- the split is a discipline, not an enforcement -- but a gain that shows
 * on `dev` and not on `heldout` is noise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(evalDir);
const dist = path.join(repoRoot, 'mcp', 'dist');

function need(rel) {
  const file = path.join(dist, rel);
  if (!fs.existsSync(file)) {
    console.error(`Missing ${file}. Run \`npm run build\` in mcp/ first.`);
    process.exit(1);
  }
  return pathToFileURL(file).href;
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const K = Number(flag('k', 5));
const asJson = args.includes('--json');
const SPLIT = flag('split', 'all');

const { openDb } = await import(need('db.js'));
const { insertEntry, supersedeEntry } = await import(need('memory/store.js'));
const { search } = await import(need('memory/search.js'));
const { scoreQuery, summarise, compare } = await import(need('eval/retrieval-score.js'));

const fixture = JSON.parse(
  fs.readFileSync(path.join(evalDir, 'fixtures', 'retrieval-corpus.json'), 'utf8'),
);

// A throwaway database, never the learner's. The corpus is invented; nothing
// here reads a real memory.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-retrieval-eval-'));
const dbFile = path.join(home, 'knowledge.db');
const db = openDb(dbFile);

/** Fixture id -> the row id the store assigned, so labels stay stable. */
const idMap = new Map();
for (const entry of fixture.entries) {
  const rowId = insertEntry(db, {
    project: fixture.projects[entry.project],
    title: entry.title,
    narrative: entry.narrative,
    facts: entry.facts ?? [],
    files: entry.files ?? [],
    tags: entry.tags ?? [],
    type: entry.type,
    occurredAt: entry.occurredAt,
  });
  idMap.set(entry.id, rowId);
}

// Corrections supersede rather than overwrite (PRD MEM-03), and search excludes
// the superseded row in SQL. The adversarial half of the corpus depends on the
// difference: a pair linked here should never leak, and an unlinked pair that
// contradicts itself has nothing but ranking to save it.
for (const entry of fixture.entries) {
  if (entry.supersededBy) supersedeEntry(db, idMap.get(entry.id), idMap.get(entry.supersededBy));
}

const queries = fixture.queries.filter((q) => SPLIT === 'all' || (q.split ?? 'dev') === SPLIT);
if (!queries.length) {
  console.error(`No queries in split "${SPLIT}".`);
  process.exit(1);
}

const MODES = ['keyword', 'semantic', 'hybrid'];
const runs = {};

for (const mode of MODES) {
  const scores = [];
  for (const query of queries) {
    const hits = search(db, query.text, mode, {
      project: fixture.projects[query.project],
      limit: K,
      ...(query.filter ?? {}),
    });
    const ranked = hits.map((h) => h.entry.id);
    const relevant = query.relevant.map((id) => idMap.get(id));
    // Entries that are wrong for this query and tempting anyway: another
    // project's row, a stale claim, a row outside the date window. Counting
    // them is the only way this eval sees the failure a precision average hides.
    const forbidden = new Set((query.forbidden ?? []).map((id) => idMap.get(id)));
    const leaked = ranked.slice(0, K).filter((id) => forbidden.has(id));
    scores.push({
      ...scoreQuery(ranked, relevant, K),
      query: query.id,
      category: query.category ?? 'uncategorised',
      split: query.split ?? 'dev',
      forbidden: forbidden.size,
      leaked: leaked.length,
    });
  }
  runs[mode] = { mode, scores, summary: summarise(scores, K) };
}

/** Summaries for one slice of the run, so an aggregate cannot hide a broken slice. */
function slice(scores, key) {
  const groups = {};
  for (const score of scores) (groups[score[key]] ??= []).push(score);
  return Object.fromEntries(
    Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, group]) => [
        name,
        {
          ...summarise(group, K),
          forbidden_queries: group.filter((s) => s.forbidden).length,
          leaked_queries: group.filter((s) => s.leaked).length,
        },
      ]),
  );
}

db.close();
fs.rmSync(home, { recursive: true, force: true });

// The ceiling check. `expectedMiss` queries are the ones ADR-03 says the local
// embedder cannot do; finding one is not a failure, it is news.
//
// "Found" here means top-1, not present in the slate. Semantic search keeps
// anything above a cosine of 0.05, so in a project holding eight entries the
// slate is filled almost regardless of the query and "it came back fourth of
// five" is evidence about the project's size, not about the embedder bridging
// meaning. The weaker reading is reported too, under `expected_miss_in_slate`,
// because a criterion that quietly got stricter is a criterion nobody can audit.
const byId = new Map(runs.hybrid.scores.map((s) => [s.query, s]));
const expectedMisses = queries.filter((q) => q.expectedMiss).map((q) => q.id);
const surprises = expectedMisses.filter((id) => byId.get(id).top1 === 1);
const inSlate = expectedMisses.filter((id) => byId.get(id).hits > 0);

// A regression is a broken guarantee, not a hard query. Missing a `mustFind`
// query means a documented capability stopped working; leaking a `noLeak`
// entry means a filter that is a SQL clause was not applied.
const missedGuarantees = queries
  .filter((q) => q.mustFind && byId.get(q.id).hits === 0)
  .map((q) => q.id);
const filterLeaks = queries.filter((q) => q.noLeak && byId.get(q.id).leaked > 0).map((q) => q.id);
const regressions = [...missedGuarantees, ...filterLeaks];

const report = {
  generated_at: new Date().toISOString(),
  k: K,
  split: SPLIT,
  corpus: {
    entries: fixture.entries.length,
    queries: queries.length,
    queries_total: fixture.queries.length,
    projects: Object.keys(fixture.projects).length,
  },
  modes: Object.fromEntries(MODES.map((m) => [m, runs[m].summary])),
  by_category: Object.fromEntries(MODES.map((m) => [m, slice(runs[m].scores, 'category')])),
  by_split: Object.fromEntries(MODES.map((m) => [m, slice(runs[m].scores, 'split')])),
  keyword_vs_hybrid: compare(runs.keyword, runs.hybrid),
  expected_misses: expectedMisses,
  unexpected_hits: surprises,
  expected_miss_in_slate: inSlate,
  missed_guarantees: missedGuarantees,
  filter_leaks: filterLeaks,
  regressions,
  per_query: Object.fromEntries(MODES.map((m) => [m, runs[m].scores])),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pad = (v, w) => String(v).padEnd(w);
  console.log(
    `\nRetrieval eval — ${fixture.entries.length} entries, ${queries.length} queries` +
      `${SPLIT === 'all' ? '' : ` (${SPLIT} split)`}, k=${K}\n`,
  );
  console.log('mode      top-1   recall  mrr     prec@k  missed');
  for (const mode of MODES) {
    const s = runs[mode].summary;
    console.log(
      `${pad(mode, 10)}${pad(s.top1, 8)}${pad(s.recall, 8)}${pad(s.mrr, 8)}${pad(s.precision, 8)}${s.misses.length}`,
    );
  }

  // The per-slice table the plan asks for: an aggregate that hides a broken
  // category is the failure this eval exists to make impossible.
  console.log('\ncategory        n   kw@1  sem@1 hyb@1 hyb-rec  leak');
  for (const [name, s] of Object.entries(report.by_category.hybrid)) {
    const kw = report.by_category.keyword[name];
    const sem = report.by_category.semantic[name];
    const leak = s.forbidden_queries ? `${s.leaked_queries}/${s.forbidden_queries}` : '-';
    console.log(
      `${pad(name, 16)}${pad(s.queries, 4)}${pad(kw.top1, 6)}${pad(sem.top1, 6)}${pad(s.top1, 6)}${pad(s.recall, 9)}${leak}`,
    );
  }

  if (SPLIT === 'all') {
    console.log('\nsplit           n   hyb@1 hyb-rec');
    for (const [name, s] of Object.entries(report.by_split.hybrid)) {
      console.log(`${pad(name, 16)}${pad(s.queries, 4)}${pad(s.top1, 6)}${s.recall}`);
    }
  }
  const cmp = report.keyword_vs_hybrid;
  console.log(
    `\nhybrid vs keyword: top-1 ${cmp.top1Delta >= 0 ? '+' : ''}${cmp.top1Delta}, recall ${cmp.recallDelta >= 0 ? '+' : ''}${cmp.recallDelta}` +
      (cmp.better ? ` — ${cmp.better} wins` : ' — no clear winner'),
  );
  console.log(
    'prec@k is mostly slate size: on the queries with one right answer a mode that always returns k scores 1/k.',
  );
  if (missedGuarantees.length) {
    console.log(
      `\nREGRESSION: hybrid misses ${missedGuarantees.join(', ')}, which the product documents as guaranteed.`,
    );
  }
  if (filterLeaks.length) {
    console.log(
      `\nREGRESSION: hybrid returned an entry a SQL filter should have excluded, on ${filterLeaks.join(', ')}.`,
    );
  }
  if (surprises.length) {
    console.log(`\nNEWS: hybrid now answers ${surprises.join(', ')}, which ADR-03 says it cannot. Re-read the ADR.`);
  }
  if (inSlate.length) {
    console.log(
      `\nnote: ${inSlate.join(', ')} appeared somewhere in the slate without being the answer. In a small project scope that is slate size, not comprehension.`,
    );
  }
  console.log('');
}

// Non-zero only on a real regression: a surprise is news, not a failure.
process.exit(regressions.length ? 1 : 0);
