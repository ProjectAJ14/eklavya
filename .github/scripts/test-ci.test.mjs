import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import CISequencer from './ci-sequencer.mjs';
import ciConfig from './ci-vitest.config.mjs';
import localConfig from '../../mcp/vitest.config.ts';
import { loads, plan, testFiles } from './shard-plan.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const scriptEnv = { ...process.env };
// Synthetic coverage fixtures must not appear in the real CI run summary.
delete scriptEnv.GITHUB_STEP_SUMMARY;
const run = (name, args, cwd) => spawnSync(process.execPath, [path.join(scripts, `${name}.mjs`), ...args], { cwd, encoding: 'utf8', env: scriptEnv });

const context = {
  config: { root: '/fixture', shard: { index: 1, count: 2 } },
  cache: { getFileTestResults: () => undefined, getFileStats: () => ({ size: 1 }) },
};
const specifications = ['unit', 'dashboard-screens-browser', 'dashboard-artifacts-browser', 'other', 'mascot-browser', 'last'].map(name => ({
  moduleId: `/fixture/test/${name}.test.ts`,
  project: { name: '', config: { isolate: true, sequence: { groupOrder: 0 } } },
}));

test('the CI config retains the local runner and coverage settings', () => {
  assert.deepEqual({ ...ciConfig.test, sequence: undefined }, { ...localConfig.test, sequence: undefined });
  assert.deepEqual(ciConfig.resolve, localConfig.resolve);
  assert.equal(ciConfig.test.sequence.sequencer, CISequencer);
});

test('run the expensive browser checks first without dropping test files', async () => {
  const ordered = await new CISequencer(context).sort(specifications);
  assert.deepEqual(ordered.map(spec => path.basename(spec.moduleId)), [
    'dashboard-screens-browser.test.ts', 'dashboard-artifacts-browser.test.ts', 'mascot-browser.test.ts',
    'unit.test.ts', 'other.test.ts', 'last.test.ts',
  ]);
});

const manifest = {
  count: 2,
  files: Object.fromEntries(specifications.map((spec, i) => [`test/${path.basename(spec.moduleId)}`, { shard: (i % 2) + 1, seconds: 1 }])),
};
const withManifest = async (value, body) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-manifest-')), 'test-shards.json');
  fs.writeFileSync(file, JSON.stringify(value));
  process.env.EKLAVYA_SHARD_MANIFEST = file;
  try { return await body(); } finally { delete process.env.EKLAVYA_SHARD_MANIFEST; fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
};
const shardOf = index => new CISequencer({ ...context, config: { ...context.config, shard: { index, count: 2 } } }).shard(specifications);

test('the sequencer gives every file to exactly one shard, as the manifest says', () => withManifest(manifest, async () => {
  const first = await shardOf(1);
  const second = await shardOf(2);
  assert.deepEqual(first.map(spec => path.basename(spec.moduleId)), ['unit.test.ts', 'dashboard-artifacts-browser.test.ts', 'mascot-browser.test.ts']);
  assert.equal(new Set([...first, ...second]).size, specifications.length);
  assert.equal(first.length + second.length, specifications.length);
}));

test('the sequencer refuses a file missing from the manifest and a shard count that disagrees', () => withManifest(manifest, async () => {
  const { 'test/last.test.ts': _, ...files } = manifest.files;
  await withManifest({ ...manifest, files }, () => assert.rejects(shardOf(1), /Not in .*test-shards\.json: test\/last\.test\.ts/));
  await withManifest({ ...manifest, count: 3 }, () => assert.rejects(shardOf(1), /test-shards\.json has 3 shards/));
}));

const real = JSON.parse(fs.readFileSync(path.join(scripts, 'test-shards.json'), 'utf8'));
test('test-shards.json lists exactly the test files that exist', () => {
  assert.deepEqual(Object.keys(real.files).sort(), testFiles(), 'a new or deleted test needs: node .github/scripts/shard-plan.mjs add|rebalance (see .claude/rules/test-shards.md)');
  for (const { shard, seconds } of Object.values(real.files)) {
    assert.ok(Number.isInteger(shard) && shard >= 1 && shard <= real.count && seconds > 0);
  }
});

test('no shard carries much more than its share', () => {
  const sums = loads(real);
  const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
  assert.ok(Math.max(...sums) <= mean * 1.25, `shards ${sums.join('/')}s: run shard-plan.mjs rebalance with a recent coverage/test-timings.json`);
});

test('the workflow runs exactly the shards the manifest defines', () => {
  const workflow = fs.readFileSync(path.join(scripts, '../workflows/test.yml'), 'utf8');
  const matrix = /shard: \[([\d, ]+)\]/.exec(workflow)[1].split(',').map(Number);
  assert.deepEqual(matrix, Array.from({ length: real.count }, (_, i) => i + 1));
  assert.ok(workflow.includes(`test-shard.mjs \${{ matrix.shard }}/${real.count}`));
  assert.ok(workflow.includes(`merge-coverage.mjs ${real.count}`));
});

