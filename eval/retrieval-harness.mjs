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
 *   node eval/retrieval-harness.mjs            # all three modes, print a table
 *   node eval/retrieval-harness.mjs --k 3      # at a tighter budget
 *   node eval/retrieval-harness.mjs --json     # machine-readable, for a results file
 *
 * What would disprove the claim it supports: `ADR-03` says the local embedder
 * generalises over morphology and typos but NOT over synonymy. The fixture
 * contains one query of each kind, and the synonym query is labelled
 * `expectedMiss` -- if hybrid ever starts finding it, the ADR's honest ceiling
 * has moved and the manual should say so. If the morphology queries start
 * missing, the embedder has regressed and the ADR's claim is no longer true.
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

const { openDb } = await import(need('db.js'));
const { insertEntry } = await import(need('memory/store.js'));
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
  });
  idMap.set(entry.id, rowId);
}

const MODES = ['keyword', 'semantic', 'hybrid'];
const runs = {};

for (const mode of MODES) {
  const scores = [];
  for (const query of fixture.queries) {
    const hits = search(db, query.text, mode, {
      project: fixture.projects[query.project],
      limit: K,
    });
    const ranked = hits.map((h) => h.entry.id);
    const relevant = query.relevant.map((id) => idMap.get(id));
    scores.push({ ...scoreQuery(ranked, relevant, K), query: query.id });
  }
  runs[mode] = { mode, scores, summary: summarise(scores, K) };
}

db.close();
fs.rmSync(home, { recursive: true, force: true });

// The ceiling check. `expectedMiss` queries are the ones ADR-03 says the local
// embedder cannot do; finding one is not a failure, it is news.
const expectedMisses = fixture.queries.filter((q) => q.expectedMiss).map((q) => q.id);
const surprises = expectedMisses.filter((id) => !runs.hybrid.summary.misses.includes(id));
const regressions = runs.hybrid.summary.misses.filter((id) => !expectedMisses.includes(id));

const report = {
  generated_at: new Date().toISOString(),
  k: K,
  corpus: { entries: fixture.entries.length, queries: fixture.queries.length },
  modes: Object.fromEntries(MODES.map((m) => [m, runs[m].summary])),
  keyword_vs_hybrid: compare(runs.keyword, runs.hybrid),
  expected_misses: expectedMisses,
  unexpected_hits: surprises,
  regressions,
  per_query: Object.fromEntries(MODES.map((m) => [m, runs[m].scores])),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\nRetrieval eval — ${fixture.entries.length} entries, ${fixture.queries.length} queries, k=${K}\n`);
  console.log('mode      top-1   recall  mrr    prec@k  misses');
  for (const mode of MODES) {
    const s = runs[mode].summary;
    console.log(
      `${mode.padEnd(10)}${String(s.top1).padEnd(8)}${String(s.recall).padEnd(8)}${String(s.mrr).padEnd(7)}${String(s.precision).padEnd(8)}${s.misses.join(', ') || '-'}`,
    );
  }
  const cmp = report.keyword_vs_hybrid;
  console.log(
    `\nhybrid vs keyword: top-1 ${cmp.top1Delta >= 0 ? '+' : ''}${cmp.top1Delta}, recall ${cmp.recallDelta >= 0 ? '+' : ''}${cmp.recallDelta}` +
      (cmp.better ? ` — ${cmp.better} wins` : ' — no clear winner'),
  );
  console.log(
    'prec@k is slate size on a one-answer corpus, not quality: a mode that always returns k scores 1/k.',
  );
  if (regressions.length) {
    console.log(`\nREGRESSION: hybrid now misses ${regressions.join(', ')}, which it is expected to find.`);
  }
  if (surprises.length) {
    console.log(`\nNEWS: hybrid now finds ${surprises.join(', ')}, which ADR-03 says it cannot. Re-read the ADR.`);
  }
  console.log('');
}

// Non-zero only on a real regression: a surprise is news, not a failure.
process.exit(regressions.length ? 1 : 0);
