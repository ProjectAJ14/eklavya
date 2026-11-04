#!/usr/bin/env node
/**
 * The recall replay eval (issue #258).
 *
 * `retrieval-harness.mjs` scores search on an invented corpus. This scores the
 * production recall on the developer's own history: it replays real sessions
 * in order from a COPY of `knowledge.db` and asks, at each session start and
 * each prompt, whether recall offered the entries the session then needed.
 *
 *   node eval/recall-replay.mjs                         # copy of ~/.eklavya/knowledge.db
 *   node eval/recall-replay.mjs --db path/to/knowledge.db --limit 200 --json
 *
 * No model call and no network: it costs nothing to run. It never opens the
 * file it is given for writing. The file (and its -wal) is copied to a
 * temporary folder first, because recall writes receipts.
 *
 * Relevance: an entry is relevant to a moment when one of its files is read or
 * edited later in the same session (for a prompt, after that prompt). That is
 * a proxy: a session that needed an entry and did not open its files counts as
 * nothing to find, and one that touched a file for an unrelated reason counts
 * as a need. The proxy is the same for every arm, so arms compare fairly.
 *
 * "As of": before each session is replayed, every entry written at or after
 * its first event is hidden, so recall sees only what existed then. Sessions
 * are replayed newest first so the hidden set only grows.
 *
 * Arms (config only; the vectors are whatever the copy holds, reported below):
 *   today   retrieval.seam_query off, prompt_gate strict (the default until 1.92)
 *   seam    seam_query on (the query is the last checkpoint's next steps plus
 *           the previous session's files, standing in for git state, which
 *           history does not keep)
 *   terms   prompt_gate terms
 *
 * Metrics: session-start hit@6 (a relevant entry among the first six the block
 * offers, full entries first, then timeline titles newest first) and prompt
 * recall hit@2 (a relevant entry among the first two recalled), each over the
 * moments that had a relevant entry; plus how often a prompt recall opened
 * when nothing was relevant, and the estimated tokens sent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(repoRoot, 'mcp', 'dist');
const need = (rel) => {
  const file = path.join(dist, rel);
  if (!fs.existsSync(file)) {
    console.error(`Missing ${file}. Run \`npm run build\` in mcp/ first.`);
    process.exit(1);
  }
  return pathToFileURL(file).href;
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const source = path.resolve(flag('db', path.join(os.homedir(), '.eklavya', 'knowledge.db')));
const LIMIT = Number(flag('limit', 500));
const asJson = args.includes('--json');

if (!fs.existsSync(source)) {
  console.error(`No database at ${source}. Pass --db <knowledge.db>.`);
  process.exit(1);
}

const { openDb } = await import(need('db.js'));
const { DEFAULT_CONFIG } = await import(need('config.js'));
const { recall, recallForPrompt } = await import(need('memory/recall.js'));
const { seamQueryOf, nextStepsOf } = await import(need('memory/seam.js'));

const ARMS = {
  today: { seam_query: false, prompt_gate: 'strict' },
  seam: { seam_query: true, prompt_gate: 'strict' },
  terms: { seam_query: false, prompt_gate: 'terms' },
};

const parse = (json) => {
  try {
    const v = JSON.parse(json ?? 'null');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

function copyDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-replay-'));
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, path.join(dir, `knowledge.db${suffix}`));
  }
  return { dir, file: path.join(dir, 'knowledge.db') };
}

function replay(armName) {
  const { dir, file } = copyDb();
  const db = openDb(file);
  const config = { ...DEFAULT_CONFIG, retrieval: { ...DEFAULT_CONFIG.retrieval, ...ARMS[armName] } };
  const sessions = db
    .prepare(
      `SELECT session_id, project, MIN(occurred_at) AS started FROM evidence_events
       WHERE project != '*' GROUP BY session_id, project ORDER BY started DESC LIMIT ?`,
    )
    .all(LIMIT);
  const embedders = db.prepare('SELECT embedder_id, count(*) AS n FROM memory_vectors GROUP BY embedder_id').all();
  const result = { arm: armName, sessions: sessions.length, start: { n: 0, hit: 0 }, prompt: { n: 0, hit: 0, irrelevant: 0, opened: 0 }, tokens: 0, embedders };
  const hide = db.prepare(`UPDATE memory_entries SET deleted_at = 'replay' WHERE occurred_at >= ? AND deleted_at IS NULL`);
  const visibleFiles = db.prepare(`SELECT id, files FROM memory_entries WHERE deleted_at IS NULL AND project = ? AND files IS NOT NULL`);
  const eventsOf = db.prepare(`SELECT kind, body, files, occurred_at FROM evidence_events WHERE session_id = ? AND project = ? ORDER BY occurred_at, id`);
  const previousFiles = db.prepare(
    `SELECT files FROM evidence_events WHERE project = ? AND occurred_at < ? AND files IS NOT NULL
     AND session_id = (SELECT session_id FROM evidence_events WHERE project = ? AND occurred_at < ? ORDER BY occurred_at DESC LIMIT 1)`,
  );
  const lastCheckpoint = db.prepare(
    `SELECT narrative FROM memory_entries WHERE project = ? AND kind = 'session_summary' AND deleted_at IS NULL ORDER BY occurred_at DESC LIMIT 1`,
  );

  for (const s of sessions) {
    hide.run(s.started);
    const entryFiles = visibleFiles.all(s.project).map((r) => ({ id: r.id, files: new Set(parse(r.files)) }));
    const events = eventsOf.all(s.session_id, s.project);
    const touched = (from) => {
      const set = new Set();
      for (const e of events.slice(from)) if (e.kind === 'file_read' || e.kind === 'file_edit' || e.kind === 'tool_use') for (const f of parse(e.files)) set.add(f);
      return set;
    };
    const relevantTo = (files) => new Set(entryFiles.filter((e) => [...e.files].some((f) => files.has(f))).map((e) => e.id));

    // Session start.
    const startRelevant = relevantTo(touched(0));
    const cp = lastCheckpoint.get(s.project);
    const prev = previousFiles.all(s.project, s.started, s.project, s.started).flatMap((r) => parse(r.files));
    const seamQuery = config.retrieval.seam_query
      ? seamQueryOf({ branch: null, files: [...new Set(prev)].slice(0, 20), commits: [], nextSteps: cp ? nextStepsOf(cp.narrative) : null })
      : null;
    const start = recall(db, config, { project: s.project, sessionId: `replay-${s.session_id}`, scope: 'session_start', index: true, seamQuery });
    result.tokens += start.deliveredTokens;
    if (startRelevant.size) {
      result.start.n++;
      const full = start.entries.map((e) => e.id);
      const titles = [...(start.block ?? '').matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1])).filter((id) => !full.includes(id)).reverse();
      if ([...full, ...titles].slice(0, 6).some((id) => startRelevant.has(id))) result.start.hit++;
    }

    // Prompts.
    events.forEach((e, i) => {
      if (e.kind !== 'prompt') return;
      const relevant = relevantTo(touched(i + 1));
      const r = recallForPrompt(db, config, { project: s.project, sessionId: `replay-${s.session_id}`, prompt: e.body });
      result.tokens += r ? r.deliveredTokens : 0;
      if (relevant.size) {
        result.prompt.n++;
        if (r && r.entries.slice(0, 2).some((x) => relevant.has(x.id))) result.prompt.hit++;
      } else {
        result.prompt.irrelevant++;
        if (r) result.prompt.opened++;
      }
    });
  }
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const rate = (a, b) => (b ? +(a / b).toFixed(3) : null);
  return {
    ...result,
    start_hit_at_6: rate(result.start.hit, result.start.n),
    prompt_hit_at_2: rate(result.prompt.hit, result.prompt.n),
    prompt_false_open: rate(result.prompt.opened, result.prompt.irrelevant),
  };
}

const report = { generated_at: new Date().toISOString(), source: path.basename(source), limit: LIMIT, arms: Object.keys(ARMS).map(replay) };
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`\nRecall replay — ${report.arms[0].sessions} sessions from a copy of ${report.source}\n`);
  console.log('arm     start hit@6 (n)   prompt hit@2 (n)   false-open (n)   tokens');
  for (const a of report.arms) {
    console.log(
      `${a.arm.padEnd(8)}${`${a.start_hit_at_6} (${a.start.n})`.padEnd(18)}${`${a.prompt_hit_at_2} (${a.prompt.n})`.padEnd(19)}${`${a.prompt_false_open} (${a.prompt.irrelevant})`.padEnd(17)}${a.tokens}`,
    );
  }
  console.log(`\nvectors: ${report.arms[0].embedders.map((e) => `${e.embedder_id} ${e.n}`).join(', ') || 'none'}\n`);
}
