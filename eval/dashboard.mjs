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

const page = `<!doctype html><html lang=en data-mode=ink><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Eval runs</title>
<script>try{var m=localStorage.getItem('mode');if(m==='paper')document.documentElement.dataset.mode=m}catch(e){}</script>
<style>
/* Role tokens copied from web/public/tokens.css (ink is the default ground, paper the alternate). */
:root,:root[data-mode=ink]{--bg:#17171a;--panel:#1e1e22;--mass:#26262a;--ink:#EAE7E1;--dim:#A29C93;--faint:#8B857B;--line:#26262a;--line-2:#33333a;--spot:#79D5C4;--spot-ink:#17171a;--spot-soft:color-mix(in srgb,var(--spot) 14%,transparent);--warning:#E8920C;--warning-soft:color-mix(in srgb,var(--warning) 14%,transparent);--error:#FF6166;--error-soft:color-mix(in srgb,var(--error) 12%,transparent);--code-bg:var(--mass);--ring:0 0 0 2px var(--bg),0 0 0 4px var(--spot)}
:root[data-mode=paper]{--bg:#f0ede6;--panel:#e7e3da;--mass:#ddd8cc;--ink:#16150f;--dim:#57534a;--faint:#635E52;--line:#e3dfd4;--line-2:#cec8b9;--spot:#0A5751;--spot-ink:#ffffff;--spot-soft:color-mix(in srgb,var(--spot) 10%,transparent);--warning:#7A4B00;--warning-soft:color-mix(in srgb,var(--warning) 10%,transparent);--error:#A8201A;--error-soft:color-mix(in srgb,var(--error) 12%,transparent);--code-bg:#EDEAE2}
:root{--font-disp:'Archivo',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;--font-body:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,sans-serif;--font-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--ease:cubic-bezier(.2,.6,.2,1);--tracking-caps:.16em}
*{box-sizing:border-box;border-radius:0}
html{background:var(--bg)}
body{margin:0;padding:24px 16px 64px;background:var(--bg);color:var(--ink);font:14.5px/1.55 var(--font-body);max-width:1240px;margin-inline:auto;overflow-wrap:anywhere}
button{font:inherit;color:inherit}
:focus-visible{outline:none;box-shadow:var(--ring)}
.mono,.n,code,pre,table,.mk{font-family:var(--font-mono)}
.n{text-align:right;font-variant-numeric:tabular-nums}
.mk{font-size:11px;text-transform:uppercase;letter-spacing:var(--tracking-caps);color:var(--faint)}
.dim{color:var(--dim)}
/* header */
header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:24px}
h1{font:900 30px/1.1 var(--font-disp);letter-spacing:-.045em;margin:0 0 6px}
#meta{color:var(--dim);font-size:13px}#meta b{color:var(--ink);font-weight:600}
.btn{flex:none;white-space:nowrap;background:var(--panel);border:1px solid var(--line-2);padding:6px 12px;font:500 12px/16px var(--font-mono);cursor:pointer;transition:border-color .14s var(--ease),color .14s var(--ease),background .14s var(--ease)}
.btn:hover{border-color:var(--spot);color:var(--spot)}
.btn[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.bar-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--faint);margin-right:6px;vertical-align:1px}.dot.on{background:var(--spot);animation:pulse 1.6s var(--ease) infinite}
@keyframes pulse{50%{opacity:.35}}
/* runs list */
.rh,.rs{display:grid;grid-template-columns:128px minmax(0,1fr) 150px 84px 72px 76px 84px;gap:16px;align-items:center}
.rh{padding:0 16px 6px}
.run{border:1px solid var(--line-2);background:var(--panel);margin:0 0 8px}
.rs{width:100%;text-align:left;background:transparent;border:0;padding:12px 16px;cursor:pointer;transition:background .14s var(--ease)}
.rs:hover{background:var(--mass)}.rs:focus-visible{box-shadow:inset 0 0 0 2px var(--spot)}
.lab{display:flex;gap:8px;align-items:flex-start;min-width:0;font-weight:600;font-size:15px}
.lab svg{flex:none;margin-top:3px;transition:transform .14s var(--ease)}
[aria-expanded=true]>.lab svg{transform:rotate(90deg)}
.c.n{font-size:13px}
.c::before{content:attr(data-l);display:none}
.badge{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line-2);padding:2px 8px;font:600 11px/16px var(--font-mono);text-transform:uppercase;letter-spacing:.08em;white-space:nowrap;width:max-content}
.badge.running{color:var(--spot);border-color:var(--spot);background:var(--spot-soft)}
.badge.done{color:var(--dim)}
.badge.stopped{color:var(--warning);border-color:var(--warning);background:var(--warning-soft)}
.prog{display:flex;align-items:center;gap:8px}.prog .t{flex:1;height:6px;background:var(--mass);min-width:40px}.prog i{display:block;height:100%;background:var(--spot)}.prog.stopped i{background:var(--warning)}
.prog span{font:12px var(--font-mono);font-variant-numeric:tabular-nums;color:var(--dim);min-width:48px;text-align:right}
.detail{border-top:1px solid var(--line-2);padding:16px;background:var(--bg)}
.detail h3{font:600 11px/16px var(--font-mono);text-transform:uppercase;letter-spacing:var(--tracking-caps);color:var(--faint);margin:20px 0 8px}.detail h3:first-child{margin-top:0}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin:0}
.stats>div{background:var(--panel);border:1px solid var(--line-2);padding:8px 12px}
.stats dt{font:11px/16px var(--font-mono);text-transform:uppercase;letter-spacing:var(--tracking-caps);color:var(--faint)}
.stats dd{margin:0;font:600 15px/22px var(--font-mono);font-variant-numeric:tabular-nums}.stats dd small{font:400 12px var(--font-mono);color:var(--dim)}
.chip{display:inline-block;border:1px solid var(--line-2);padding:0 8px;margin:0 4px 4px 0;font:12px/20px var(--font-mono);white-space:nowrap}
.chip.bad{color:var(--error);border-color:var(--error);background:var(--error-soft)}.chip.ok{color:var(--spot);border-color:var(--spot)}
/* tables */
.scroll{overflow-x:auto;border:1px solid var(--line-2);background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:12.5px;min-width:520px}
th,td{text-align:left;padding:7px 12px;vertical-align:top;border-top:1px solid var(--line)}
th{font:500 11px/16px var(--font-mono);text-transform:uppercase;letter-spacing:var(--tracking-caps);color:var(--faint);border-top:0;background:var(--panel);white-space:nowrap}
td.n,th.n{text-align:right}
tr.t>td{padding:0}tr.t>td>.tb,tr.t>td>.tc{padding:7px 12px}tr.t>td>.tc{white-space:nowrap}
.tb{display:flex;gap:8px;width:100%;background:transparent;border:0;text-align:left;cursor:pointer;font:inherit}.tb:hover{color:var(--spot)}
.tb:focus-visible{box-shadow:inset 0 0 0 2px var(--spot)}
tr.x>td{background:var(--bg);padding:16px}
.better{color:var(--spot)}.worse{color:var(--error)}
td.s{font-weight:600}
code,pre{font-size:12px;line-height:1.5}
pre{margin:4px 0;white-space:pre-wrap;background:var(--code-bg);border:1px solid var(--line-2);padding:10px;max-height:260px;overflow:auto}
.add{background:var(--spot-soft)}.del{background:var(--error-soft)}
details{margin:8px 0}summary{cursor:pointer;color:var(--dim);padding:4px 0}summary:hover{color:var(--spot)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.opt{padding:3px 0}.opt.key{color:var(--spot);font-weight:600}
select{background:var(--panel);color:var(--ink);border:1px solid var(--line-2);padding:4px 8px;font:12px var(--font-mono);max-width:100%}
.cmp{border:1px solid var(--line-2);background:var(--panel);padding:0 16px;margin:0 0 24px}.cmp>summary{padding:12px 0;color:var(--ink);font-weight:600}
.sel{display:flex;gap:8px 16px;flex-wrap:wrap;align-items:center;margin:0 0 12px}
.empty{border:1px solid var(--line-2);background:var(--panel);padding:32px 24px}.empty b{display:block;font:900 22px/1.2 var(--font-disp);letter-spacing:-.03em;margin:6px 0 8px}
.foot{margin-top:16px;color:var(--faint);font-size:12px}
@media(max-width:900px){.rh{display:none}
 .rs{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}.rs .lab{flex:1 1 calc(100% - 140px)}.rs .prog{flex:1 1 100%;order:3}
 .rs .c.n{display:flex;gap:6px;align-items:baseline;order:4}.c::before{display:inline;font:11px var(--font-mono);text-transform:uppercase;letter-spacing:.08em;color:var(--faint)}
 .cols{grid-template-columns:1fr}}
@media(max-width:520px){header{flex-direction:column}h1{font-size:26px}.rs .lab{flex-basis:100%}.rs .badge{order:-1}.detail{padding:12px}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
<body>
<header><div><h1>Eval runs</h1><div id=meta>Loading…</div></div><button class=btn id=mode type=button></button></header>
<div id=cmp></div><div class=bar-tools id=tools></div><div id=runs></div>
<script>
const k=n=>n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?Math.round(n/1e3)+'k':String(Math.round(n||0));
const t=s=>{s=Math.max(0,Math.round(s));const m=Math.floor(s/60);return m>=60?Math.floor(m/60)+'h '+(m%60)+'m':m+'m '+(s%60)+'s'};
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const GATES=['structure','rationale_free','key_correct','single_answer','cold_answerable','tier_match'];
const CHEV='<svg width=16 height=16 viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=2 stroke-linecap=round stroke-linejoin=round aria-hidden=true><path d="m9 18 6-6-6-6"/></svg>';
const open=new Set(JSON.parse(sessionStorage.getItem('open')||'[]'));let last='',data=null,A=null,B=null;
const save=()=>sessionStorage.setItem('open',JSON.stringify([...open]));
const sum=r=>r.summary||{};
const inTok=r=>(r.tokens||{}).input_total||0;
const failing=()=>location.hash==='#failing';
const fx=(v,d)=>v==null?'–':Number(v).toFixed(d);
const usd=v=>v==null?'–':'$'+Number(v).toFixed(2);
function diff(d){return d?d.split('\\n').map(l=>'<div class="'+(l[0]==='+'&&l[1]!=='+'?'add':l[0]==='-'&&l[1]!=='-'?'del':'')+'">'+esc(l)+'</div>').join(''):'<span class=dim>no change from the shipped prompt (this is the baseline)</span>'}
const chips=x=>x.gates_failed&&x.gates_failed.length?x.gates_failed.map(g=>'<span class="chip bad">fail '+esc(g)+'</span>').join(''):'<span class="chip ok">all gates pass</span>';
function trial(r,x,i){
  const key=r.file+'#'+i,o=open.has(key),inp=x.input||{},q=x.stem!==undefined;
  const plan=q?'t'+x.tier+' · '+esc(x.focus)+' · slot '+x.answer_position:x.candidate?'candidate '+esc(x.candidate):x.repeat!=null?'repeat '+x.repeat:'';
  let h='<tr class=t><td><button class=tb type=button data-k="'+esc(key)+'" aria-expanded='+o+'><span aria-hidden=true>'+(o?'▾':'▸')+'</span><span>'+esc(q?x.group:x.id)+'</span></button></td><td><div class=tc>'+plan+'</div></td><td class="n s"><div class=tc>'+fx(x.score??0,2)+'</div></td><td><div class=tc>'+chips(x)+'</div></td></tr>';
  if(!o)return h;
  const rest={...x};for(const n of['id','repeat','score','gates_failed','error','quality','candidate'])delete rest[n];
  const grade='<h3>Grade</h3><div>score '+(x.score??0)+' · quality '+esc(JSON.stringify(x.quality||{}))+'</div>'+(x.error?'<div class=worse>'+esc(x.error)+'</div>':'')+((x.failed_checks||[]).length?'<div class=worse>'+x.failed_checks.map(esc).join('<br>')+'</div>':'');
  return h+'<tr class=x><td colspan=4>'+(q?'<div class=cols><div><h3>Input</h3><div class=dim>'+esc(inp.concept)+' · '+esc(inp.source)+'</div><div>'+esc(inp.description)+'</div>'+(inp.code?'<pre>'+esc(inp.code)+'</pre>':'<div class=dim>code withheld for this focus</div>')+'</div>'
   +'<div><h3>Output</h3><div><b>'+esc(x.stem)+'</b></div>'+(x.options||[]).map((op,j)=>'<div class="opt'+(j+1===x.correct_option?' key':'')+'">'+(j+1)+'. '+esc(op)+(j+1===x.correct_option?' (key)':'')+'<div class=dim>'+esc((x.descriptions||[])[j]||'')+'</div></div>').join('')
   +grade+'<pre>'+esc(JSON.stringify(x.judge||{},null,1))+'</pre></div></div>':grade+'<pre>'+esc(JSON.stringify(rest,null,1))+'</pre>')+'</td></tr>'}
function state(r,d){
  const live=r.state==='running'&&d.now-r.updated<120;
  if(live)return{live,cls:'running',txt:'Running',dot:1};
  if(r.state==='running')return{live,cls:'stopped',txt:'Stale'};
  return r.state==='done'?{live,cls:'done',txt:'Done'}:{live,cls:'stopped',txt:r.state==='stopped early'?'Stopped early':String(r.state||'Unknown')}}
function row(r,d){
  const s=sum(r),st=state(r,d),o=open.has(r.file+'#run'),pct=r.trials_total?Math.min(100,100*r.trials_done/r.trials_total):0;
  return '<button class=rs type=button data-k="'+esc(r.file+'#run')+'" aria-expanded='+o+'>'
   +'<span class="c"><span class="badge '+st.cls+'">'+(st.dot?'<span class="dot on" style="margin:0"></span>':'')+st.txt+'</span></span>'
   +'<span class=lab>'+CHEV+'<span>'+esc(r.label)+'</span></span>'
   +'<span class="prog '+st.cls+'"><span class=t><i style="width:'+pct+'%"></i></span><span>'+r.trials_done+'/'+r.trials_total+'</span></span>'
   +'<span class="c n" data-l="pass">'+(s.all_gates_passed??0)+'/'+(s.trials??0)+'</span>'
   +'<span class="c n" data-l="score">'+fx(s.mean_score,2)+'</span>'
   +'<span class="c n" data-l="cost">'+usd(r.cost_usd_list_price)+'</span>'
   +'<span class="c n" data-l="time">'+t((st.live?d.now:r.updated)-r.started)+'</span></button>'}
function detail(r,d){
  const s=sum(r),tk=r.tokens||{},err=Object.values(r.errors||{}).reduce((a,b)=>a+b,0),bk=tk.by_kind||{},st=state(r,d),p=r.prompt;
  const kinds=Object.entries(r.calls||{}).map(([n,c])=>'<tr><td>'+esc(n)+'</td><td class=n>'+c+'</td><td class=n>'+k((bk[n+':input']||0)+(bk[n+':cache_write']||0)+(bk[n+':cache_read']||0))+'</td><td class=n>'+k(bk[n+':output']||0)+'</td></tr>').join('');
  const gf=Object.entries(s.gate_failures||{}).map(([g,n])=>'<span class="chip bad">'+esc(g)+' ×'+n+'</span>').join('')||'<span class=dim>none yet</span>';
  const lg=s.longest||{},lr=x=>x&&x.of?x.keyed_strictly_longest+'/'+x.of:null;
  const lon=[['label',lr(lg.label)],['description',lr(lg.description)],['both',lr(lg.combined)]].filter(a=>a[1]);
  const sj=Object.entries(s.second_judge||{}).map(([g,v])=>'<tr><td>'+esc(g)+'</td><td class=n>'+v.claude_pass+'/'+v.of+'</td><td class=n>'+v.azure_pass+'/'+v.of+'</td><td class=n>'+v.agree+'/'+v.of+'</td></tr>').join('');
  const models=Object.entries(r.models||(r.budget||{}).models||{}).map(([n,m])=>esc(n)+': '+esc((m||[]).join(', '))).join(' · ');
  const all=r.trials||[],shown=all.map((x,i)=>[x,i]).filter(a=>!failing()||(a[0].gates_failed||[]).length||a[0].error).reverse();
  const stat=(l,v)=>'<div><dt>'+l+'</dt><dd>'+v+'</dd></div>';
  return '<div class=detail><h3>Run</h3><dl class=stats>'
   +stat('Calls',r.total_calls+' <small>/ '+r.cap+' cap</small>')+stat('Errors',err)+stat('Tokens in',k(tk.input_total)+' <small>'+k(tk.cache_read)+' cached</small>')+stat('Tokens out',k(tk.output))
   +stat('Cost',usd(r.cost_usd_list_price)+' <small>list price</small>')+stat('Time',t((st.live?d.now:r.updated)-r.started)+' <small>of '+r.max_minutes+' min</small>')
   +(s.mean_score_finished_only!=null?stat('Score, finished only',fx(s.mean_score_finished_only,2)):'')+(s.mean_score_when_valid!=null?stat('Score, valid only',fx(s.mean_score_when_valid,2)):'')+'</dl>'
   +(models?'<div class="dim" style="margin-top:8px">Models · '+models+'</div>':'')
   +'<h3>Gate failures</h3><div>'+gf+'</div>'
   +(lon.length?'<h3>Keyed option strictly longest</h3><div>'+lon.map(a=>'<span class=chip>'+a[0]+' '+a[1]+'</span>').join('')+'</div>':'')
   +(sj?'<h3>Second judge agreement</h3><div class=scroll><table><tr><th>gate</th><th class=n>claude pass</th><th class=n>azure pass</th><th class=n>agree</th></tr>'+sj+'</table></div>':'')
   +(p?'<details data-k="'+esc(r.file)+'#diff"'+(open.has(r.file+'#diff')?' open':'')+'><summary>Change under test: '+esc(p.file.split('/').pop())+' · '+p.words+' words (shipped '+p.shipped_words+')</summary><pre>'+diff(p.diff)+'</pre></details>':'')
   +'<details data-k="'+esc(r.file)+'#calls"'+(open.has(r.file+'#calls')?' open':'')+'><summary>Calls and tokens by kind</summary><div class=scroll><table><tr><th>kind</th><th class=n>calls</th><th class=n>in</th><th class=n>out</th></tr>'+kinds+'</table></div></details>'
   +'<h3>Trials · '+shown.length+(failing()?' failing of '+all.length:'')+' (select a row for input, output and grade)</h3>'
   +(shown.length?'<div class=scroll><table><tr><th>example</th><th>plan</th><th class=n>score</th><th>gates</th></tr>'+shown.map(a=>trial(r,a[0],a[1])).join('')+'</table></div>':'<div class=dim>No failing trials.</div>')
   +'<div class=foot><code>'+esc(r.file)+'</code></div></div>'}
function card(r,d){return '<div class=run>'+row(r,d)+(open.has(r.file+'#run')?detail(r,d):'')+'</div>'}
function metrics(r){const s=sum(r),lg=s.longest||{},f=s.gate_failures||{},n=s.trials||0;
  const rate=x=>x&&x.of?x.keyed_strictly_longest/x.of:null;
  return [['trials',n,0],['pass every gate',n?s.all_gates_passed/n:null,1,1],['mean score',s.mean_score,1,1],...Object.keys(f).length?Object.keys(f).map(g=>['gate fail '+g,n?(f[g]||0)/n:null,1,-1]):GATES.map(g=>['gate fail '+g,n?(f[g]||0)/n:null,1,-1]),['keyed longest (label)',rate(lg.label),1,-1],['keyed longest (description)',rate(lg.description),1,-1],['input tokens',inTok(r),0],['cost $',r.cost_usd_list_price,0]]}
function compare(d){
  if(d.runs.length<2)return '';
  const opts=d.runs.map((r,i)=>'<option value='+i+'>'+esc(r.label)+'</option>').join('');
  A=A??Math.max(0,d.runs.findIndex(r=>/baseline/.test(r.label+r.file)));if(A<0)A=d.runs.length-1;B=B??(A===0?1:0);
  const a=d.runs[A],b=d.runs[B],ma=metrics(a),mb=metrics(b),mapB=new Map(mb.map(m=>[m[0],m[1]]));
  const rows=ma.map(m=>{const x=m[1],y=mapB.get(m[0])??null,dir=m[3]||0,f=v=>v==null?'–':(m[2]?(Math.abs(v)<=1&&m[0]!=='mean score'?(100*v).toFixed(0)+'%':v):(m[0]==='input tokens'?k(v):v));
    const dv=x!=null&&y!=null?y-x:null,cl=dv&&dir?(dv*dir>0?'better':'worse'):'';
    return '<tr><td>'+esc(m[0])+'</td><td class=n>'+f(x)+'</td><td class=n>'+f(y)+'</td><td class="n '+cl+'">'+(dv==null?'':(dv>0?'+':'')+(Math.abs(dv)<=1&&m[2]?(100*dv).toFixed(0)+(m[0]==='mean score'?'':' pts'):Math.round(dv*100)/100))+'</td></tr>'}).join('');
  const ea=new Map(),eb=new Map();for(const[ma_,rr]of[[ea,a],[eb,b]])for(const x of rr.trials||[]){const v=ma_.get(x.id)||[];v.push(x.score||0);ma_.set(x.id,v)}
  let w=0,l=0,tie=0;for(const[id,v]of ea){const u=eb.get(id);if(!u)continue;const p=v.reduce((q,z)=>q+z,0)/v.length,q=u.reduce((q,z)=>q+z,0)/u.length;if(Math.abs(q-p)<.005)tie++;else q>p?w++:l++}
  return '<details class=cmp data-k="cmp"'+(open.has('cmp')?' open':'')+'><summary>Compare two runs</summary><div class=sel><label>Baseline <select id=selA>'+opts+'</select></label><label>Candidate <select id=selB>'+opts+'</select></label></div>'
   +'<div class=scroll><table><tr><th>metric</th><th class=n>'+esc(a.label)+'</th><th class=n>'+esc(b.label)+'</th><th class=n>change</th></tr>'+rows+'</table></div><p class=dim>Per example (same ids in both): the candidate is better on '+w+', worse on '+l+', tied on '+tie+'. Teal is better, red is worse. The judge is noisy, so small gaps on about 20 examples are not evidence.</p></details>'}
function render(){
  const d=data,ae=document.activeElement,fk=ae&&(ae.dataset.k||ae.id),y=scrollY;
  document.getElementById('meta').innerHTML='<span class="dot'+(d.claude?' on':'')+'"></span><b>'+d.claude+'</b> claude -p process'+(d.claude===1?'':'es')+' running now · scanning <code>'+esc(d.root)+'</code>';
  document.getElementById('cmp').innerHTML=compare(d);
  document.getElementById('tools').innerHTML=d.runs.length?'<button class=btn type=button id=fl aria-pressed='+failing()+'>Failing trials only</button><span class="mk">'+d.runs.length+' run'+(d.runs.length===1?'':'s')+', newest first</span>':'';
  if(document.getElementById('selA')){selA.value=A;selB.value=B;selA.onchange=()=>{A=+selA.value;render()};selB.onchange=()=>{B=+selB.value;render()}}
  document.getElementById('runs').innerHTML=d.runs.length?'<div class=rh aria-hidden=true><span class=mk>State</span><span class=mk>Run</span><span class=mk>Trials</span><span class="mk n">Pass</span><span class="mk n">Score</span><span class="mk n">Cost</span><span class="mk n">Time</span></div>'+d.runs.map(r=>card(r,d)).join(''):'<div class=empty><span class=mk>No runs yet</span><b>Nothing to show here.</b><div class=dim>This page lists every <code>progress.json</code> or <code>*.progress.json</code> found under the folder above. Start a GEPA run (it writes one) and it appears within three seconds. A run that predates progress files shows only in the process count.</div></div>';
  if(fk){const el=document.querySelector('[data-k="'+(window.CSS&&CSS.escape?CSS.escape(fk):fk)+'"],#'+fk.replace(/[^\w-]/g,''));if(el&&el.focus)el.focus({preventScroll:true})}
  scrollTo(0,y)}
function mode(){const m=document.documentElement.dataset.mode,b=document.getElementById('mode');b.textContent=m==='paper'?'Ink ground':'Paper ground';b.setAttribute('aria-label','Switch to the '+(m==='paper'?'ink':'paper')+' ground')}
document.getElementById('mode').onclick=()=>{const h=document.documentElement,m=h.dataset.mode==='paper'?'ink':'paper';h.dataset.mode=m;try{localStorage.setItem('mode',m)}catch(e){}mode()};mode();
document.addEventListener('click',e=>{
  if(e.target.closest('#fl')){location.hash=failing()?'':'failing';return}
  const b=e.target.closest('button[data-k]');if(!b)return;const key=b.dataset.k;
  open.has(key)?open.delete(key):open.add(key);save();render()});
document.addEventListener('toggle',e=>{const dt=e.target;if(!dt.dataset||!dt.dataset.k)return;dt.open?open.add(dt.dataset.k):open.delete(dt.dataset.k);save()},true);
addEventListener('hashchange',()=>data&&render());
async function tick(){
  let txt;try{txt=await (await fetch('/api')).text()}catch{document.getElementById('meta').textContent='Server not reachable';return}
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
