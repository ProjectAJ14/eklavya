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
:root{--bg:#fff;--panel:#f5f5f4;--ink:#1c1917;--dim:#57534e;--line:#d6d3d1;--spot:#0f766e;--warn:#b45309;--bad:#b91c1c;--add:#dcfce7;--del:#fee2e2}
@media(prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--ink:#ecebe8;--dim:#a8a59e;--line:#34332f;--spot:#2dd4bf;--warn:#f59e0b;--bad:#f87171;--add:#12301f;--del:#3a1717}}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,sans-serif;max-width:1100px;margin-inline:auto}
h1{font-size:18px;margin:0 0 4px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);margin:16px 0 6px}.dim{color:var(--dim)}
.card{background:var(--panel);border:1px solid var(--line);padding:12px 14px;margin:12px 0}
.row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.bar{height:8px;background:var(--line);margin:8px 0}.bar>i{display:block;height:100%;background:var(--spot)}
.state{font:600 12px ui-monospace,monospace;text-transform:uppercase}.state.running{color:var(--spot)}.state.stopped{color:var(--warn)}
table{border-collapse:collapse;width:100%;font:12px ui-monospace,monospace}th,td{text-align:left;padding:3px 10px 3px 0;vertical-align:top}th{color:var(--dim);font-weight:500}td.n,th.n{text-align:right}
tr.t{cursor:pointer;border-top:1px solid var(--line)}tr.t:hover{background:var(--bg)}
.chip{display:inline-block;border:1px solid var(--line);padding:0 6px;margin:0 4px 2px 0;font:11px ui-monospace,monospace}.chip.bad{color:var(--bad);border-color:var(--bad)}.chip.ok{color:var(--spot);border-color:var(--spot)}
.better{color:var(--spot)}.worse{color:var(--bad)}
code,pre{font:12px/1.45 ui-monospace,monospace}pre{margin:4px 0;white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);padding:8px;max-height:260px;overflow:auto}
.add{background:var(--add)}.del{background:var(--del)}
details{margin:6px 0}summary{cursor:pointer;color:var(--dim)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:700px){.cols{grid-template-columns:1fr}}
.opt{padding:2px 0}.opt.key{color:var(--spot);font-weight:600}
select{background:var(--bg);color:var(--ink);border:1px solid var(--line);padding:2px 6px;font:12px ui-monospace,monospace;border-radius:0}
.scroll{overflow-x:auto}
</style>
<h1>Eval runs</h1><div class=dim id=meta>loading…</div><div id=cmp></div><div id=runs></div>
<script>
const k=n=>n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?Math.round(n/1e3)+'k':String(Math.round(n||0));
const t=s=>{s=Math.max(0,Math.round(s));const m=Math.floor(s/60);return m>=60?Math.floor(m/60)+'h '+(m%60)+'m':m+'m '+(s%60)+'s'};
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const GATES=['structure','rationale_free','key_correct','single_answer','cold_answerable','tier_match'];
const open=new Set(JSON.parse(sessionStorage.getItem('open')||'[]'));let last='',data=null,A=null,B=null;
const save=()=>sessionStorage.setItem('open',JSON.stringify([...open]));
const sum=r=>r.summary||{};
const inTok=r=>(r.tokens||{}).input_total||0;
function diff(d){return d?d.split('\\n').map(l=>'<div class="'+(l[0]==='+'&&l[1]!=='+'?'add':l[0]==='-'&&l[1]!=='-'?'del':'')+'">'+esc(l)+'</div>').join(''):'<span class=dim>no change from the shipped prompt (this is the baseline)</span>'}
function trial(r,x,i){
  const key=r.file+'#'+i,o=open.has(key),inp=x.input||{};
  const gates=x.error?'<span class="chip bad">'+esc(x.error)+'</span>':GATES.map(g=>'<span class="chip '+((x.gates_failed||[]).includes(g)?'bad':'ok')+'">'+(((x.gates_failed||[]).includes(g))?'✗ ':'✓ ')+g+'</span>').join('');
  let h='<tr class=t data-k="'+esc(key)+'"><td>'+(o?'▾':'▸')+' '+esc(x.group)+'</td><td>t'+x.tier+' · '+esc(x.focus)+' · slot '+x.answer_position+'</td><td class=n>'+(x.score??0).toFixed(2)+'</td><td>'+gates+'</td><td>'+esc((x.visible_words_per_option||[]).join('/'))+'</td></tr>';
  if(o)h+='<tr><td colspan=5><div class=cols><div><h2>Input</h2><div class=dim>'+esc(inp.concept)+' · '+esc(inp.source)+'</div><div>'+esc(inp.description)+'</div>'+(inp.code?'<pre>'+esc(inp.code)+'</pre>':'<div class=dim>code withheld for this focus</div>')+'</div>'
   +'<div><h2>Output</h2><div><b>'+esc(x.stem)+'</b></div>'+(x.options||[]).map((op,j)=>'<div class="opt'+(j+1===x.correct_option?' key':'')+'">'+(j+1)+'. '+esc(op)+(j+1===x.correct_option?' ✓':'')+'<div class=dim>'+esc((x.descriptions||[])[j]||'')+'</div></div>').join('')
   +'<h2>Grade</h2><div>score '+(x.score??0)+' · quality '+esc(JSON.stringify(x.quality||{}))+'</div>'+((x.failed_checks||[]).length?'<div class=worse>'+x.failed_checks.map(esc).join('<br>')+'</div>':'')+'<pre>'+esc(JSON.stringify(x.judge||{},null,1))+'</pre></div></div></td></tr>';
  return h}
