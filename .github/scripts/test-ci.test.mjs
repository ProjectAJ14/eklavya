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

test('the sequencer preserves native, disjoint shard assignment', async () => {
  const sequencer = new CISequencer(context);
  const nativeShard = Object.getPrototypeOf(CISequencer.prototype).shard;
  const first = await sequencer.shard(specifications);
  assert.deepEqual(first, await nativeShard.call(sequencer, specifications));
  const second = await new CISequencer({ ...context, config: { ...context.config, shard: { index: 2, count: 2 } } }).shard(specifications);
  assert.equal(new Set([...first, ...second]).size, specifications.length);
  assert.equal(first.length + second.length, specifications.length);
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