test('reject invalid shard and merge arguments', () => {
  for (const value of ['0/2', '3/2', '1/0', 'one']) {
    assert.notEqual(run('test-shard', [value], scripts).status, 0);
  }
  for (const value of ['0', '-1', '1.5', 'two']) {
    assert.notEqual(run('merge-coverage', [value], scripts).status, 0);
  }
});

test('a failing test runner stays failed after its evidence is archived', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-'));
  try {
    fs.mkdirSync(`${root}/node_modules/vitest`, { recursive: true });
    fs.writeFileSync(`${root}/node_modules/vitest/vitest.mjs`, 'process.exit(7);');
    const result = run('test-shard', ['1/2'], root);
    assert.equal(result.status, 7);
    assert.ok(fs.existsSync(`${root}/coverage/shard-1.tgz`));
    const manifest = JSON.parse(fs.readFileSync(`${root}/coverage/shard-1/manifest.json`, 'utf8'));
    assert.equal(manifest.status, 7);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const scenario of ['missing', 'failed', 'duplicate', 'no-coverage', 'empty-results', 'incomplete']) {
  test(`merge refuses ${scenario} shard evidence`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-shards-'));
    try {
      fs.mkdirSync(`${root}/coverage/shards`, { recursive: true });
      fs.mkdirSync(`${root}/test`);
      fs.writeFileSync(`${root}/test/one.test.ts`, '');
      fs.writeFileSync(`${root}/test/two.test.ts`, '');
      if (scenario === 'incomplete') fs.writeFileSync(`${root}/test/omitted.test.ts`, '');
      for (let index = 1; index <= 2 && scenario !== 'missing'; index++) {
        const directory = `${root}/coverage/shard-${index}`;
        fs.mkdirSync(`${directory}/raw`, { recursive: true });
        fs.writeFileSync(`${directory}/manifest.json`, JSON.stringify({
          index, total: 2, root, status: scenario === 'failed' ? 1 : 0, durationMs: 10,
        }));
        const name = scenario === 'duplicate' ? 'one' : index === 1 ? 'one' : 'two';
        fs.writeFileSync(`${directory}/tests.json`, JSON.stringify({
          success: true,
          testResults: scenario === 'empty-results' ? [] : [{ name: `${root}/test/${name}.test.ts`, startTime: 0, endTime: 10 }],
        }));
        if (scenario !== 'no-coverage') fs.writeFileSync(`${directory}/raw/v8.json`, '{"result":[]}');
        assert.equal(spawnSync('tar', ['-czf', `coverage/shards/shard-${index}.tgz`, '-C', 'coverage', `shard-${index}`], { cwd: root }).status, 0);
      }
      const result = run('merge-coverage', ['2'], root);
      assert.notEqual(result.status, 0);
      const message = {
        missing: 'Missing or invalid shard', failed: 'did not complete successfully',
        duplicate: 'executed twice', 'no-coverage': 'has no coverage data',
        'empty-results': 'has no successful test results', incomplete: 'complete test file inventory',
      }[scenario];
      assert.ok(result.stderr.includes(message), result.stderr);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const complete of [true, false]) {
  test(`merge real V8 coverage ${complete ? 'across checkout paths' : 'rejects uncovered branches'}`, () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-source-'));
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-merge-'));
    try {
      for (const root of [source, destination]) {
        fs.mkdirSync(`${root}/dist`);
        fs.mkdirSync(`${root}/test`);
        fs.mkdirSync(`${root}/coverage/shards`, { recursive: true });
        fs.writeFileSync(`${root}/dist/sample.js`, 'function pick(flag) { return flag ? 1 : 2; }\npick(process.argv[2] === "yes");\n');
        for (const name of ['one', 'two']) fs.writeFileSync(`${root}/test/${name}.test.ts`, '');
        fs.writeFileSync(`${root}/.c8rc.json`, JSON.stringify({
          include: ['dist/**/*.js'], reporter: ['json-summary'], 'reports-dir': 'coverage',
          'check-coverage': true, lines: 100, statements: 100, functions: 100, branches: 100,
        }));
      }
      fs.symlinkSync(path.resolve(scripts, '../../mcp/node_modules'), `${destination}/node_modules`, 'dir');
      for (let index = 1; index <= 2; index++) {
        const directory = `${source}/coverage/shard-${index}`;
        fs.mkdirSync(`${directory}/raw`, { recursive: true });
        const covered = spawnSync(process.execPath, ['dist/sample.js', complete && index === 2 ? 'no' : 'yes'], {
          cwd: source, env: { ...process.env, NODE_V8_COVERAGE: `${directory}/raw` },
        });
        assert.equal(covered.status, 0);
        // Both runners can produce the same filename; neither shard may win
        // by overwriting the other's data during aggregation.
        const rawName = fs.readdirSync(`${directory}/raw`)[0];
        fs.renameSync(`${directory}/raw/${rawName}`, `${directory}/raw/v8.json`);
        fs.writeFileSync(`${directory}/manifest.json`, JSON.stringify({ index, total: 2, root: source, status: 0, durationMs: 10 }));
        fs.writeFileSync(`${directory}/tests.json`, JSON.stringify({ success: true, testResults: [{
          name: `${source}/test/${index === 1 ? 'one' : 'two'}.test.ts`, startTime: 0, endTime: 10,
        }] }));
        assert.equal(spawnSync('tar', ['-czf', `${destination}/coverage/shards/shard-${index}.tgz`, '-C', 'coverage', `shard-${index}`], { cwd: source }).status, 0);
      }
      const result = run('merge-coverage', ['2'], destination);
      if (complete) {
        assert.equal(result.status, 0, result.stderr);
        const summary = JSON.parse(fs.readFileSync(`${destination}/coverage/coverage-summary.json`, 'utf8'));
        assert.equal(summary.total.branches.pct, 100);
        assert.ok(Object.keys(summary).includes(`${destination}/dist/sample.js`));
      } else {
        assert.notEqual(result.status, 0);
        const summary = JSON.parse(fs.readFileSync(`${destination}/coverage/coverage-summary.json`, 'utf8'));
        assert.ok(summary.total.branches.pct < 100);
      }
    } finally {
      for (const root of [source, destination]) fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('plan balances by cost and is stable', () => {
  const items = [90, 80, 40, 30, 30, 20, 10, 10].map((seconds, i) => ({ file: `test/f${i}.test.ts`, seconds }));
  const planned = plan(items, 3);
  const sums = loads(planned);
  assert.ok(Math.max(...sums) - Math.min(...sums) <= 90, sums.join('/'));
  assert.equal(Object.keys(planned.files).length, items.length);
  assert.deepEqual(plan([...items].reverse(), 3), planned);
});

// The CLI runs against a copy of the repository layout, never the real manifest.
const planner = (setup, args) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-plan-'));
  fs.mkdirSync(`${root}/mcp/test`, { recursive: true });
  fs.mkdirSync(`${root}/.github/scripts`, { recursive: true });
  fs.copyFileSync(path.join(scripts, 'shard-plan.mjs'), `${root}/.github/scripts/shard-plan.mjs`);
  setup.disk.forEach(name => fs.writeFileSync(`${root}/mcp/${name}`, ''));
  fs.writeFileSync(`${root}/.github/scripts/test-shards.json`, JSON.stringify(setup.manifest));
  const result = spawnSync(process.execPath, [`${root}/.github/scripts/shard-plan.mjs`, ...args], { encoding: 'utf8', env: scriptEnv });
  const after = JSON.parse(fs.readFileSync(`${root}/.github/scripts/test-shards.json`, 'utf8'));
  fs.rmSync(root, { recursive: true, force: true });
  return { result, after };
};
const base = { disk: ['test/a.test.ts', 'test/b.test.ts', 'test/new.test.ts'], manifest: { count: 2, files: {
  'test/a.test.ts': { shard: 1, seconds: 50 }, 'test/b.test.ts': { shard: 2, seconds: 10 },
} } };

test('add puts a new file on the lightest shard', () => {
  const { result, after } = planner(base, ['add', 'mcp/test/new.test.ts', '20']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(after.files['test/new.test.ts'], { shard: 2, seconds: 20 });
});

for (const [name, args, message] of [
  ['a file that does not exist', ['add', 'test/ghost.test.ts'], 'does not exist'],
  ['a file already listed', ['add', 'test/a.test.ts'], 'already on shard 1'],
  ['a non-numeric cost', ['add', 'test/new.test.ts', 'slow'], 'positive number'],
  ['a zero cost', ['add', 'test/new.test.ts', '0'], 'positive number'],
  ['a file that is not a test', ['add', 'test/helpers.ts'], 'Usage'],
]) {
  test(`add refuses ${name} and leaves the manifest alone`, () => {
    const { result, after } = planner(base, args);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(message), result.stderr);
    assert.deepEqual(after, base.manifest);
  });
}

test('rebalance follows the files on disk, not the timings file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-timings-'));
  const timings = `${root}/timings.json`;
  // b was deleted since the run; new was added after it.
  fs.writeFileSync(timings, JSON.stringify([{ file: 'test/a.test.ts', durationMs: 5000 }, { file: 'test/gone.test.ts', durationMs: 9000 }]));
  try {
    const { result, after } = planner({ ...base, disk: ['test/a.test.ts', 'test/new.test.ts'] }, ['rebalance', timings]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(Object.keys(after.files), ['test/a.test.ts', 'test/new.test.ts']);
    assert.equal(after.files['test/a.test.ts'].seconds, 5);
    assert.equal(after.files['test/new.test.ts'].seconds, 30);
    assert.equal(after.count, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
