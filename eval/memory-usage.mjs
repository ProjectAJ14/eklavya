#!/usr/bin/env node
/**
 * The memory-usage eval: what happened to recalled memory once it reached the
 * model.
 *
 * The retrieval eval next door measures whether the right entries were found on
 * a fixed corpus. This one reads real Claude Code transcripts and measures the
 * two things that corpus cannot see: whether the per-prompt recall was about
 * what the developer asked, and whether the model did anything with it.
 *
 *   node eval/memory-usage.mjs                          # last 3 days, all projects
 *   node eval/memory-usage.mjs --days 7 --project eklavya
 *   node eval/memory-usage.mjs --pairs pairs.jsonl      # also write prompt/recall pairs to label
 *   node eval/memory-usage.mjs score pairs.jsonl        # precision once `relevant` is filled in
 *
 * No model calls and no database: it reads `~/.claude/projects/*` (override with
 * `--dir`). The pairs file holds your own prompts; keep it out of the repository.
 *
 * What it counts, per session that received at least one recall block:
 *
 *   - `cited`: an assistant message names a recalled `#id`. A lower bound on use —
 *     a model can act on a recalled fact without citing it — so a low number is
 *     a question, not a verdict. The live check is a memory-on/memory-off run
 *     of the same task.
 *   - `searched`: the model called a `memory_*` tool itself.
 *
 * What would disprove "recall is being used": `cited` and `searched` both near
 * zero across a window long enough to include several follow-up sessions in one
 * project. Before 2026-09-25 that was the measured state: 0 of 79 sessions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const BLOCK = /<eklavya-memory\b[^>]*>[\s\S]*?<\/eklavya-memory>/g;

if (argv[0] === 'score') {
  score(argv[1]);
} else {
  scan();
}

/** Every string inside a JSON value, with JSON-encoded strings (hook stdout) opened too. */
function strings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    if (value.startsWith('{')) {
      try {
        strings(JSON.parse(value), out);
      } catch {
        /* Not JSON after all. */
      }
    }
  } else if (Array.isArray(value)) {
    for (const v of value) strings(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) strings(v, out);
  }
  return out;
}


function scan() {
  const dir = flag('--dir', path.join(os.homedir(), '.claude', 'projects'));
  const days = Number(flag('--days', '3'));
  const only = flag('--project', null);
  const pairsFile = flag('--pairs', null);
  const since = Date.now() - days * 86_400_000;

  const sessions = [];
  const pairs = [];
  for (const sub of fs.readdirSync(dir)) {
    if (only && !sub.toLowerCase().includes(only.toLowerCase())) continue;
    const folder = path.join(dir, sub);
    if (!fs.statSync(folder).isDirectory()) continue;
    for (const file of fs.readdirSync(folder)) {
      if (!file.endsWith('.jsonl')) continue;
      const full = path.join(folder, file);
      if (fs.statSync(full).mtimeMs < since) continue;
      const s = readSession(full, pairs);
      if (s.blocks.size) sessions.push({ project: sub, file, ...s });
    }
  }

  const n = sessions.length;
  const cited = sessions.filter((s) => s.cited.size).length;
  const searched = sessions.filter((s) => s.tools).length;
  const startOnly = sessions.filter((s) => s.promptBlocks === 0).length;
  const pct = (a) => (n ? `${Math.round((100 * a) / n)}%` : '-');
  console.log(`window: last ${days} day(s)${only ? ` · project filter "${only}"` : ''}`);
  console.log(`sessions that received recall: ${n} (${startOnly} at session start only)`);
  console.log(`  cited a recalled #id:        ${cited} (${pct(cited)})`);
  console.log(`  called a memory_* tool:      ${searched} (${pct(searched)})`);
  console.log(`per-prompt recalls:            ${pairs.length}`);

  if (pairsFile) {
    fs.writeFileSync(pairsFile, pairs.map((p) => JSON.stringify({ ...p, relevant: null })).join('\n') + '\n');
    console.log(`\nwrote ${pairs.length} pairs to ${pairsFile}; set "relevant" to true or false, then:`);
    console.log(`  node eval/memory-usage.mjs score ${pairsFile}`);
  }
}

function readSession(file, pairs) {
  const blocks = new Set();
  const recalledIds = new Set();
  const cited = new Set();
  let tools = 0;
  let promptBlocks = 0;
  let lastPrompt = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o.message?.content;
    if (o.type === 'user' && typeof content === 'string') lastPrompt = content;
    if (o.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'tool_use' && /eklavya.*__memory_/.test(c.name ?? '')) tools++;
        if (c.type === 'text') for (const m of c.text.matchAll(/#(\d{2,7})\b/g)) cited.add(m[1]);
      }
    }
    if (!line.includes('<eklavya-memory')) continue;
    const event = o.attachment?.hookEvent ?? o.attachment?.hookName ?? '';
    for (const text of strings(o)) {
      for (const [block] of text.matchAll(BLOCK)) {
        if (blocks.has(block)) continue;
        blocks.add(block);
        const ids = [...block.matchAll(/\[#(\d+)\]/g)].map((m) => m[1]);
        for (const id of ids) recalledIds.add(id);
        if (/UserPromptSubmit/.test(event) && lastPrompt) {
          promptBlocks++;
          pairs.push({
            session: path.basename(file, '.jsonl'),
            prompt: lastPrompt.slice(0, 400),
            recalled: [...block.matchAll(/\[#(\d+)\] ([^\n]*)/g)].map((m) => `#${m[1]} ${m[2]}`),
          });
        }
      }
    }
  }
  return { blocks, promptBlocks, tools, cited: new Set([...cited].filter((id) => recalledIds.has(id))) };
}

function score(file) {
  if (!file) {
    console.error('usage: node eval/memory-usage.mjs score <pairs.jsonl>');
    process.exit(1);
  }
  const rows = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const labelled = rows.filter((r) => typeof r.relevant === 'boolean');
  const hits = labelled.filter((r) => r.relevant).length;
  console.log(`labelled ${labelled.length} of ${rows.length}`);
  console.log(`on-topic: ${hits} (${labelled.length ? Math.round((100 * hits) / labelled.length) : 0}%) — target 70%`);
}
