import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The one place that decides which CI shard runs which test file. The manifest
// maps every `mcp/test/**/*.test.ts` to a shard and an estimated cost in
// seconds (from `coverage/test-timings.json`), so shards stay balanced and a
// file that is not listed fails CI instead of silently never running.
//
//   node .github/scripts/shard-plan.mjs add test/new.test.ts [seconds]
//   node .github/scripts/shard-plan.mjs rebalance path/to/test-timings.json [count]
//   node .github/scripts/shard-plan.mjs show
// Read per call so a test can point EKLAVYA_SHARD_MANIFEST at a fixture.
const manifestPath = () => process.env.EKLAVYA_SHARD_MANIFEST
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-shards.json');

export const readManifest = () => JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));

// Test files as manifest keys: `test/...`, relative to mcp/, with `/` separators.
export function testFiles(mcp = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../mcp')) {
  const walk = directory => fs.readdirSync(path.join(mcp, directory), { withFileTypes: true }).flatMap(entry => {
    const name = `${directory}/${entry.name}`;
    return entry.isDirectory() ? walk(name) : entry.name.endsWith('.test.ts') ? [name] : [];
  });
  return walk('test').sort();
}

export function loads(manifest) {
  const sums = Array(manifest.count).fill(0);
  for (const { shard, seconds } of Object.values(manifest.files)) sums[shard - 1] += seconds;
  return sums;
}

// Longest file first, always into the lightest shard.
export function plan(items, count) {
  const sums = Array(count).fill(0);
  const files = {};
  for (const { file, seconds } of [...items].sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file))) {
    const shard = sums.indexOf(Math.min(...sums)) + 1;
    sums[shard - 1] += seconds;
    files[file] = { shard, seconds };
  }
  return { count, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) };
}

const write = manifest => fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2) + '\n');
const show = manifest => loads(manifest).forEach((s, i) => console.log(`shard ${i + 1}: ${s}s`));

if (fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [command, arg, extra] = process.argv.slice(2);
  const manifest = readManifest();
  const onDisk = testFiles();
  if (command === 'add') {
    const file = arg?.replace(/^mcp\//, '');
    if (!file?.endsWith('.test.ts')) throw new Error('Usage: shard-plan.mjs add test/name.test.ts [seconds]');
    if (!onDisk.includes(file)) throw new Error(`${file} does not exist under mcp/`);
    if (manifest.files[file]) throw new Error(`${file} is already on shard ${manifest.files[file].shard}; edit its entry to change it`);
    // 30s is a middling file; browser suites are 60-120s, so pass a number for those.
    const seconds = Number(extra ?? 30);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`seconds must be a positive number, got ${extra}`);
    const sums = loads(manifest);
    const shard = sums.indexOf(Math.min(...sums)) + 1;
    manifest.files[file] = { shard, seconds };
    manifest.files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
    write(manifest);
    console.log(`${file} -> shard ${shard}`);
    show(manifest);
  } else if (command === 'rebalance') {
    const timed = new Map(JSON.parse(fs.readFileSync(arg, 'utf8')).map(t => [t.file, Math.max(1, Math.round(t.durationMs / 1000))]));
    // Plan the files that exist now: a file newer than the timings keeps its
    // old estimate (or 30s), a deleted one is dropped.
    const next = plan(onDisk.map(file => ({ file, seconds: timed.get(file) ?? manifest.files[file]?.seconds ?? 30 })), Number(extra ?? manifest.count));
    write(next);
    show(next);
  } else if (command === 'show') {
    show(manifest);
  } else {
    throw new Error('Usage: shard-plan.mjs add|rebalance|show');
  }
}
