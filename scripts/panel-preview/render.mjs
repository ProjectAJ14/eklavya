// Turns the trees scenes.ts printed into one HTML page that draws them the way
// Claude Code Desktop appears to. This is an approximation calibrated from
// screenshots (2026-10-16), not Desktop's own renderer: how a Desktop Button
// treats long text is a toggle on the page, because that is the unknown.
import fs from 'node:fs'

const [input, output] = process.argv.slice(2)
const scenes = fs
  .readFileSync(input, 'utf8')
  .split('\n')
  .filter(l => l.startsWith('@@SCENE '))
  .map(l => JSON.parse(l.slice('@@SCENE '.length)))
if (!scenes.length) throw new Error('no scenes were printed; see the test output above')

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Panel Preview</title>
<style>
:root { --bg:#1f1e1d; --pane:#262624; --ink:#ececec; --dim:#9a9a96; --line:#cfcfcf; --chip:#3a3a38; --code:#33332f; --target:rgba(255,80,80,.18); }
:root[data-theme="light"] { --bg:#eeede9; --pane:#faf9f5; --ink:#1f1e1d; --dim:#6b6a66; --line:#8a8985; --chip:#e4e2dc; --code:#ebe9e3; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.45 -apple-system, system-ui, 'Segoe UI', sans-serif; }
header { position:sticky; top:0; z-index:2; background:var(--bg); padding:12px 16px; display:flex; flex-wrap:wrap; gap:16px; align-items:center; border-bottom:1px solid #444; }
header h1 { font-size:15px; margin:0 8px 0 0; }
header label { display:flex; gap:6px; align-items:center; }
main { display:flex; flex-wrap:wrap; gap:24px; padding:16px; }
figure { margin:0; }
figcaption { color:var(--dim); margin-bottom:6px; }
.pane { width:var(--w); max-width:calc(100vw - 32px); background:var(--pane); border:1px solid #555; border-radius:10px; padding:12px 10px; overflow:hidden; box-sizing:border-box; }
.box { display:flex; min-width:0; box-sizing:border-box; }
.t { white-space:pre-wrap; }
.btn { font:inherit; color:inherit; border:0; cursor:pointer; display:inline-flex; align-items:center; gap:8px; border-radius:7px; padding:5px 10px; background:var(--chip); }
.btn.primary { background:#fff; color:#111; }
.btn.dim { opacity:.65; }
.btn.plain { background:none; padding:0; display:flex; align-items:flex-start; width:100%; text-align:left; border-radius:0; }
.btn.plain .lbl { flex:1; min-width:0; }
.cut .btn.plain .lbl, .cut .btn.plain .lbl .t { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cut .btn.plain .lbl .t br { display:none; }
.kbd { display:inline-flex; align-items:center; justify-content:center; min-width:20px; height:20px; border:1px solid #777; border-radius:4px; font-size:12px; color:var(--dim); flex:none; }
.targets .btn { outline:2px dashed #ff5050; outline-offset:-2px; background-image:linear-gradient(var(--target),var(--target)); }
.md p, .md h3 { margin:0 0 .4em; } .md :last-child { margin-bottom:0; }
.md h3 { font-size:1.2em; line-height:1.35; }
code { font-family:ui-monospace, Menlo, monospace; font-size:.92em; background:var(--code); padding:1px 4px; border-radius:4px; }
input.in { font:inherit; color:inherit; background:transparent; border:1px solid #777; border-radius:6px; padding:5px 8px; width:100%; box-sizing:border-box; }
</style></head>
<body>
<header>
  <h1>Eklavya panel preview (Desktop, approximated)</h1>
  <label>Panel width <input id="w" type="range" min="320" max="900" value="540"><span id="wv">540px</span></label>
  <label><input id="cut" type="checkbox" checked> Button text on one line, cut off (as Desktop drew it on 16 Oct)</label>
  <label><input id="tg" type="checkbox"> Show click targets</label>
  <label><input id="lt" type="checkbox"> Light theme</label>
</header>
<main id="main"></main>
<script>
const SCENES = ${JSON.stringify(scenes).replace(/</g, '\\u003c')};
const X = 7.6, Y = 15.2, S = 10; // width/height units, spacing units (px), from the screenshots
const THEME = { inactive:'var(--line)', suggestion:'#7fd88f', error:'#ff7b86', warning:'#f5c060', text:'var(--ink)' };
const col = c => (c && THEME[c]) || c;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[c]);
function inline(s) {
  return esc(s).replace(/\`([^\`]+)\`/g, '<code>$1</code>').replace(/\\*\\*(.+?)\\*\\*(?!\\*)/g, '<b>$1</b>').replace(/\\*([^*]+)\\*/g, '<i>$1</i>');
}
function md(text) {
  return text.split(/\\n{2,}/).map(p => p.startsWith('### ') ? '<h3>' + inline(p.slice(4)) + '</h3>' : '<p>' + inline(p).replace(/\\n/g, '<br>') + '</p>').join('');
}
const sp = v => (typeof v === 'number' ? v * S + 'px' : v === undefined ? undefined : '8px');
function textStyle(p) {
  const s = [];
  if (p.color) s.push('color:' + col(p.color));
  if (p.backgroundColor) s.push('background:' + col(p.backgroundColor) + ';border-radius:3px');
  if (p.bold || p.weight === 'bold' || p.weight === 'semibold') s.push('font-weight:600');
  if (p.italic) s.push('font-style:italic');
  if (p.dimColor) s.push('opacity:.6');
  return s.join(';');
}
const textOf = c => (typeof c === 'string' ? esc(c).replace(/\\n/g, '<br>') : node(c));
function node(n) {
  if (n == null || n === false) return '';
  if (typeof n === 'string') return '<span class="t">' + esc(n) + '</span>';
  const p = n.props || {}, kids = (n.children || []);
  if (n.type === 'Text') return '<span class="t" style="' + textStyle(p) + '">' + kids.map(textOf).join('') + '</span>';
  if (n.type === 'Markdown') return '<div class="md"' + (p.dimColor ? ' style="opacity:.6"' : '') + '>' + md(p.text) + '</div>';
  if (n.type === 'Input') return '<input class="in" placeholder="' + esc(p.placeholder || '') + '" value="' + esc(p.value || '') + '">';
  if (n.type === 'Button') {
    if (p.role === 'dismiss') return '<button class="btn">' + esc(p.label) + '</button>';
    const cls = ['btn', p.plain ? 'plain' : '', p.variant === 'primary' ? 'primary' : '', p.dimColor ? 'dim' : ''].join(' ');
    const label = kids.length ? kids.map(textOf).join('') : esc(p.label);
    const key = p.hotkey ? '<span class="kbd">' + esc(p.hotkey.toUpperCase()) + '</span>' : '';
    return p.plain
      ? '<button class="' + cls + '" title="' + esc(p.key) + '">' + key + '<span class="lbl">' + label + '</span></button>'
      : '<button class="' + cls + '" title="' + esc(p.key) + '"><span class="lbl">' + label + '</span>' + key + '</button>';
  }
  // Box
  const s = ['flex-direction:' + (p.flexDirection || 'row')];
  const px = (k, css, unit) => { if (p[k] !== undefined) s.push(css + ':' + (typeof p[k] === 'number' ? p[k] * unit + 'px' : p[k])); };
  px('width', 'width', X); px('height', 'height', Y); px('minWidth', 'min-width', X);
  if (p.gap !== undefined) s.push('gap:' + sp(p.gap));
  for (const [k, css] of [['padding','padding'],['paddingTop','padding-top'],['paddingBottom','padding-bottom'],['paddingLeft','padding-left'],['paddingRight','padding-right'],['marginTop','margin-top'],['marginBottom','margin-bottom']]) if (p[k] !== undefined) s.push(css + ':' + sp(p[k]));
  if (p.paddingX !== undefined) s.push('padding-left:' + sp(p.paddingX) + ';padding-right:' + sp(p.paddingX));
  if (p.paddingY !== undefined) s.push('padding-top:' + sp(p.paddingY) + ';padding-bottom:' + sp(p.paddingY));
  if (p.alignItems) s.push('align-items:' + p.alignItems);
  if (p.flexShrink !== undefined) s.push('flex-shrink:' + p.flexShrink);
  if (p.flexGrow !== undefined) s.push('flex-grow:' + p.flexGrow);
  if (p.flexWrap) s.push('flex-wrap:' + p.flexWrap);
  if (p.backgroundColor) s.push('background:' + col(p.backgroundColor));
  if (p.borderStyle) s.push('border:' + (p.borderStyle === 'bold' ? 2 : 1) + 'px solid ' + (col(p.borderColor) || 'var(--line)') + ';border-radius:8px');
  if (p.display === 'none') s.push('display:none');
  return '<div class="box" style="' + s.join(';') + '">' + kids.map(node).join('') + '</div>';
}
const main = document.getElementById('main');
main.innerHTML = SCENES.map(sc => '<figure><figcaption>' + esc(sc.name) + '</figcaption><div class="pane">' + node(sc.tree) + '</div></figure>').join('');
const $ = id => document.getElementById(id);
function apply() {
  document.body.style.setProperty('--w', $('w').value + 'px'); $('wv').textContent = $('w').value + 'px';
  main.classList.toggle('cut', $('cut').checked); main.classList.toggle('targets', $('tg').checked);
  document.documentElement.dataset.theme = $('lt').checked ? 'light' : 'dark';
}
for (const id of ['w', 'cut', 'tg', 'lt']) $(id).addEventListener('input', apply);
apply();
</script>
</body></html>`
fs.writeFileSync(output, page)
console.log(`${scenes.length} scenes -> ${output}`)
