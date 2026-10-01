// Syntax-checks every source and test file, and forbids console.log in src/.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let failed = false;
for (const dir of ['src', 'test']) {
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;
    const file = path.join(dir, name);
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (res.status !== 0) {
      failed = true;
      process.stderr.write(res.stderr);
    }
    if (dir === 'src' && fs.readFileSync(file, 'utf8').includes('console.log')) {
      failed = true;
      process.stderr.write(`${file}: console.log is not allowed in src/\n`);
    }
  }
}
process.exit(failed ? 1 : 0);
