/** Keep the generated diagram intact; add public-site metadata only to the copy. */
import { readFileSync, writeFileSync } from 'node:fs';
import { staticHead } from '../src/lib/static-head.mjs';
const src = new URL('../../docs/eklavya-runtime.html', import.meta.url);
const out = new URL('../public/eklavya-runtime.html', import.meta.url);
const charset = '<meta charset="UTF-8">';
const html = readFileSync(src, 'utf8');
if (!html.includes(charset)) throw new Error('embed-diagram: expected charset marker is missing');
const metadata = staticHead({
  title: 'Eklavya runtime architecture',
  description: 'Explore the Eklavya runtime: Claude Code hooks, learning checkpoints, local memory, the MCP server, and the optional commit gate.',
  path: '/eklavya-runtime.html', id: 'docs/how-it-works', index: false,
});
// The diagram is an embedded companion to /docs/how-it-works/, not a search landing page.
writeFileSync(out, html.replace(/<title>[\s\S]*?<\/title>/i, '').replace(charset, `${charset}\n${metadata}`));
