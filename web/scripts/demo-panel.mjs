/** Keep the browser replay's labels and text logo tied to the shipped Claude Code mod. */
import { readFile, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../../hooks/panel/model.ts', import.meta.url), 'utf8');
function literal(name, end) {
  const match = source.match(new RegExp(`export const ${name} = ([\\s\\S]*?) ${end}`));
  if (!match) throw new Error(`The panel demo could not find ${name} in hooks/panel/model.ts`);
  // These are trusted, literal-only constants from this repository, never remote or learner input.
  return runInNewContext(`(${match[1]})`, Object.create(null), { timeout: 100 });
}
const strings = literal('STR', 'as const');
const grid = literal('LOGO_GRID', 'as const');
const paletteMatch = source.match(/export const LOGO_PALETTE: Record<string, string> = (\{[^\n]+\})/);
if (!paletteMatch) throw new Error('The panel demo could not find LOGO_PALETTE');
const palette = runInNewContext(`(${paletteMatch[1]})`, Object.create(null), { timeout: 100 });
const quadrants = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█';
const rows = [];
for (let y = 0; y < Math.ceil(grid.length / 2); y++) {
  const runs = [];
  for (let x = 0; x < Math.ceil(grid[0].length / 2); x++) {
    const cells = [grid[y * 2]?.[x * 2], grid[y * 2]?.[x * 2 + 1], grid[y * 2 + 1]?.[x * 2], grid[y * 2 + 1]?.[x * 2 + 1]].map(c => c && c !== '.' ? c : '');
    const [first, second] = [...new Set(cells.filter(Boolean))];
    const run = first ? { text: quadrants[cells.reduce((mask, c, i) => c === first ? mask | (1 << i) : mask, 0)], fg: palette[first], bg: palette[second] } : { text: ' ' };
    const last = runs.at(-1);
    if (last && last.fg === run.fg && last.bg === run.bg) last.text += run.text;
    else runs.push(run);
  }
  rows.push(runs);
}
const wordmarkMatch = source.match(/export const WORDMARK = ([^\n]+)/);
if (!wordmarkMatch) throw new Error('The panel demo could not find WORDMARK');
const wordmark = runInNewContext(`(${wordmarkMatch[1]})`, Object.create(null), { timeout: 100 });
const data = { strings, logoRows: rows, wordmark };
await writeFile(new URL('../public/demo/panel-model.js', import.meta.url), `/* Generated from hooks/panel/model.ts by npm run prebuild. */\nwindow.EklavyaPanelDemo = ${JSON.stringify(data).replace(/</g, '\\u003c')};\n`);
console.log('Demo panel labels and logo refreshed from the Claude Code mod');
