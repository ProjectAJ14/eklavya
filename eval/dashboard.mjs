#!/usr/bin/env node
/**
 * A live view of eval runs, separate from the Eklavya dashboard. Zero dependencies.
 *
 *   node eval/dashboard.mjs [--port 4747] [--dir <folder to scan, default eval/>]
 *
 * Reads every `*.progress.json` / `progress.json` (a run in flight; the GEPA runner writes them)
 * and every finished evaluate result (a `.json` with `trials` and `summary`), and shows them as
 * Now, Runs, Compare and Guide. It also counts the `claude -p` processes alive right now, which
 * is the only signal for a run that predates progress files. Local only: binds to 127.0.0.1,
 * reads files, changes nothing.
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
    else if (e.name.endsWith('.json')) yield f;
  }
}

const isProgress = (f) => path.basename(f) === 'progress.json' || f.endsWith('.progress.json');
const cache = new Map(); // file -> { m, s, run }: a big fixture file is parsed once, not every poll

// A finished result has the progress file's fields under `budget`; lift them so both read alike.
function fromResult(d, f, st) {
  return {
    file: path.relative(root, f), kind: 'result', label: path.basename(f, '.json'),
    state: d.stopped_early ? 'stopped early' : 'done', trials_done: d.trials.length, trials_total: d.trials.length,
    started: null, updated: st.mtimeMs / 1000, max_minutes: null, prompt: null,
    promptName: typeof d.prompt === 'string' ? d.prompt : null, split: d.split, model: d.model, marker: d.marker,
    ...d.budget, summary: d.summary, trials: d.trials,
  };
}

// A run file is data, not markup, and the page concatenates some of its numbers into HTML. Make every number a
// number and `state` one of the known words here, so a hand-edited or hostile .json cannot carry a tag in them.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const counts = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' && !Array.isArray(o) ? o : {}).map(([k, v]) => [k, num(v) ?? 0]));
function tame(r) {
  for (const k of ['trials_done', 'trials_total', 'total_calls']) r[k] = num(r[k]) ?? 0;
  for (const k of ['cap', 'max_minutes', 'started', 'updated', 'cost_usd_list_price']) r[k] = num(r[k]);
  r.state = ['running', 'done', 'stopped early'].includes(r.state) ? r.state : 'unknown';
  r.errors = counts(r.errors);
  r.calls = counts(r.calls);
  if (r.prompt && typeof r.prompt === 'object') {
    r.prompt = { file: String(r.prompt.file ?? ''), diff: typeof r.prompt.diff === 'string' ? r.prompt.diff : '', words: num(r.prompt.words) ?? 0, shipped_words: num(r.prompt.shipped_words) ?? 0 };
  } else r.prompt = null;
  const s = (r.summary && typeof r.summary === 'object' ? r.summary : {});
  s.gate_failures = counts(s.gate_failures);
  for (const [g, v] of Object.entries(s.second_judge ?? {})) s.second_judge[g] = counts(v);
  for (const [g, v] of Object.entries(s.longest ?? {})) s.longest[g] = counts(v);
  r.summary = s;
  for (const x of Array.isArray(r.trials) ? r.trials : []) {
    if (!x || typeof x !== 'object') continue;
    for (const k of ['tier', 'answer_position', 'repeat', 'correct_option', 'score']) if (k in x) x[k] = num(x[k]);
  }
  return r;
}

function load(f) {
  const st = fs.statSync(f), c = cache.get(f);
  if (c && c.m === st.mtimeMs && c.s === st.size) return c.run;
  let run = null;
  try {
    if (st.size < 30e6) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (isProgress(f)) run = { file: path.relative(root, f), kind: 'progress', ...d };
      else if (Array.isArray(d.trials) && d.summary && typeof d.summary === 'object') run = fromResult(d, f, st);
    }
  } catch {
    /* half-written; the next poll gets it */
  }
  if (run) tame(run);
  cache.set(f, { m: st.mtimeMs, s: st.size, run });
  return run;
}