function card(r,d){
  const live=r.state==='running'&&d.now-r.updated<120,st=r.state==='running'&&!live?'stale (no update for '+t(d.now-r.updated)+')':r.state,s=sum(r);
  const pct=r.trials_total?Math.min(100,100*r.trials_done/r.trials_total):0,tk=r.tokens||{},err=Object.values(r.errors||{}).reduce((a,b)=>a+b,0),bk=tk.by_kind||{};
  const kinds=Object.entries(r.calls||{}).map(([n,c])=>'<tr><td>'+esc(n)+'</td><td class=n>'+c+' calls</td><td class=n>'+k((bk[n+':input']||0)+(bk[n+':cache_write']||0)+(bk[n+':cache_read']||0))+' in</td><td class=n>'+k(bk[n+':output']||0)+' out</td></tr>').join('');
  const gf=Object.entries(s.gate_failures||{}).map(([g,n])=>'<span class="chip bad">'+esc(g)+' ✗'+n+'</span>').join('')||'<span class=dim>none yet</span>';
  const lg=s.longest||{},lr=x=>x&&x.of?x.keyed_strictly_longest+'/'+x.of:'–';
  const p=r.prompt;
  return '<div class=card><div class=row><b>'+esc(r.label)+'</b><span class="state '+(live?'running':'stopped')+'">'+esc(st)+'</span></div><div class=bar><i style="width:'+pct+'%"></i></div>'
  +'<div class=row><span>'+r.trials_done+' / '+r.trials_total+' trials</span><span>'+r.total_calls+' / '+r.cap+' calls · '+err+' errors</span><span>'+t((live?d.now:r.updated)-r.started)+' of '+r.max_minutes+' min</span></div>'
  +'<div class=row><span><b>'+k(tk.input_total)+'</b> tokens in ('+k(tk.cache_read)+' cached) · <b>'+k(tk.output)+'</b> out</span><span class=dim>~$'+r.cost_usd_list_price+' at list price</span></div>'
  +'<h2>Results so far</h2><div class=row><span><b>'+(s.all_gates_passed??0)+'/'+(s.trials??0)+'</b> pass every gate</span><span>mean score <b>'+(s.mean_score??'–')+'</b></span><span>keyed option strictly longest: label '+lr(lg.label)+' · description '+lr(lg.description)+' · both '+lr(lg.combined)+'</span></div><div>'+gf+'</div>'
  +(p?'<details data-k="'+esc(r.file)+'#diff"'+(open.has(r.file+'#diff')?' open':'')+'><summary>Change under test: '+esc(p.file.split('/').pop())+' · '+p.words+' words (shipped '+p.shipped_words+')</summary><pre>'+diff(p.diff)+'</pre></details>':'')
  +'<details data-k="'+esc(r.file)+'#calls"'+(open.has(r.file+'#calls')?' open':'')+'><summary>Calls and tokens by kind</summary><table>'+kinds+'</table></details>'
  +'<h2>Trials (click a row for the input, the output and the grade)</h2><div class=scroll><table><tr><th>example</th><th>plan</th><th class=n>score</th><th>gates</th><th>words/option</th></tr>'+(r.trials||[]).slice().reverse().map((x,i)=>trial(r,x,(r.trials.length-1-i))).join('')+'</table></div>'
  +'<div class=dim><code>'+esc(r.file)+'</code></div></div>'}
