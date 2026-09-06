/**
 * Copies the generated runtime diagram into public/ and gives it the site's
 * favicon on the way through.
 *
 * archify emits no `<link rel="icon">`, so the tab falls back to /favicon.ico,
 * which this site does not have — the diagram opened in its own tab showed the
 * browser's blank page mark. The link is added here rather than in docs/,
 * because a hand-edit to a generated file dies with the next regeneration.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const src = new URL('../../docs/eklavya-runtime.html', import.meta.url);
const out = new URL('../public/eklavya-runtime.html', import.meta.url);
const charset = '<meta charset="UTF-8">';
const icon = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';

const html = readFileSync(src, 'utf8');
// after the charset, so that declaration stays where a parser expects it
const withIcon = html.includes(icon) ? html : html.replace(charset, `${charset}\n  ${icon}`);

if (!withIcon.includes(icon)) {
  console.warn('embed-diagram: no charset meta to inject the favicon after; copying as generated');
}

writeFileSync(out, withIcon);
