// Copies non-TypeScript runtime assets (SQL migrations, seed graphs) into dist/
// so the built server resolves them the same way it does when run from src via tsx.
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

for (const dir of ['migrations', 'seed']) {
  const from = path.join(root, 'src', dir);
  const to = path.join(root, 'dist', dir);
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });
}

// The tutor pedagogy has to travel with the npm package: `eklavya export-rules`
// derives the Cursor rules file from it, and a standalone install has no
// skills/ directory. Copied at build time so SKILL.md stays the single source.
const skill = path.join(path.dirname(root), 'skills', 'tutor', 'SKILL.md');
const assets = path.join(root, 'dist', 'assets');
await mkdir(assets, { recursive: true });
try {
  await cp(skill, path.join(assets, 'tutor-skill.md'));
} catch (err) {
  console.warn(`warning: could not bundle the tutor skill (${err.code ?? err.message})`);
}

// The dashboard page and the design tokens ship with the package: `eklavya
// dashboard` must work from a plain npm install, with no repo checked out.
await cp(path.join(root, 'src', 'assets'), assets, { recursive: true });
const tokens = path.join(path.dirname(root), 'site', 'tokens.css');
try {
  await cp(tokens, path.join(assets, 'tokens.css'));
} catch (err) {
  console.warn(`warning: could not bundle the design tokens (${err.code ?? err.message})`);
}

console.log('assets copied to dist/');