function metrics(r){const s=sum(r),lg=s.longest||{},f=s.gate_failures||{},n=s.trials||0;
  const rate=x=>x&&x.of?x.keyed_strictly_longest/x.of:null;
  return [['trials',n,0],['pass every gate',n?s.all_gates_passed/n:null,1,1],['mean score',s.mean_score,1,1],...GATES.map(g=>['gate ✗ '+g,n?(f[g]||0)/n:null,1,-1]),['keyed longest (label)',rate(lg.label),1,-1],['keyed longest (description)',rate(lg.description),1,-1],['input tokens',inTok(r),0],['cost $',r.cost_usd_list_price,0]]}
function compare(d){
  if(d.runs.length<2)return '';
  const opts=d.runs.map((r,i)=>'<option value='+i+'>'+esc(r.label)+'</option>').join('');
  A=A??Math.max(0,d.runs.findIndex(r=>/baseline/.test(r.label+r.file)));if(A<0)A=d.runs.length-1;B=B??(A===0?1:0);
  const a=d.runs[A],b=d.runs[B],ma=metrics(a),mb=metrics(b);
  const rows=ma.map((m,i)=>{const x=m[1],y=mb[i][1],dir=m[3]||0,f=v=>v==null?'–':(m[2]?(Math.abs(v)<=1&&m[0]!=='mean score'?(100*v).toFixed(0)+'%':v):(m[0]==='input tokens'?k(v):v));
    const dv=x!=null&&y!=null?y-x:null,cl=dv&&dir?(dv*dir>0?'better':'worse'):'';
    return '<tr><td>'+m[0]+'</td><td class=n>'+f(x)+'</td><td class=n>'+f(y)+'</td><td class="n '+cl+'">'+(dv==null?'':(dv>0?'+':'')+(Math.abs(dv)<=1&&m[2]?(100*dv).toFixed(0)+(m[0]==='mean score'?'':' pts'):Math.round(dv*100)/100))+'</td></tr>'}).join('');
  const ea=new Map(),eb=new Map();for(const[ma_,rr]of[[ea,a],[eb,b]])for(const x of rr.trials||[]){const v=ma_.get(x.id)||[];v.push(x.score||0);ma_.set(x.id,v)}
  let w=0,l=0,tie=0;for(const[id,v]of ea){const u=eb.get(id);if(!u)continue;const p=v.reduce((q,z)=>q+z,0)/v.length,q=u.reduce((q,z)=>q+z,0)/u.length;if(Math.abs(q-p)<.005)tie++;else q>p?w++:l++}
  return '<div class=card><div class=row><b>Compare runs</b><span>baseline <select id=selA>'+opts+'</select> vs <select id=selB>'+opts+'</select></span></div>'
   +'<div class=scroll><table><tr><th>metric</th><th class=n>'+esc(a.label)+'</th><th class=n>'+esc(b.label)+'</th><th class=n>change</th></tr>'+rows+'</table></div><div class=dim>per example (same ids in both): second run better on '+w+', worse on '+l+', tied on '+tie+'. Green = better, red = worse; the judge is noisy, so small gaps on ~20 examples are not evidence.</div></div>'}
function render(){
  const d=data;document.getElementById('meta').textContent=d.claude+' claude -p process(es) running now · scanning '+d.root;
  document.getElementById('cmp').innerHTML=compare(d);
  if(document.getElementById('selA')){selA.value=A;selB.value=B;selA.onchange=()=>{A=+selA.value;render()};selB.onchange=()=>{B=+selB.value;render()}}
  document.getElementById('runs').innerHTML=d.runs.length?d.runs.map(r=>card(r,d)).join(''):'<div class="card dim">No progress files under this folder yet. A run started before progress files existed shows only in the process count above.</div>'}
document.addEventListener('click',e=>{const tr=e.target.closest('tr.t'),dt=e.target.closest('summary');const key=tr?tr.dataset.k:dt?dt.parentElement.dataset.k:null;if(!key)return;
  if(dt){setTimeout(()=>{dt.parentElement.open?open.add(key):open.delete(key);save()});return}
  open.has(key)?open.delete(key):open.add(key);save();render()});
async function tick(){
  let txt;try{txt=await (await fetch('/api')).text()}catch{document.getElementById('meta').textContent='server not reachable';return}
  const d=JSON.parse(txt);const sig=JSON.stringify({...d,now:Math.floor(d.now/30)});if(sig===last)return;last=sig;data=d;render()}
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
