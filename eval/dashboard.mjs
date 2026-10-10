#!/usr/bin/env node
/**
 * A live view of eval runs, separate from the Eklavya dashboard. Zero dependencies.
 *
 *   node eval/dashboard.mjs [--port 4747] [--dir <folder to scan, default eval/>]
 *
 * Runs that write a `*.progress.json` or `progress.json` (the GEPA runner does)
 * show their trials, calls, tokens and time. It also counts the `claude -p`
 * processes alive right now, which is the only signal for a run that predates
 * progress files. Local only: binds to 127.0.0.1, reads files, changes nothing.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const root = path.resolve(opt('dir', evalDir));
const port = Number(opt('port', 4747));

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.venv') || e.name === 'gepa-state') continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(f);
    else if (e.name === 'progress.json' || e.name.endsWith('.progress.json')) yield f;
  }
}

function snapshot() {
  const runs = [];
  for (const f of walk(root)) {
    try {
      runs.push({ file: path.relative(root, f), ...JSON.parse(fs.readFileSync(f, 'utf8')) });
    } catch {
      /* half-written; the next poll gets it */
    }
  }
  runs.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  let claude = 0;
  try {
    claude = execFileSync('pgrep', ['-f', 'claude -p'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
  } catch {
    /* pgrep exits 1 when nothing matches */
  }
  return { now: Date.now() / 1000, root, claude, runs };
}

const page = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Eval runs</title>
<style>
:root{--bg:#fff;--panel:#f5f5f4;--ink:#1c1917;--dim:#57534e;--line:#d6d3d1;--spot:#0f766e;--warn:#b45309}
@media(prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--ink:#ecebe8;--dim:#a8a59e;--line:#34332f;--spot:#2dd4bf;--warn:#f59e0b}}
body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,sans-serif;max-width:900px;margin-inline:auto}
h1{font-size:18px;margin:0 0 4px}.dim{color:var(--dim)}
.card{background:var(--panel);border:1px solid var(--line);padding:12px 14px;margin:12px 0}
.row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.bar{height:8px;background:var(--line);margin:8px 0}.bar>i{display:block;height:100%;background:var(--spot)}
.state{font:600 12px ui-monospace,monospace;text-transform:uppercase}.state.running{color:var(--spot)}.state.stopped{color:var(--warn)}
table{border-collapse:collapse;width:100%;font:12px ui-monospace,monospace;margin-top:8px}td,th{text-align:left;padding:2px 10px 2px 0;color:var(--dim)}td.n{text-align:right;color:var(--ink)}
code{font:12px ui-monospace,monospace}
</style>
<h1>Eval runs</h1><div class=dim id=meta>loading…</div><div id=runs></div>
<script>
const k=n=>n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?Math.round(n/1e3)+'k':String(n);
const t=s=>{s=Math.max(0,Math.round(s));const m=Math.floor(s/60);return m>=60?Math.floor(m/60)+'h '+(m%60)+'m':m+'m '+(s%60)+'s'};
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function tick(){
  let d;try{d=await (await fetch('/api')).json()}catch{document.getElementById('meta').textContent='server not reachable';return}
  document.getElementById('meta').textContent=d.claude+' claude -p process(es) running now · scanning '+d.root;
  document.getElementById('runs').innerHTML=d.runs.length?d.runs.map(r=>{
    const live=r.state==='running'&&d.now-r.updated<120;
    const state=r.state==='running'&&!live?'stale (no update for '+t(d.now-r.updated)+')':r.state;
    const pct=r.trials_total?Math.min(100,100*r.trials_done/r.trials_total):0;
    const tk=r.tokens||{};const err=Object.values(r.errors||{}).reduce((a,b)=>a+b,0);
    const kinds=Object.entries(r.calls||{}).map(([n,c])=>'<tr><td>'+esc(n)+'</td><td class=n>'+c+' calls</td><td class=n>'+k((tk.by_kind||{})[n+':input']+(tk.by_kind||{})[n+':cache_write']+(tk.by_kind||{})[n+':cache_read']||0)+' in</td><td class=n>'+k((tk.by_kind||{})[n+':output']||0)+' out</td></tr>').join('');
    return '<div class=card><div class=row><b>'+esc(r.label)+'</b><span class="state '+(live?'running':'stopped')+'">'+esc(state)+'</span></div>'
    +'<div class=bar><i style="width:'+pct+'%"></i></div>'
    +'<div class=row><span>'+r.trials_done+' / '+r.trials_total+' trials</span><span>'+r.total_calls+' / '+r.cap+' calls · '+err+' errors</span><span>'+t((live?d.now:r.updated)-r.started)+' of '+r.max_minutes+' min</span></div>'
    +'<div class=row><span><b>'+k(tk.input_total||0)+'</b> tokens in ('+k(tk.cache_read||0)+' cached) · <b>'+k(tk.output||0)+'</b> out</span><span class=dim>~$'+r.cost_usd_list_price+' at list price</span></div>'
    +'<table>'+kinds+'</table><div class=dim><code>'+esc(r.file)+'</code></div></div>'}).join(''):'<div class="card dim">No progress files under this folder yet. A run started before progress files existed shows only in the process count above.</div>';
}
tick();setInterval(tick,3000);
</script>`;

http
  .createServer((req, res) => {
    if (req.url === '/api') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(snapshot()));
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
    }
  })
  .listen(port, '127.0.0.1', () => process.stdout.write(`eval dashboard: http://127.0.0.1:${port}  (scanning ${root})\n`));