function snapshot() {
  let runs = [];
  for (const f of walk(root)) {
    const r = load(f);
    if (r) runs.push(r);
  }
  // A result and the progress file it grew from are one run: keep the result, borrow the progress label.
  const byFile = new Map(runs.map((r) => [r.file, r]));
  runs = runs.filter((r) => {
    if (r.kind !== 'progress' || r.state === 'running' || !r.file.endsWith('.progress.json')) return true;
    const res = byFile.get(r.file.replace(/[.]progress[.]json$/, '.json'));
    if (!res) return true;
    Object.assign(res, { label: r.label, started: r.started, max_minutes: r.max_minutes, prompt: r.prompt });
    return false;
  });
  // The same run saved twice (eval/gepa/runs and eval/results) shows once, listing its copies.
  const seen = new Map();
  runs = runs.filter((r) => {
    if (r.state === 'running') return true;
    const sig = JSON.stringify([r.trials.length, r.summary?.mean_score, r.cost_usd_list_price, r.split, r.marker?.prompt]);
    const o = seen.get(sig);
    if (!o) return seen.set(sig, r) && true;
    (o.copies ??= []).push(r.file);
    if (o.kind !== 'progress' && r.kind === 'progress') Object.assign(o, { label: r.label });
    return false;
  });
  runs.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  let claude = 0;
  try {
    claude = execFileSync('pgrep', ['-f', 'claude -p'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
  } catch {
    /* pgrep exits 1 when nothing matches */
  }
  return { now: Date.now() / 1000, root, claude, runs };
}

const page = `<!doctype html><html lang=en data-mode=ink><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Eval runs</title>
<script>try{var m=localStorage.getItem('mode');if(m==='paper')document.documentElement.dataset.mode=m}catch(e){}</script>
<style>
/* Role tokens copied from web/public/tokens.css (ink is the default ground, paper the alternate). */
:root,:root[data-mode=ink]{--bg:#17171a;--panel:#1e1e22;--mass:#26262a;--ink:#EAE7E1;--dim:#A29C93;--faint:#8B857B;--line:#26262a;--line-2:#33333a;--spot:#79D5C4;--spot-ink:#17171a;--spot-soft:color-mix(in srgb,var(--spot) 14%,transparent);--warning:#E8920C;--warning-soft:color-mix(in srgb,var(--warning) 14%,transparent);--error:#FF6166;--error-soft:color-mix(in srgb,var(--error) 12%,transparent);--code-bg:var(--mass);--shadow-lg:0 12px 28px rgba(0,0,0,.45);--ring:0 0 0 2px var(--bg),0 0 0 4px var(--spot)}
:root[data-mode=paper]{--bg:#f0ede6;--panel:#e7e3da;--mass:#ddd8cc;--ink:#16150f;--dim:#57534a;--faint:#635E52;--line:#e3dfd4;--line-2:#cec8b9;--spot:#0A5751;--spot-ink:#ffffff;--spot-soft:color-mix(in srgb,var(--spot) 10%,transparent);--warning:#7A4B00;--warning-soft:color-mix(in srgb,var(--warning) 10%,transparent);--error:#A8201A;--error-soft:color-mix(in srgb,var(--error) 12%,transparent);--code-bg:#EDEAE2;--shadow-lg:0 12px 28px rgba(22,21,15,.10)}
:root{--font-disp:'Archivo',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;--font-body:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,sans-serif;--font-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--ease:cubic-bezier(.2,.6,.2,1);--caps:.16em}
*{box-sizing:border-box;border-radius:0}
html{background:var(--bg);scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.6 var(--font-body);overflow-wrap:anywhere}
button,select{font:inherit;color:inherit}a{color:var(--spot)}
:focus-visible{outline:none;box-shadow:var(--ring)}
code,pre,table,.mono,.n,.mk{font-family:var(--font-mono)}
.n{text-align:right;font-variant-numeric:tabular-nums}
.mk{font-size:11px;line-height:16px;text-transform:uppercase;letter-spacing:var(--caps);color:var(--faint)}
.dim{color:var(--dim)}
/* shell: sidebar + main */
.app{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh}
aside{position:sticky;top:0;align-self:start;height:100vh;border-right:1px solid var(--line-2);background:var(--panel);padding:24px 0;display:flex;flex-direction:column;gap:24px}
.brand{padding:0 20px}.brand b{display:block;font:900 22px/1.1 var(--font-disp);letter-spacing:-.045em}.brand span{font-size:12px;color:var(--dim)}
nav{display:flex;flex-direction:column}
nav a{display:block;padding:12px 20px;border-left:3px solid transparent;border-top:1px solid var(--line);text-decoration:none;color:var(--ink);transition:background .14s var(--ease),border-color .14s var(--ease)}
nav a:last-child{border-bottom:1px solid var(--line)}
nav a:hover{background:var(--mass)}nav a:focus-visible{box-shadow:inset 0 0 0 2px var(--spot)}
nav a b{display:flex;justify-content:space-between;align-items:center;font:600 15px/22px var(--font-body)}
nav a small{display:block;font-size:12px;line-height:17px;color:var(--dim);margin-top:2px}
nav a[aria-current=page]{border-left-color:var(--spot);background:var(--spot-soft)}nav a[aria-current=page] b{color:var(--spot)}
.cnt{font:600 11px/16px var(--font-mono);background:var(--spot);color:var(--spot-ink);padding:0 7px}
.side-foot{margin-top:auto;padding:0 20px}
main{padding:32px clamp(24px,3vw,64px) 80px;width:100%;min-width:0}
h1{font:900 30px/1.1 var(--font-disp);letter-spacing:-.045em;margin:0 0 6px}
.lede{color:var(--dim);margin:0 0 24px;max-width:70ch}
h2{font:900 20px/1.2 var(--font-disp);letter-spacing:-.03em;margin:32px 0 12px}
.btn{flex:none;white-space:nowrap;background:var(--panel);border:1px solid var(--line-2);padding:6px 12px;font:500 12px/16px var(--font-mono);cursor:pointer;text-decoration:none;color:var(--ink);display:inline-block;transition:border-color .14s var(--ease),color .14s var(--ease),background .14s var(--ease)}
.btn:hover{border-color:var(--spot);color:var(--spot)}
.btn[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--faint);margin-right:6px;vertical-align:1px}.dot.on{background:var(--spot);animation:pulse 1.6s var(--ease) infinite}
@keyframes pulse{50%{opacity:.35}}
/* run rows */
.grp{margin:28px 0 8px;display:flex;align-items:baseline;gap:12px}.grp h2{margin:0}
.run{border:1px solid var(--line-2);background:var(--panel);margin:0 0 8px}
.rs{display:grid;grid-template-columns:112px minmax(0,1fr) 72px 92px 20px;gap:16px;align-items:center;width:100%;text-align:left;background:transparent;border:0;padding:14px 16px;cursor:pointer;transition:background .14s var(--ease)}
.rs:hover{background:var(--mass)}.rs:hover .chev{color:var(--spot)}.rs:focus-visible{box-shadow:inset 0 0 0 2px var(--spot)}
.rs .t{font-weight:600;font-size:15px;line-height:22px}.rs .s{display:block;color:var(--dim);font-size:13.5px;line-height:20px;margin-top:2px}
.rs .f{display:block;font:11.5px/16px var(--font-mono);color:var(--faint);margin-top:2px}
.chev{display:flex;color:var(--faint);transition:transform .14s var(--ease)}[aria-expanded=true] .chev{transform:rotate(90deg)}
.badge{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line-2);padding:2px 8px;font:600 11px/16px var(--font-mono);text-transform:uppercase;letter-spacing:.08em;white-space:nowrap;width:max-content}
.badge.running{color:var(--spot);border-color:var(--spot);background:var(--spot-soft)}.badge.done{color:var(--dim)}.badge.stopped{color:var(--warning);border-color:var(--warning);background:var(--warning-soft)}
.prog{display:block;height:10px;background:var(--mass);margin:10px 0 6px}.prog i{display:block;height:100%;background:var(--spot);transition:width .32s var(--ease)}.prog.stopped i{background:var(--warning)}
/* now cards */
.live{border:1px solid var(--spot);background:var(--panel);padding:20px;margin:0 0 16px}.live.stale{border-color:var(--warning)}
.live h2{margin:8px 0 4px;font-size:18px}.live .big{font:900 44px/1 var(--font-disp);letter-spacing:-.05em}
.live .row{display:flex;flex-wrap:wrap;gap:6px 24px;align-items:baseline;color:var(--dim)}.live .row b{color:var(--ink);font-family:var(--font-mono);font-weight:600}
.live .prog{height:14px;margin:14px 0 8px}
.empty{border:1px solid var(--line-2);background:var(--panel);padding:28px 24px}.empty b{display:block;font:900 22px/1.2 var(--font-disp);letter-spacing:-.03em;margin:6px 0 8px}
/* detail */
.detail{border-top:1px solid var(--line-2);padding:16px;background:var(--bg)}
.detail h3{font:600 11px/16px var(--font-mono);text-transform:uppercase;letter-spacing:var(--caps);color:var(--faint);margin:22px 0 8px;display:flex;gap:12px;flex-wrap:wrap;align-items:baseline}.detail h3:first-child{margin-top:0}
.detail h3 a{font-weight:400;text-transform:none;letter-spacing:0}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:0}
.stats>div{position:relative;background:var(--panel);border:1px solid var(--line-2);padding:8px 12px}
.stats dt{font:11px/16px var(--font-mono);text-transform:uppercase;letter-spacing:var(--caps);color:var(--faint)}
.stats dd{margin:0;font:600 15px/22px var(--font-mono);font-variant-numeric:tabular-nums}.stats dd small{font:400 12px var(--font-mono);color:var(--dim)}
.g{cursor:help;border-bottom:1px dotted var(--faint);position:relative}.g:hover::after,.g:focus::after{content:attr(data-tip);position:absolute;left:0;top:calc(100% + 6px);z-index:5;width:max-content;max-width:min(260px,70vw);background:var(--panel);color:var(--ink);border:1px solid var(--line-2);box-shadow:var(--shadow-lg);padding:8px 10px;font:400 12.5px/1.45 var(--font-body);text-transform:none;letter-spacing:0;white-space:normal}
.chip{display:inline-block;border:1px solid var(--line-2);padding:0 8px;margin:0 4px 4px 0;font:12px/20px var(--font-mono);white-space:nowrap}
.chip.bad{color:var(--error);border-color:var(--error);background:var(--error-soft)}.chip.ok{color:var(--spot);border-color:var(--spot)}
.scroll{overflow-x:auto;border:1px solid var(--line-2);background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:12.5px;min-width:520px}
th,td{text-align:left;padding:7px 12px;vertical-align:top;border-top:1px solid var(--line)}
th{font:500 11px/16px var(--font-mono);text-transform:uppercase;letter-spacing:var(--caps);color:var(--faint);border-top:0;white-space:nowrap}
td.n,th.n{text-align:right}
tr.t>td{padding:0}tr.t>td>.tb,tr.t>td>.tc{padding:7px 12px}tr.t>td>.tc{white-space:nowrap}
.tb{display:flex;gap:8px;width:100%;background:transparent;border:0;text-align:left;cursor:pointer;font:inherit}.tb:hover{color:var(--spot)}.tb:focus-visible{box-shadow:inset 0 0 0 2px var(--spot)}
tr.x>td{background:var(--bg);padding:16px}td.s{font-weight:600}
code{font-size:.92em}pre{font-size:12px;line-height:1.5;margin:4px 0;white-space:pre-wrap;background:var(--code-bg);border:1px solid var(--line-2);padding:10px;max-height:260px;overflow:auto}
.add{background:var(--spot-soft)}.del{background:var(--error-soft)}.worse{color:var(--error)}.better{color:var(--spot)}
details{margin:8px 0}summary{cursor:pointer;color:var(--dim);padding:4px 0}summary:hover{color:var(--spot)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}.opt{padding:3px 0}.opt.key{color:var(--spot);font-weight:600}
select{background:var(--panel);color:var(--ink);border:1px solid var(--line-2);padding:8px 10px;width:100%;cursor:pointer}select:hover{border-color:var(--spot)}
.foot{margin-top:16px;color:var(--faint);font-size:12px}
.cmd{position:relative}.cmd pre{padding-right:64px;max-height:none}.cmd .btn{position:absolute;top:8px;right:8px;padding:2px 8px}
/* compare */
.step{border:1px solid var(--line-2);background:var(--panel);padding:16px;margin:0 0 12px}.step label{display:block;font-weight:600;margin-bottom:8px}.step label span{font:600 11px/16px var(--font-mono);color:var(--spot);margin-right:8px}
.verdict{border:1px solid var(--line-2);border-left-width:4px;background:var(--panel);padding:16px 20px;margin:20px 0}.verdict.better{border-color:var(--spot);color:inherit}.verdict.worse{border-color:var(--error);color:inherit}.verdict.none,.verdict.cannot{border-color:var(--warning);color:inherit}
.verdict b{display:block;font:900 26px/1.15 var(--font-disp);letter-spacing:-.035em;margin-bottom:4px}
.warn{border:1px solid var(--warning);background:var(--warning-soft);padding:8px 12px;margin:8px 0;font-size:13.5px}
.fx{display:grid;grid-template-columns:minmax(120px,240px) minmax(0,1fr) 120px;gap:6px 16px;align-items:center;padding:8px 12px;border-top:1px solid var(--line)}.fx:first-child{border-top:0}
.fx .bars{display:grid;gap:3px}.bar{height:8px;background:var(--mass);display:block}.bar i{display:block;height:100%}.bar.a i{background:var(--faint)}.bar.b i{background:var(--spot)}
.fxs{border:1px solid var(--line-2);background:var(--panel)}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin:8px 0;font-size:12.5px;color:var(--dim)}.legend i{display:inline-block;width:12px;height:8px;margin-right:6px}
/* guide */
.guide dl{margin:0}.guide dt{font:600 15px/22px var(--font-body);margin-top:20px;scroll-margin-top:16px}.guide dd{margin:2px 0 0;color:var(--dim);max-width:70ch}.guide dt:target{color:var(--spot)}
.guide section{scroll-margin-top:16px}
@media(max-width:800px){
 .app{display:block}aside{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line-2);padding:12px 0 0;gap:8px}
 .brand{display:flex;justify-content:space-between;align-items:center;gap:12px}.brand span{display:none}.side-foot{position:absolute;top:12px;right:16px;padding:0}aside{position:relative}
 nav{flex-direction:row;overflow-x:auto}nav a{flex:1 0 auto;border-left:0;border-top:0;border-bottom:3px solid transparent;padding:10px 16px}nav a:last-child{border-bottom:3px solid transparent}nav a small{display:none}
 nav a[aria-current=page],nav a[aria-current=page]:last-child{border-bottom-color:var(--spot)}
 nav a b{gap:8px}
 main{padding:20px 16px 64px}.cols{grid-template-columns:1fr}}
@media(max-width:620px){.rs{grid-template-columns:minmax(0,1fr) 20px;gap:6px 12px}.rs>.c1{grid-column:1/2;grid-row:1}.rs>.chev{grid-column:2;grid-row:1}.rs>.c2{grid-column:1/-1;grid-row:2}.rs>.c3,.rs>.c4{grid-row:3;grid-column:1/-1;display:inline}.rs .c3,.rs .c4{font-size:12.5px}
 .fx{grid-template-columns:minmax(0,1fr) 104px}.fx .bars{grid-column:1/-1;order:3}h1{font-size:26px}.live .big{font-size:36px}.detail{padding:12px}}
@media(prefers-reduced-motion:reduce){*,html{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
</style>
<body><div class=app>
<aside><div class=brand><div><b>Eval runs</b><span>Local, read-only</span></div></div><nav id=nav aria-label=Sections></nav><div class=side-foot><button class=btn id=mode type=button></button></div></aside>
<main id=main tabindex=-1><div class=dim>Loading…</div></main></div>
<script>
const k=n=>n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?Math.round(n/1e3)+'k':String(Math.round(n||0));
const t=s=>{s=Math.max(0,Math.round(s));const m=Math.floor(s/60);return m>=60?Math.floor(m/60)+'h '+(m%60)+'m':m+'m '+(s%60)+'s'};
const ago=s=>{s=Math.max(0,s);return s<90?'just now':s<5400?Math.round(s/60)+' min ago':s<172800?Math.round(s/3600)+' h ago':Math.round(s/86400)+' days ago'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fx=(v,d)=>v==null?'–':Number(v).toFixed(d);
const usd=v=>v==null?'–':'$'+Number(v).toFixed(2);
const sum=r=>r.summary||{};
const open=new Set(JSON.parse(sessionStorage.getItem('open')||'[]'));let last='',data=null,onlyFail=sessionStorage.getItem('fail')==='1';
const save=()=>{sessionStorage.setItem('open',JSON.stringify([...open]));sessionStorage.setItem('fail',onlyFail?'1':'0')};
const CHEV='<svg width=16 height=16 viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=2 stroke-linecap=round stroke-linejoin=round aria-hidden=true><path d="m9 18 6-6-6-6"/></svg>';
/* The decision rule below mirrors eval/gepa/decide.py (MIN_FIXTURES, MIN_DIFFERENCE, verdict, warnings). Change it there first. */
const MIN_FIXTURES=8,MIN_DIFF={question:.05,feedback:.10,extraction:.05,observer:.03,dedup:.05};
const TARGETS=[['question','Tutor questions'],['feedback','Prompt feedback'],['extraction','Concept extraction'],['observer','Memory observer'],['dedup','Concept dedup'],['other','Other runs']];
const GLOSS={calls:'Each call is one fresh claude -p run, a generation or a judge verdict. The cap stops a run that would keep spending.',errors:'Calls that failed or timed out. A trial that never finished scores 0 in the mean.',tin:'Tokens sent to the model, cached reads included. This is what drains a subscription limit.',tout:'Tokens the model wrote back.',cost:'Estimated at list price. A subscription is not billed per token.',time:'Wall time against the --max-minutes limit.',fin:'Mean score counting only trials that finished. A timeout scores 0 in the normal mean, so this shows how good answers are when they arrive.',valid:'Mean score counting only trials whose output was valid.'};
const g=(w,key)=>'<span class=g tabindex=0 data-tip="'+esc(GLOSS[key])+'">'+w+'</span>';
const what=a=>'<a href="#guide/'+a+'">What does this mean?</a>';
function target(r){const x=((r.label||'')+' '+(r.file||'')+' '+(r.promptName||'')).toLowerCase();
  const key=/dedup/.test(x)?'dedup':/memory|observer/.test(x)?'observer':/extraction|(^|[ /-])ex[0-9p]*-/.test(x)?'extraction':/feedback|(^|[ /-])fb[0-9]*-/.test(x)?'feedback':/question|mcq|pilot|(^|[ /-])q[0-9]*-/.test(x)?'question':sum(r).quotes?'feedback':'other';
  return key}
const isOpt=r=>/optimi[sz]e/.test(r.label||'')||(r.trials||[]).some(x=>x.candidate!==undefined);
const splitOf=r=>r.split||((/[(](test|val|train)[)]/.exec(r.label||''))||[])[1]||null;
const timedOut=x=>x.error&&/did not finish|timed out|timeout/i.test(x.error);
function state(r,d){
  const live=r.state==='running'&&d.now-r.updated<120;
  if(live)return{live,cls:'running',txt:'Running',dot:1};
  if(r.state==='running')return{live,cls:'stopped',txt:'Stalled'};
  return r.state==='done'?{live,cls:'done',txt:'Done'}:{live,cls:'stopped',txt:r.state==='stopped early'?'Stopped early':String(r.state||'Unknown')}}
const badge=st=>'<span class="badge '+st.cls+'">'+(st.dot?'<span class="dot on" style="margin:0"></span>':'')+esc(st.txt)+'</span>';
function plain(r){
  const s=sum(r),all=r.trials||[],n=s.trials??all.length,errs=all.filter(x=>x.error).length,to=all.filter(timedOut).length,pre=r.state==='running'?'So far, ':'';
  if(isOpt(r)){const c=new Set(all.map(x=>x.candidate)).size;return pre+'Scored '+n+' tries across '+c+' candidate prompt'+(c===1?'':'s')+'. Mean score '+fx(s.mean_score,2)+'.'}
  if(s.all_gates_passed==null)return pre+n+' trials'+(s.mean_score!=null?'. Mean score '+fx(s.mean_score,2):', no overall score recorded')+'.';
  let o=(pre?'So far, ':'')+(s.all_gates_passed??0)+' of '+n+' trials passed every gate.';
  if(errs)o+=' '+errs+' ended in an error'+(to?' ('+to+' timed out)':'')+'.';
  return o+' Mean score '+fx(s.mean_score,2)+'.'}
function diff(d){return d?d.split('\\n').map(l=>'<div class="'+(l[0]==='+'&&l[1]!=='+'?'add':l[0]==='-'&&l[1]!=='-'?'del':'')+'">'+esc(l)+'</div>').join(''):'<span class=dim>no change from the shipped prompt (this is the baseline)</span>'}
const JUDGED=['key_correct','single_answer','cold_answerable','tier_match'];
const chips=x=>{const f=x.gates_failed||[];if(!f.length)return '<span class="chip ok">all gates pass</span>';
  const skip=f.includes('structure');return f.filter(g=>!(skip&&JUDGED.includes(g))).map(g=>'<span class="chip bad">fail '+esc(g)+'</span>').join('')+(skip?'<span class="chip" title="A malformed question is not sent to the judges; the run counts the judged gates as failed.">judges skipped</span>':'')};
function trial(r,x,i){
  const key=r.file+'#'+i,o=open.has(key),inp=x.input||{},q=x.stem!==undefined;
  const plan=q?'t'+x.tier+' · '+esc(x.focus)+(x.answer_position!=null?' · slot '+x.answer_position:''):x.candidate?'candidate '+esc(x.candidate):x.repeat!=null?'repeat '+x.repeat:'';
  let h='<tr class=t><td><button class=tb type=button data-k="'+esc(key)+'" aria-expanded='+o+'><span aria-hidden=true>'+(o?'▾':'▸')+'</span><span>'+esc(q?x.group:x.id)+'</span></button></td><td><div class=tc>'+plan+'</div></td><td class="n s"><div class=tc>'+fx(x.score??0,2)+'</div></td><td><div class=tc>'+chips(x)+'</div></td></tr>';
  if(!o)return h;
  const rest={...x};for(const n of['id','repeat','score','gates_failed','error','quality','candidate'])delete rest[n];
  const grade='<h3>Grade</h3><div>score '+(x.score??0)+' · quality '+esc(JSON.stringify(x.quality||{}))+'</div>'+(x.error?'<div class=worse>'+esc(x.error)+'</div>':'')+((x.failed_checks||[]).length?'<div class=worse>'+x.failed_checks.map(esc).join('<br>')+'</div>':'');
  return h+'<tr class=x><td colspan=4>'+(q?'<div class=cols><div><h3>Input</h3><div class=dim>'+esc(inp.concept)+' · '+esc(inp.source)+'</div><div>'+esc(inp.description)+'</div>'+(inp.code?'<pre>'+esc(inp.code)+'</pre>':'<div class=dim>code withheld for this focus</div>')+'</div>'
   +'<div><h3>Output</h3><div><b>'+esc(x.stem)+'</b></div>'+(x.options||[]).map((op,j)=>'<div class="opt'+(j+1===x.correct_option?' key':'')+'">'+(j+1)+'. '+esc(op)+(j+1===x.correct_option?' (key)':'')+'<div class=dim>'+esc((x.descriptions||[])[j]||'')+'</div></div>').join('')
   +grade+'<pre>'+esc(JSON.stringify(x.judge||{},null,1))+'</pre></div></div>':grade+'<pre>'+esc(JSON.stringify(rest,null,1))+'</pre>')+'</td></tr>'}
function detail(r,d){
  const s=sum(r),tk=r.tokens||{},err=Object.values(r.errors||{}).reduce((a,b)=>a+b,0),bk=tk.by_kind||{},st=state(r,d),p=r.prompt,mk=r.marker;
  const kinds=Object.entries(r.calls||{}).map(([n,c])=>'<tr><td>'+esc(n)+'</td><td class=n>'+c+'</td><td class=n>'+k((bk[n+':input']||0)+(bk[n+':cache_write']||0)+(bk[n+':cache_read']||0))+'</td><td class=n>'+k(bk[n+':output']||0)+'</td></tr>').join('');
  const gf=Object.entries(s.gate_failures||{}).map(([n,c])=>'<span class="chip bad">'+esc(n)+' ×'+c+'</span>').join('')||'<span class=dim>none yet</span>';
  const lg=s.longest||{},lr=x=>x&&x.of?x.keyed_strictly_longest+'/'+x.of:null;
  const lon=[['label',lr(lg.label)],['description',lr(lg.description)],['both',lr(lg.combined)]].filter(a=>a[1]);
  const sj=Object.entries(s.second_judge||{}).map(([n,v])=>'<tr><td>'+esc(n)+'</td><td class=n>'+v.claude_pass+'/'+v.of+'</td><td class=n>'+v.azure_pass+'/'+v.of+'</td><td class=n>'+v.agree+'/'+v.of+'</td></tr>').join('');
  const models=Object.entries(r.models||{}).map(([n,m])=>esc(n)+': '+esc((m||[]).join(', '))).join(' · ');
  const all=r.trials||[],shown=all.map((x,i)=>[x,i]).filter(a=>!onlyFail||(a[0].gates_failed||[]).length||a[0].error).reverse();
  const stat=(l,v)=>'<div><dt>'+l+'</dt><dd>'+v+'</dd></div>',el=r.started?(st.live?d.now:r.updated)-r.started:null;
  return '<div class=detail><h3>Run '+what('trial')+'</h3><dl class=stats>'
   +stat(g('Calls','calls'),(r.total_calls??'–')+' <small>/ '+(r.cap??'–')+' cap</small>')+stat(g('Errors','errors'),err)+stat(g('Tokens in','tin'),k(tk.input_total)+' <small>'+k(tk.cache_read)+' cached</small>')+stat(g('Tokens out','tout'),k(tk.output))
   +stat(g('Cost','cost'),usd(r.cost_usd_list_price))+(el!=null?stat(g('Time','time'),t(el)+(r.max_minutes?' <small>of '+r.max_minutes+' min</small>':'')):'')
   +(s.mean_score_finished_only!=null?stat(g('Score, finished only','fin'),fx(s.mean_score_finished_only,2)):'')+(s.mean_score_when_valid!=null?stat(g('Score, valid only','valid'),fx(s.mean_score_when_valid,2)):'')+'</dl>'
   +'<div class=dim style="margin-top:8px">'+(models?'Models · '+models:'')+(r.promptName?'<br>Prompt · <code>'+esc(r.promptName)+'</code>':'')+(splitOf(r)?'<br>Split · '+esc(splitOf(r)):'')+(mk?'<br>Fixture set '+esc(mk.fixtures)+' · prompt '+esc(mk.prompt)+' · code '+esc(mk.code):'')+'</div>'
   +'<h3>Gate failures '+what('gate')+'</h3><div>'+gf+'</div>'+(s.gate_failures&&s.gate_failures.structure?'<p class=dim style="margin:8px 0 0">'+s.gate_failures.structure+' trial'+(s.gate_failures.structure===1?'':'s')+' failed structure and were never judged. The run still counts each of them as failing the four judged gates, so those counts include them. Open a trial to see the reason.</p>':'')
   +(lon.length?'<h3>Keyed option strictly longest</h3><div>'+lon.map(a=>'<span class=chip>'+a[0]+' '+a[1]+'</span>').join('')+'</div>':'')
   +(sj?'<h3>Second judge agreement</h3><div class=scroll><table><tr><th>gate</th><th class=n>claude pass</th><th class=n>azure pass</th><th class=n>agree</th></tr>'+sj+'</table></div>':'')
   +(p?'<details data-k="'+esc(r.file)+'#diff"'+(open.has(r.file+'#diff')?' open':'')+'><summary>Change under test: '+esc(p.file.split('/').pop())+' · '+p.words+' words (shipped '+p.shipped_words+')</summary><pre>'+diff(p.diff)+'</pre></details>':'')
   +(kinds?'<details data-k="'+esc(r.file)+'#calls"'+(open.has(r.file+'#calls')?' open':'')+'><summary>Calls and tokens by kind</summary><div class=scroll><table><tr><th>kind</th><th class=n>calls</th><th class=n>in</th><th class=n>out</th></tr>'+kinds+'</table></div></details>':'')
   +'<h3>Trials · '+shown.length+(onlyFail?' failing of '+all.length:'')+' '+what('trial')+' <button class=btn type=button id=fl aria-pressed='+onlyFail+'>Failing trials only</button></h3>'
   +(shown.length?'<div class=scroll><table><tr><th>example</th><th>plan</th><th class=n>score</th><th>gates</th></tr>'+shown.map(a=>trial(r,a[0],a[1])).join('')+'</table></div>':'<div class=dim>No failing trials.</div>')
   +'<div class=foot><code>'+esc(r.file)+'</code>'+((r.copies||[]).length?' · also saved as '+r.copies.map(c=>'<code>'+esc(c)+'</code>').join(', '):'')+'</div></div>'}
function row(r,d){
  const st=state(r,d),o=open.has(r.file+'#run');
  return '<div class=run><button class=rs type=button data-k="'+esc(r.file+'#run')+'" aria-expanded='+o+'>'
   +'<span class=c1>'+badge(st)+'</span><span class=c2><span class=t>'+esc(r.label)+'</span><span class=s>'+esc(plain(r))+'</span><span class=f>'+esc(r.file)+'</span></span>'
   +'<span class="c3 n" title="List-price cost">'+usd(r.cost_usd_list_price)+'</span><span class="c4 dim" title="'+esc(new Date(r.updated*1000).toLocaleString())+'">'+ago(d.now-r.updated)+'</span>'
   +'<span class=chev>'+CHEV+'</span></button>'+(o?detail(r,d):'')+'</div>'}
/* views */
function vNow(d){
  const run=d.runs.filter(r=>r.state==='running');
  let h='<h1>Now</h1><p class=lede>Runs that are working at this moment, how far along they are and what they have cost so far. This page refreshes itself every three seconds.</p>';
  h+='<p><span class="dot'+(d.claude?' on':'')+'"></span><b>'+d.claude+'</b> claude -p process'+(d.claude===1?'':'es')+' alive on this machine right now.</p>';
  if(!run.length)return h+'<div class=empty><span class=mk>Idle</span><b>Nothing is running.</b><div class=dim>Start a run and it shows up here within three seconds. The quickest cheap check (3 fixtures, one repeat):</div>'+cmd('python3 eval/gepa/extraction/run.py evaluate --model claude-sonnet-5-5 --limit 3 --repeats 1 --out eval/gepa/runs/try.json')+'<div><a href="#guide/start">All start commands in the Guide</a> · <a href="#runs">Look at finished runs</a></div></div>';
  return h+run.map(r=>{const st=state(r,d),el=d.now-r.started,dn=r.trials_done,pct=r.trials_total?Math.min(100,100*dn/r.trials_total):0;
    const eta=st.live&&dn>=3&&dn<r.trials_total?Math.round(el/dn*(r.trials_total-dn)):null,lim=r.max_minutes?r.max_minutes*60-el:null;
    return '<section class="live'+(st.live?'':' stale')+'"><div class=mk>'+badge(st)+' '+esc(TARGETS.find(a=>a[0]===target(r))[1])+'</div><h2>'+esc(r.label)+'</h2><div class=big>'+dn+' <span class=dim style="font-size:22px;letter-spacing:0">of '+r.trials_total+' trials</span></div>'
     +'<span class="prog '+st.cls+'" role=progressbar aria-valuemin=0 aria-valuemax='+r.trials_total+' aria-valuenow='+dn+'><i style="width:'+pct+'%"></i></span>'
     +'<p style="margin:0 0 8px">'+esc(plain(r))+'</p>'
     +'<div class=row><span>Cost so far <b>'+usd(r.cost_usd_list_price)+'</b></span><span>Running for <b>'+t(el)+'</b></span><span>Calls <b>'+(r.total_calls??0)+' / '+(r.cap??'–')+'</b></span>'
     +(eta!=null?'<span>About <b>'+t(eta)+'</b> left at this pace'+(lim!=null&&eta>lim?' (the '+r.max_minutes+' min limit stops it first)':'')+'</span>':'<span class=dim>'+(st.live?'No estimate until 3 trials are done.':'No update for '+t(d.now-r.updated)+', the run may have stopped.')+'</span>')+'</div>'
     +'<p style="margin:12px 0 0"><a href="#runs" data-open="'+esc(r.file)+'">Open the details</a></p></section>'}).join('')}
function vRuns(d){
  let h='<h1>Runs</h1><p class=lede>Every run found under <code>'+esc(d.root)+'</code>, grouped by what it tests, newest first. Select a row to see its numbers and trials.</p>';
  if(!d.runs.length)return h+'<div class=empty><span class=mk>No runs yet</span><b>No result files found.</b><div class=dim>This page reads <code>progress.json</code>, <code>*.progress.json</code> and finished result files (<code>.json</code> with trials) under the folder above. Start one and it appears here.</div><div><a href="#guide/start">How to start a run</a></div></div>';
  const by={};for(const r of d.runs)(by[target(r)]??=[]).push(r);
  return h+TARGETS.filter(a=>by[a[0]]).map(a=>'<div class=grp><h2>'+a[1]+'</h2><span class=mk>'+by[a[0]].length+' run'+(by[a[0]].length===1?'':'s')+'</span></div>'+by[a[0]].map(r=>row(r,d)).join('')).join('')}
function means(r){const m={};for(const x of r.trials||[])(m[x.id]??=[]).push(x.score||0);for(const i in m)m[i]=m[i].reduce((a,b)=>a+b,0)/m[i].length;return m}
function verdict(tg,b,c){const sh=Object.keys(b).filter(i=>i in c);
  if(sh.length<MIN_FIXTURES)return{kind:'cannot',n:sh.length,sh};
  const av=o=>sh.reduce((a,i)=>a+o[i],0)/sh.length,diff=av(c)-av(b),fl=MIN_DIFF[tg];
  return{kind:Math.abs(diff)<fl?'none':diff>0?'better':'worse',diff,fl,n:sh.length,sh}}
function warns(a,b){const x=a.marker,y=b.marker;if(!x||!y)return['One run has no test-split marker (it predates issue 235), so its split and code version are unverified.'];
  const o=[];if(x.split!==y.split||x.fixtures!==y.fixtures)o.push('Different fixtures: '+x.split+'/'+x.fixtures+' vs '+y.split+'/'+y.fixtures+'. The runs did not answer the same questions.');
  if(x.code!==y.code)o.push('The harness or scorer changed between the runs ('+x.code+' vs '+y.code+'), so the before run is not comparable. Re-run it.');
  for(const[n,r]of[['before',a],['after',b]]){const m=(r.models||{}).generate||[];if(m.length>1)o.push('The '+n+' run generated with '+m.length+' models ('+m.join(', ')+'). Pass --model to pin one, or the comparison mixes models.')}
  if(x.split==='test'&&x.prompt===y.prompt)o.push('Both runs used the same prompt, so this measures noise, not your change.');return o}
const NEXT={better:'Your change scored higher by more than the threshold. Keep it; if the gap is close to the threshold, run the after evaluation once more to rule out noise.',worse:'Your change scored lower by more than the threshold. Do not ship it; open the fixtures that dropped (bottom of the list) to see which gate failed.',none:'The gap is smaller than the rule counts as real, so the change neither helped nor hurt measurably. Ship it only for reasons other than the score.',cannot:'There are too few fixtures in common to judge. Run both evaluations on the same split without --limit.'};
const HEAD={better:'The change helped.',worse:'The change made it worse.',none:'No measurable difference.',cannot:'Cannot decide yet.'};
function vCompare(d,q){
  const el=d.runs.filter(r=>r.state!=='running'&&!isOpt(r)&&splitOf(r)&&target(r)!=='other'&&(r.trials||[]).length);
  let h='<h1>Compare</h1><p class=lede>Did your change help? Pick a run from before the change and one from after it. Both must test the same thing on the same split.</p>';
  if(!el.length)return h+'<div class=empty><b>Nothing to compare yet.</b><div class=dim>You need two finished evaluate runs of the same target. <a href="#guide/start">How to start them</a>.</div></div>';
  const key=r=>target(r)+'/'+splitOf(r),lab=r=>esc(r.label)+' · '+ago(d.now-r.updated)+' · score '+fx(sum(r).mean_score,2);
  const byF=f=>el.find(r=>r.file===f||(r.copies||[]).includes(f)),fxs=r=>r.marker&&r.marker.fixtures;
  let a=byF(q.get('a')),b=byF(q.get('b'));
  if(!a&&!b)for(const nw of el){const old=el.slice(el.indexOf(nw)+1),mate=old.find(r=>key(r)===key(nw)&&fxs(r)&&fxs(r)===fxs(nw)&&r.marker.prompt!==nw.marker.prompt)||null;if(mate){a=mate;b=nw;break}}
  if(!a&&!b){const nw=el[0],mate=el.slice(1).find(r=>key(r)===key(nw));if(mate){a=mate;b=nw}}
  if(a&&(!b||key(b)!==key(a)||b===a))b=el.find(r=>r!==a&&key(r)===key(a))||null;
  const peers=a?el.filter(r=>r!==a&&key(r)===key(a)):[];
  h+='<div class=step><label for=selA><span>1</span>Pick the run before your change</label><select id=selA><option value="">Choose a run…</option>'+el.map(r=>'<option value="'+esc(r.file)+'"'+(r===a?' selected':'')+'>'+lab(r)+'</option>').join('')+'</select></div>'
   +'<div class=step><label for=selB><span>2</span>Pick the run after your change</label><select id=selB'+(a?'':' disabled')+'><option value="">'+(a?(peers.length?'Choose a run…':'No other run of this target and split'):'Pick the before run first')+'</option>'+peers.map(r=>'<option value="'+esc(r.file)+'"'+(r===b?' selected':'')+'>'+lab(r)+'</option>').join('')+'</select><div class="dim" style="font-size:13px;margin-top:6px">Only runs of the same target and split are listed.</div></div>';
  if(!a||!b)return h;
  h+='<p><a class=btn href="#compare?a='+encodeURIComponent(b.file)+'&b='+encodeURIComponent(a.file)+'">Swap before and after</a></p>';
  const tg=target(a),ma=means(a),mb=means(b),v=verdict(tg,ma,mb),w=warns(a,b),sa=sum(a),sb=sum(b);
  h+='<div class="verdict '+v.kind+'"><b>'+HEAD[v.kind]+'</b>'
   +'<div class=mono style="font-size:13px">'+(v.kind==='cannot'?'cannot decide: '+v.n+' fixtures compared, the rule needs '+MIN_FIXTURES:v.kind==='none'?'no difference: mean '+(v.diff>=0?'+':'')+v.diff.toFixed(3)+', under the '+v.fl+' the '+tg+' rule requires':(v.kind==='better'?'candidate better':'candidate worse')+': mean '+(v.diff>=0?'+':'')+v.diff.toFixed(3)+' (rule: at least '+v.fl+' over '+MIN_FIXTURES+'+ fixtures)')+'</div>'
   +'<p style="margin:8px 0 0">'+NEXT[v.kind]+' <a href="#guide/verdict">How to read this</a></p></div>'
   +w.map(x=>'<div class=warn><b>Warning.</b> '+esc(x)+'</div>').join('')
   +'<h2>The numbers</h2><div class=scroll><table style="min-width:0"><tr><th>measure</th><th class=n>before</th><th class=n>after</th></tr>'
   +'<tr><td>pass every gate</td><td class=n>'+(sa.all_gates_passed??0)+'/'+(sa.trials??0)+'</td><td class=n>'+(sb.all_gates_passed??0)+'/'+(sb.trials??0)+'</td></tr>'
   +'<tr><td>mean score</td><td class=n>'+fx(sa.mean_score,3)+'</td><td class=n>'+fx(sb.mean_score,3)+'</td></tr>'
   +'<tr><td>mean score, finished only</td><td class=n>'+fx(sa.mean_score_finished_only,3)+'</td><td class=n>'+fx(sb.mean_score_finished_only,3)+'</td></tr>'
   +'<tr><td>cost at list price</td><td class=n>'+usd(a.cost_usd_list_price)+'</td><td class=n>'+usd(b.cost_usd_list_price)+'</td></tr></table></div>'
   +'<h2>Each fixture</h2><div class=legend><span><i style="background:var(--faint)"></i>Before</span><span><i style="background:var(--spot)"></i>After</span><span>Bar length is the mean score, 0 to 1. Largest change first.</span></div>'
   +'<div class=fxs>'+v.sh.map(i=>[i,mb[i]-ma[i]]).sort((p,q2)=>Math.abs(q2[1])-Math.abs(p[1])).map(([i,dv])=>'<div class=fx><span class=mono style="font-size:12.5px">'+esc(i)+'</span><span class=bars><span class="bar a"><i style="width:'+(100*ma[i]).toFixed(0)+'%"></i></span><span class="bar b"><i style="width:'+(100*mb[i]).toFixed(0)+'%"></i></span></span><span class="n '+(Math.abs(dv)<.005?'dim':dv>0?'better':'worse')+'">'+'<span style="white-space:nowrap">'+fx(ma[i],2)+' → '+fx(mb[i],2)+'</span><br>'+(Math.abs(dv)<.005?'same':(dv>0?'+':'')+dv.toFixed(2)+(dv>0?' better':' worse'))+'</span></div>').join('')+'</div>';
  return h}
function cmd(c){return '<div class=cmd><pre>'+esc(c)+'</pre><button class=btn type=button data-copy="'+esc(c)+'">Copy</button></div>'}
function vGuide(){
  const M='--model claude-sonnet-5-5',R='eval/gepa/runs/',V='eval/gepa/.venv/bin/python ';
  const T=[['Tutor questions','eval/gepa/pilot.py','q','--train 24 --val 12 --metric-calls 100 --max-model-calls 400 --max-minutes 90'],['Prompt feedback','eval/gepa/feedback/run.py','fb','--metric-calls 60 --max-model-calls 200 --max-minutes 75'],['Concept extraction','eval/gepa/extraction/run.py','ex','--metric-calls 60 --max-model-calls 400 --max-minutes 90'],['Memory observer','eval/gepa/memory/run.py','mem','']];
  const D=(id,w,x)=>'<dt id="g-'+id+'">'+w+'</dt><dd>'+x+'</dd>';
  return '<div class=guide><h1>Guide</h1><p class=lede>What the words and numbers mean, how to read a verdict, and how to start a run. Nothing here changes any file; these runs are started from a terminal.</p>'
   +'<section><h2>The words</h2><dl>'
   +D('trial','Trial','One model answer to one fixture, then graded. A run repeats each fixture (usually three times) so one lucky or unlucky answer does not decide the result.')
   +D('fixture','Fixture','One fixed example the run is tested on, such as one coding session or one review request. The same fixtures in both runs are what make a comparison fair.')
   +D('split','Split','Which share of the fixtures a run used: train and val are for the search, test is untouched and is the only one a decision should rest on.')
   +D('gate','Gate','A pass or fail check on a trial, for example "the keyed answer is correct". A trial that fails a gate cannot score above 0.5. Failed gates appear as red chips.')
   +D('timeout','Timeout and errors','A trial where the model did not answer in time or the tool rejected its output. It scores 0, so a few timeouts pull the whole mean down without saying anything about the prompt.')
   +D('finished','Finished only','The mean score counting only trials that produced an answer. Read it next to the normal mean: a big gap means the prompt is good when it finishes but often does not.')
   +D('score','Score','0 to 1 per trial. Passing every gate puts a trial at 0.5 or above, and the rest comes from quality checks. The run score is the mean over all its trials, timeouts included as 0.')
   +'</dl></section>'
   +'<section><h2>Reading a verdict</h2><dl>'+D('verdict','Verdict','Compare takes the mean score of each shared fixture, averages the change, and applies the rule in <code>eval/gepa/decide.py</code>: at least '+MIN_FIXTURES+' fixtures in common, and a change at least as big as the threshold for that target (questions 0.05, feedback 0.10, extraction 0.05, observer 0.03, dedup 0.05). Smaller than that is "no difference", because the same prompt scored that far apart from itself. Any warning means the two runs were not like for like: fix that first.')+'</dl></section>'
   +'<section id="g-start"><h2>Start a run</h2><p class=dim>Every call is a fresh <code>claude -p</code> of about 44k input tokens, so start small with <code>--limit 3 --repeats 1</code>. Always pass <code>--model</code>: without it the run mixes whatever model the machine defaults to and Compare will warn. Run from the repository root; the search needs the Python venv from <code>eval/gepa/README.md</code>.</p>'
   +T.map(a=>'<h2 style="font-size:16px">'+a[0]+'</h2><div class=mk>Evaluate the shipped prompt</div>'+cmd('python3 '+a[1]+' evaluate '+M+' --split test --repeats 3 --out '+R+a[2]+'-shipped.json')
     +'<div class=mk style="margin-top:8px">Search for a better prompt, then evaluate it</div>'+cmd(V+a[1]+' optimize '+M+' --out '+R+a[2]+'-search '+a[3]+'\\npython3 '+a[1]+' evaluate '+M+' --prompt '+R+a[2]+'-search/best_candidate.md --split test --repeats 3 --out '+R+a[2]+'-cand.json')
     +'<div class=mk style="margin-top:8px">Print the comparison in the terminal</div>'+cmd('python3 '+a[1]+' report '+R+a[2]+'-shipped.json '+R+a[2]+'-cand.json')).join('')
   +'<h2 style="font-size:16px">Concept dedup</h2><div class=mk>Evaluate, then compare (no search, no judges)</div>'+cmd('python3 eval/gepa/dedup/run.py evaluate '+M+' --split test --repeats 3 --out '+R+'dedup-before.json\\npython3 eval/gepa/dedup/run.py report '+R+'dedup-before.json '+R+'dedup-after.json')+'</section>'
   +'<section id="g-saved"><h2>Where results are saved</h2><p class=dim>Whatever you pass to <code>--out</code>, as a <code>.json</code> file, plus a <code>.progress.json</code> next to it while it runs. Optimize runs write a <code>progress.json</code>, <code>summary.json</code> and <code>best_candidate.md</code> in their <code>--out</code> folder. This page scans the folder shown at the top of Runs (by default <code>eval/</code>) and lists any <code>.json</code> file with trials in it, so results saved under <code>eval/results/</code> appear too.</p></section></div>'}
const ROUTES=[['now','Now','What is running, and what it costs'],['runs','Runs','Every finished and live run, by target'],['compare','Compare','Did my change help? Before vs after'],['guide','Guide','What the words mean and how to start a run']];
function route(){const h=location.hash.slice(1),[p,qs]=h.split('?'),[name,anchor]=p.split('/');return{name:ROUTES.some(a=>a[0]===name)?name:null,anchor,q:new URLSearchParams(qs||'')}}
function render(){
  const d=data,rt=route(),running=d.runs.filter(r=>r.state==='running'&&d.now-r.updated<120).length;
  if(!rt.name){history.replaceState(null,'','#'+(running?'now':'runs'));return render()}
  const ae=document.activeElement,fk=ae&&(ae.dataset.k||ae.id||ae.dataset.nav),y=scrollY;
  document.getElementById('nav').innerHTML=ROUTES.map(a=>'<a href="#'+a[0]+'" data-nav="'+a[0]+'"'+(a[0]===rt.name?' aria-current=page':'')+'><b>'+a[1]+(a[0]==='now'&&running?'<span class=cnt>'+running+' running</span>':'')+'</b><small>'+a[2]+'</small></a>').join('');
  document.getElementById('main').innerHTML={now:vNow,runs:vRuns,compare:d=>vCompare(d,rt.q),guide:vGuide}[rt.name](d);
  if(fk){const el=document.querySelector('[data-k="'+(window.CSS&&CSS.escape?CSS.escape(fk):fk)+'"],[data-nav="'+fk+'"],#'+fk.replace(/[^a-zA-Z0-9_-]/g,''));if(el&&el.focus)el.focus({preventScroll:true})}
  scrollTo(0,y)}
function nav(){if(!data)return;const rt=route();render();if(rt.anchor){const el=document.getElementById('g-'+rt.anchor);if(el){el.scrollIntoView();el.tabIndex=-1;el.focus({preventScroll:true})}}else scrollTo(0,0)}
function mode(){const m=document.documentElement.dataset.mode,b=document.getElementById('mode');b.textContent=m==='paper'?'Use ink ground':'Use paper ground';b.setAttribute('aria-label','Switch to the '+(m==='paper'?'ink':'paper')+' ground')}
document.getElementById('mode').onclick=()=>{const h=document.documentElement,m=h.dataset.mode==='paper'?'ink':'paper';h.dataset.mode=m;try{localStorage.setItem('mode',m)}catch(e){}mode()};mode();
document.addEventListener('click',e=>{
  const cp=e.target.closest('[data-copy]');if(cp){try{navigator.clipboard.writeText(cp.dataset.copy);cp.textContent='Copied'}catch(x){cp.textContent='Select and copy'}setTimeout(()=>{cp.textContent='Copy'},1500);return}
  if(e.target.closest('#fl')){onlyFail=!onlyFail;save();render();return}
  const op=e.target.closest('[data-open]');if(op)open.add(op.dataset.open+'#run'),save();
  const b=e.target.closest('button[data-k]');if(!b)return;const key=b.dataset.k;
  open.has(key)?open.delete(key):open.add(key);save();render()});
document.addEventListener('change',e=>{const a=document.getElementById('selA'),b=document.getElementById('selB');if(e.target!==a&&e.target!==b)return;
  const q=new URLSearchParams();if(a.value)q.set('a',a.value);if(e.target===b&&b.value)q.set('b',b.value);location.hash='compare'+(q.toString()?'?'+q:'')});
document.addEventListener('toggle',e=>{const dt=e.target;if(!dt.dataset||!dt.dataset.k)return;dt.open?open.add(dt.dataset.k):open.delete(dt.dataset.k);save()},true);
addEventListener('hashchange',nav);
async function tick(){
  let txt;try{txt=await (await fetch('/api')).text()}catch{document.getElementById('main').innerHTML='<div class=empty><b>Server not reachable.</b><div class=dim>Restart <code>node eval/dashboard.mjs</code>; this page retries every three seconds.</div></div>';last='';return}
  const d=JSON.parse(txt);const sig=JSON.stringify({...d,now:Math.floor(d.now/30)});if(sig===last)return;last=sig;data=d;render()}
tick();setInterval(tick,3000);
</script>`;

// A page on another origin can reach 127.0.0.1 through DNS rebinding and read /api; only our own address is served.
const hostOk = (h) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;

http
  .createServer((req, res) => {
    if (!hostOk(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
    } else if (req.url === '/api') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(snapshot()));
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
    }
  })
  .listen(port, '127.0.0.1', () => process.stdout.write(`eval dashboard: http://127.0.0.1:${port}  (scanning ${root})\n`));
