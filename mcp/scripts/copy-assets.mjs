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

console.log('assets copied to dist/');
