// Deterministic SVG exports from the same artwork and tokens as live components.
import fs from 'node:fs/promises';
import vm from 'node:vm';
const base = new URL('../web/public/brand/mascot/', import.meta.url);
const context = vm.createContext({});
vm.runInContext(await fs.readFile(new URL('mascot.js', base), 'utf8'), context);
const mascot = context.EklavyaMascot;
const css = await fs.readFile(new URL('mascot.css', base), 'utf8');
const tokens = await fs.readFile(new URL('../web/public/tokens.css', import.meta.url), 'utf8');
const palette = tokens.match(/\/\* ---------- MASCOT IDENTITY ----------[\s\S]*?\/\* ---------- END MASCOT IDENTITY ---------- \*\//)?.[0];
if (!palette) throw new Error('Missing mascot identity roles in tokens.css');
const style = `<style>:root {${palette}}${css}</style>`;
const exports = new Map();
for (const [expression, label] of Object.entries(mascot.expressions)) {
  for (const variant of ['body', 'face']) {
    const svg = mascot.svg({ expression, variant, size:200, label:`Eklavya, ${label.toLowerCase()}` });
    exports.set(`expressions/${expression}-${variant}.svg`, svg.replace('><title>', `>${style}<title>`));
  }
}
exports.set('loading.svg', mascot.svg({ state:'loading', variant:'loading', size:200, label:'Eklavya drawing a bow' }).replace('><title>', `>${style}<title>`));
if (process.argv.includes('--check')) {
  for (const [file, expected] of exports) {
    const actual = await fs.readFile(new URL(file, base), 'utf8').catch(() => null);
    if (actual !== expected) throw new Error(`Stale mascot export: ${file}. Run npm run mascot:generate.`);
  }
  for (const file of await fs.readdir(new URL('expressions/', base))) {
    if (file.endsWith('.svg') && !exports.has(`expressions/${file}`)) throw new Error(`Unexpected mascot export: ${file}`);
  }
  console.log('Mascot exports match the shared artwork, motion and tokens.');
} else {
  await fs.mkdir(new URL('expressions/', base), {recursive:true});
  for (const file of await fs.readdir(new URL('expressions/', base))) {
    if (file.endsWith('.svg') && !exports.has(`expressions/${file}`)) await fs.unlink(new URL(`expressions/${file}`,base));
  }
  for (const [file, svg] of exports) await fs.writeFile(new URL(file,base),svg);
  console.log(`Exported ${Object.keys(mascot.expressions).length} expressions (body + face) and the loader.`);
}
