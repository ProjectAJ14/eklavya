import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const total = Number(process.argv[2]);
if (!Number.isInteger(total) || total < 1) throw new Error('Usage: node ../.github/scripts/merge-coverage.mjs TOTAL');
const root = process.cwd();
const temporary = path.join(root, 'coverage', 'tmp');
fs.rmSync(temporary, { recursive: true, force: true });
fs.mkdirSync(temporary, { recursive: true });
const files = new Set();
const timings = [];
for (let index = 1; index <= total; index++) {
  const directory = path.join(root, 'coverage', `shard-${index}`);
  fs.rmSync(directory, { recursive: true, force: true });
  const extracted = spawnSync('tar', ['-xzf', `coverage/shards/shard-${index}.tgz`, '-C', 'coverage'], { stdio: 'inherit' });
  if (extracted.status !== 0) throw new Error(`Missing or invalid shard ${index} archive`);
  const manifest = JSON.parse(fs.readFileSync(`${directory}/manifest.json`, 'utf8'));
  if (manifest.index !== index || manifest.total !== total || manifest.status !== 0) {
    throw new Error(`Shard ${index} did not complete successfully`);
  }
  const tests = JSON.parse(fs.readFileSync(`${directory}/tests.json`, 'utf8'));
  if (!tests.success || !tests.testResults.length) throw new Error(`Shard ${index} has no successful test results`);
  for (const suite of tests.testResults) {
    const name = path.relative(manifest.root, suite.name);
    if (files.has(name)) throw new Error(`Test file executed twice: ${name}`);
    files.add(name);
    timings.push({ file: name, durationMs: suite.endTime - suite.startTime });
  }
  const raw = fs.readdirSync(`${directory}/raw`).filter(name => name.endsWith('.json'));
  if (!raw.length) throw new Error(`Shard ${index} has no coverage data`);
  for (const name of raw) {
    // Normalize checkout paths (including source-map-cache keys) when replaying
    // artifacts locally or on a runner with a different workspace directory.
    let data = fs.readFileSync(`${directory}/raw/${name}`, 'utf8');
    for (const [from, to] of [
      [pathToFileURL(manifest.root).href, pathToFileURL(root).href],
      [manifest.root, root],
    ]) data = data.replaceAll(JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1));
    JSON.parse(data);
    fs.writeFileSync(path.join(temporary, `${index}-${name}`), data);
  }
  console.log(`Shard ${index}: ${tests.testResults.length} files, ${(manifest.durationMs / 1000).toFixed(1)}s`);
}
function testFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? testFiles(name) : entry.name.endsWith('.test.ts') ? [name] : [];
  });
}
const expected = testFiles('test');
if (files.size !== expected.length || expected.some(name => !files.has(name))) {
  throw new Error('Shards did not execute the complete test file inventory');
}
timings.sort((a, b) => b.durationMs - a.durationMs);
fs.writeFileSync('coverage/test-timings.json', JSON.stringify(timings, null, 2));
const summary = ['### Test timings', '', '| Slowest file | Seconds |', '|---|---:|',
  ...timings.slice(0, 10).map(item => `| ${item.file} | ${(item.durationMs / 1000).toFixed(1)} |`), ''].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
// One c8 report across all raw files, with the unchanged .c8rc.json thresholds.
const report = spawnSync(process.execPath, ['node_modules/c8/bin/c8.js', 'report'], { stdio: 'inherit' });
process.exitCode = report.status ?? 1;
if (fs.existsSync('coverage/coverage-summary.json') && process.env.GITHUB_STEP_SUMMARY) {
  const coverage = JSON.parse(fs.readFileSync('coverage/coverage-summary.json', 'utf8'));
  const metrics = ['lines', 'statements', 'functions', 'branches'];
  const rows = Object.entries(coverage).filter(([name, data]) =>
    name === 'total' || metrics.some(metric => data[metric].pct < 100));
  const table = ['### Coverage', '', '| File | Lines | Statements | Functions | Branches |',
    '|---|---:|---:|---:|---:|', ...rows.map(([name, data]) =>
      `| ${name === 'total' ? 'Total' : path.relative(root, name)} | ${metrics.map(metric => `${data[metric].pct}%`).join(' | ')} |`), ''].join('\n');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
}
