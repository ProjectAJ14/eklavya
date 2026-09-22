#!/usr/bin/env node
/**
 * The memory performance baseline.
 *
 * Three of these numbers sit on the critical path of a human action and are
 * the only ones that really matter:
 *
 *   capture      runs after every tool call, so a slow one is a slow session
 *   startup      the SessionStart banner, which a developer waits on
 *   recall       the same hook, before the first prompt is answered
 *
 * The rest — search, timeline, the worker — are on an agent's path, where a
 * hundred milliseconds is invisible. They are measured anyway so a regression
 * has somewhere to show up.
 *
 *   node eval/memory-perf.mjs                 # 2,000 entries
 *   node eval/memory-perf.mjs --entries 20000 # the size that finds the cliffs
 *   node eval/memory-perf.mjs --json
 *
 * Costs nothing and calls no model. It is not in CI: timings on a shared
 * runner are noise, and a budget that fails on somebody else's load is a
 * budget people learn to ignore.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(path.dirname(evalDir), 'mcp', 'dist');

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
const ENTRIES = Number(flag('entries', 2000));
const asJson = args.includes('--json');

const { openDb } = await import(need('db.js'));
const { insertEntry, appendEvent, batchSession } = await import(need('memory/store.js'));
const { search } = await import(need('memory/search.js'));
const { recall, recallForPrompt, startupDisplay } = await import(need('memory/recall.js'));
const { processPending } = await import(need('memory/worker.js'));
const { prepare } = await import(need('memory/capture.js'));
const { DEFAULT_CONFIG } = await import(need('config.js'));
const { identityFor } = await import(need('memory/identity.js'));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-perf-'));
const db = openDb(path.join(home, 'knowledge.db'));
const PROJECT = '/work/perf-repo';
const config = DEFAULT_CONFIG;
const identity = { ...identityFor({ cwd: home, sessionId: 'perf' }), project: PROJECT };

/** Median rather than mean: one GC pause should not become the headline. */
function timed(label, iterations, fn) {
  // A warm-up run, so the first measurement is not paying for statement
  // preparation that every later call gets for free.
  fn(0);
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    fn(i + 1);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    iterations,
    median_ms: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
    p95_ms: Number(samples[Math.floor(samples.length * 0.95)].toFixed(3)),
    max_ms: Number(samples[samples.length - 1].toFixed(3)),
  };
}

const WORDS = 'auth cookie refresh rotation token migration sqlite index cursor react effect hydration deploy health queue retry idempotency tenant pagination bundle'.split(' ');
const pick = (n, seed) => Array.from({ length: n }, (_, i) => WORDS[(seed * 7 + i * 13) % WORDS.length]).join(' ');

const results = [];

// Capture: the hook path, minus the database write, then with it.
results.push(
  timed('capture.prepare (pure: exclusion + redaction)', 2000, (i) =>
    prepare(config, identity, { kind: 'tool_use', tool: 'Bash', body: `npm test ${pick(12, i)}` }),
  ),
);
results.push(
  timed('capture append (one indexed insert)', 2000, (i) =>
    appendEvent(db, {
      eventUid: `perf-event-${i}`,
      project: PROJECT,
      sessionId: 'perf',
      kind: 'tool_use',
      tool: 'Bash',
      body: `npm test ${pick(12, i)}`,
    }),
  ),
);

// Fill the corpus. Not timed as a batch: one insert at a time is the shape the
// worker actually writes in, and a bulk transaction would flatter it.
const fill = process.hrtime.bigint();
for (let i = 0; i < ENTRIES; i++) {
  insertEntry(db, {
    project: PROJECT,
    sessionId: `s${i % 200}`,
    title: `Observation ${i}: ${pick(4, i)}`,
    narrative: pick(40, i + 1),
    facts: [pick(8, i + 2)],
    files: [`src/${WORDS[i % WORDS.length]}/mod${i % 50}.ts`],
    tags: [WORDS[i % WORDS.length]],
    type: ['feature', 'bugfix', 'decision', 'discovery'][i % 4],
  });
}
const fillMs = Number(process.hrtime.bigint() - fill) / 1e6;

for (const mode of ['keyword', 'semantic', 'hybrid']) {
  results.push(
    timed(`search ${mode} (${ENTRIES} entries)`, 60, (i) =>
      search(db, pick(3, i), mode, { project: PROJECT, limit: 6 }),
    ),
  );
}

results.push(timed('recall at a session seam', 60, () => recall(db, config, { project: PROJECT, sessionId: 'perf' })));
// The one cost paid on EVERY prompt, after the developer pressed Enter. A
// fresh session id each time, so the per-session deduplication does not make
// the second call free and flatter the number.
results.push(
  timed('recall per prompt (every turn)', 40, (i) =>
    recallForPrompt(db, config, {
      project: PROJECT,
      sessionId: `perf-prompt-${i}`,
      prompt: `Why did we change the ${pick(3, i)} behaviour in the auth middleware?`,
    }),
  ),
);
results.push(timed('startup display', 200, () => startupDisplay(db, PROJECT)));

// The worker, on one real batch.
for (let i = 0; i < 40; i++) {
  appendEvent(db, {
    eventUid: `perf-batch-${i}`,
    project: PROJECT,
    sessionId: 'batch-session',
    kind: 'file_edit',
    tool: 'Edit',
    body: pick(20, i),
    files: ['src/auth.ts'],
  });
}
batchSession(db, { project: PROJECT, sessionId: 'batch-session', reason: 'manual' });
const workerStart = process.hrtime.bigint();
await processPending(db, config, { maxJobs: 1 });
const workerMs = Number(process.hrtime.bigint() - workerStart) / 1e6;

const dbBytes = fs.statSync(path.join(home, 'knowledge.db')).size;
db.close();
fs.rmSync(home, { recursive: true, force: true });

const report = {
  generated_at: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  corpus: { entries: ENTRIES, fill_ms: Number(fillMs.toFixed(0)), db_bytes: dbBytes },
  worker_local_summarizer_ms: Number(workerMs.toFixed(1)),
  measurements: results,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\nMemory performance — ${ENTRIES} entries, ${(dbBytes / 1e6).toFixed(1)}MB, ${process.version} on ${report.platform}\n`);
  console.log('operation                                        median    p95     max');
  for (const r of results) {
    console.log(
      `${r.label.padEnd(48)}${String(r.median_ms).padEnd(10)}${String(r.p95_ms).padEnd(8)}${r.max_ms}`,
    );
  }
  console.log(`\ncorpus fill: ${report.corpus.fill_ms}ms for ${ENTRIES} entries (insert + FTS + vector, one at a time)`);
  console.log(`local summariser on a 40-event batch: ${report.worker_local_summarizer_ms}ms`);
  console.log(
    "\nFour sit on a human's path: capture append (every tool call), the startup display,\nthe seam recall, and the per-prompt recall (every time they press Enter).\n",
  );
}
