import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const match = /^(\d+)\/(\d+)$/.exec(process.argv[2] ?? '');
if (!match || +match[1] < 1 || +match[1] > +match[2]) {
  throw new Error('Usage: node ../.github/scripts/test-shard.mjs INDEX/TOTAL (build first)');
}
const index = +match[1];
const total = +match[2];
const root = process.cwd();
const directory = path.join(root, 'coverage', `shard-${index}`);
fs.rmSync(directory, { recursive: true, force: true });
fs.mkdirSync(path.join(directory, 'raw'), { recursive: true });
const started = Date.now();
const result = spawnSync(process.execPath, [
  'node_modules/vitest/vitest.mjs', 'run', `--shard=${index}/${total}`,
  // Leave CPU capacity for the browsers, hooks and CLI subprocesses each
  // worker starts. More file workers caused browser timeouts under coverage.
  '--maxWorkers=2',
  '--config=../.github/scripts/ci-vitest.config.mjs',
  '--reporter=default', '--reporter=json', `--outputFile.json=${directory}/tests.json`,
], {
  stdio: 'inherit',
  env: { ...process.env, EKLAVYA_COVERAGE: '1', NODE_V8_COVERAGE: `${directory}/raw` },
});
fs.writeFileSync(`${directory}/manifest.json`, JSON.stringify({
  index, total, root, status: result.status, durationMs: Date.now() - started,
}));
// tar compresses hundreds of MB of raw V8 data before artifact transfer.
const archive = spawnSync('tar', ['-czf', `coverage/shard-${index}.tgz`, '-C', 'coverage', `shard-${index}`], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
if (result.error) console.error(result.error);
if (archive.status !== 0) process.exitCode = 1;
