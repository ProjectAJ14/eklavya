/**
 * Token accounting for every `claude -p` call an eval makes.
 *
 * Single-shot harnesses call `unwrap(stdout)` on the output of
 * `claude -p --output-format json`; it adds the call's usage to a running tally
 * and returns the reply text. Whole-session harnesses read the final `result`
 * event of a stream-json log with `fromStream(file)`.
 *
 * "Input" here is everything sent to the model: fresh input plus cache writes
 * plus cache reads. A one-word `claude -p` call already sends ~34k of Claude
 * Code's own context, so call counts alone understate the cost by a lot.
 */
import fs from 'node:fs';
import path from 'node:path';

const empty = () => ({ calls: 0, input: 0, cache_write: 0, cache_read: 0, output: 0, cost_usd: 0 });
const tally = empty();

function addTo(t, usage = {}, cost = 0) {
  t.calls += 1;
  t.input += usage.input_tokens ?? 0;
  t.cache_write += usage.cache_creation_input_tokens ?? 0;
  t.cache_read += usage.cache_read_input_tokens ?? 0;
  t.output += usage.output_tokens ?? 0;
  t.cost_usd += cost ?? 0;
  return t;
}

/** Parse `--output-format json` stdout, count it, return the reply text. */
export function unwrap(stdout) {
  let o;
  try {
    o = JSON.parse(stdout);
  } catch {
    throw new Error(`claude did not return JSON: ${String(stdout).slice(0, 200)}`);
  }
  addTo(tally, o.usage, o.total_cost_usd);
  return o.result ?? '';
}

/** Usage of one stream-json session log: its last `result` event covers the whole run. */
export function fromStream(file) {
  let last = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"type":"result"')) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === 'result') last = o;
    } catch {
      /* a partial line from a killed run */
    }
  }
  return last ? addTo(empty(), last.usage, last.total_cost_usd) : null;
}

export const sum = (list) => list.filter(Boolean).reduce((a, u) => {
  for (const k of Object.keys(a)) a[k] += u[k] ?? 0;
  return a;
}, empty());

export const summary = (t = tally) => ({ ...t, input_total: t.input + t.cache_write + t.cache_read, cost_usd: Number(t.cost_usd.toFixed(4)) });

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`);
export function line(t = tally) {
  const s = summary(t);
  return `tokens: ${k(s.input_total)} in (${k(s.cache_read)} cached) + ${k(s.output)} out over ${s.calls} call(s), ~$${s.cost_usd} at list price`;
}

/** Add this process's tally to `<dir>/usage.json` under `stage`, and print it. */
export function save(dir, stage) {
  const file = path.join(dir, 'usage.json');
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first stage */
  }
  all[stage] = summary();
  fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
  process.stdout.write(`${line()}\n`);
}
