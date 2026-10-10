/**
 * `scripts/dashboard-perf.mjs` is a contributor tool and CI never asserts a
 * time from it, but what it prints is what a PR's numbers are read from, so the
 * parts that are not a measurement are held here: how it reads its arguments,
 * the unit it prints, and that two runs on one day seed the same payload.
 *
 * Each run is a real `node` process on the small scale (about half a second),
 * against the built `dist/`, in a temporary home the script makes and removes
 * itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts', 'dashboard-perf.mjs');
const DAY_MS = 864e5;

let tmp = '';
let shift = '';

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-perf-')));
  // `--import` module that moves the clock `SHIFT_MS` milliseconds: a run "at another hour".
  shift = path.join(tmp, 'shift-clock.mjs');
  fs.writeFileSync(
    shift,
    `const offset = Number(process.env.SHIFT_MS || 0);
const Real = Date;
globalThis.Date = class extends Real {
  constructor(...args) { if (args.length === 0) super(Real.now() + offset); else super(...args); }
  static now() { return Real.now() + offset; }
};
`,
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function perf(args: string[], env: Record<string, string> = {}, cwd = tmp) {
  const run = spawnSync(process.execPath, [...(env.SHIFT_MS ? ['--import', shift] : []), SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

describe('its arguments', () => {
  it('reads a lone mistyped scale as one, not as a missing build', () => {
    for (const typo of ['larg', 'huge', 'Medium', 'smal']) {
      const r = perf([typo]);
      expect(r.status, typo).toBe(2);
      // The first line is the complaint, and it is about the scale (the usage under it ends with a reminder to build).
      expect(r.err.split('\n')[0], typo).toBe(`Unknown scale "${typo}" (small, medium, large or all), and no directory of that name`);
      expect(r.err).toContain('Usage: node mcp/scripts/dashboard-perf.mjs');
      expect(r.out).toBe('');
    }
  });

  it('still reads a lone argument that is a directory, or looks like a path, as the dist to measure', () => {
    fs.mkdirSync(path.join(tmp, 'a-dist'));
    // An existing directory with no build in it: the build is what is missing.
    const here = perf(['a-dist']);
    expect(here.status).toBe(2);
    expect(here.err).toContain(`${path.join(tmp, 'a-dist', 'db.js')} not found. Build first: cd mcp && npm run build`);
    // A path that is not there: still a place, so still the build that is missing, not a scale.
    const elsewhere = perf(['./nowhere/dist']);
    expect(elsewhere.status).toBe(2);
    expect(elsewhere.err).toContain(`${path.join(tmp, 'nowhere', 'dist', 'db.js')} not found. Build first`);
  });

  it('still reads a scale after a dist, and refuses an unknown one there as before', () => {
    const r = perf(['./nowhere/dist', 'huge']);
    expect(r.status).toBe(2);
    expect(r.err).toContain('Unknown scale "huge" (small, medium, large or all)');
  });

  it('prints its usage for --help whatever else is on the line, and succeeds', () => {
    const r = perf(['larg', '--help']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Usage: node mcp/scripts/dashboard-perf.mjs');
    expect(r.out).toContain('--live');
  });

  it('wants a whole number of writes, and says so before it seeds anything', () => {
    for (const bad of ['0', 'two', '1.5', '']) {
      const r = perf(['small', '--live', `--writes=${bad}`]);
      expect(r.status, bad).toBe(2);
      expect(r.err.split('\n')[0], bad).toBe(`--writes wants a whole number of at least 1, not "${bad}"`);
      expect(r.out).toBe('');
    }
  });
});

describe('--live', () => {
  it('says why and skips, with nothing wrong, when the browser it was told about is not there', () => {
    const missing = path.join(tmp, 'no-chromium');
    const r = perf(['small', '--live', '--writes=1'], { EKLAVYA_TEST_BROWSER: missing });
    expect(r.status).toBe(0);
    expect(r.out).toContain(`Live update: skipped, EKLAVYA_TEST_BROWSER names ${missing}, which is not there`);
    // The rest of the report is as it is without the flag.
    expect(r.out).toMatch(/\/api\/state payload: /);
    const json = perf(['small', '--live', '--writes=1', '--json'], { EKLAVYA_TEST_BROWSER: missing });
    expect(JSON.parse(json.out).live).toEqual({ skipped: `EKLAVYA_TEST_BROWSER names ${missing}, which is not there` });
  });

  it('prints no live section without the flag', () => {
    const r = perf(['small', '--json']);
    expect(JSON.parse(r.out)).not.toHaveProperty('live');
  });

  // A real Chromium, a real server and a real second connection: about ten seconds at the small scale.
  const browser = process.env.EKLAVYA_TEST_BROWSER ?? (() => { try { return chromium.executablePath(); } catch { return ''; } })();
  it.skipIf(!browser || !fs.existsSync(browser))('times a write from the database to the row on screen, with the early trigger and on the floor', () => {
    const r = perf(['small', '--live', '--writes=2', '--json'], browser === process.env.EKLAVYA_TEST_BROWSER ? {} : { EKLAVYA_TEST_BROWSER: browser });
    expect(r.status, r.err).toBe(0);
    const live = JSON.parse(r.out).live;
    expect(live.writes).toBe(2);
    expect(live.variants.map((v: { name: string }) => v.name)).toEqual(['fs.watch', 'floor only']);
    for (const v of live.variants) {
      expect(v.runs).toHaveLength(2);
      for (const run of v.runs) {
        // The parts add up to the whole, within a rounding error, and each is a duration.
        expect(run.heard).toBeGreaterThan(0);
        expect(run.read).toBeGreaterThan(0);
        expect(run.paint).toBeGreaterThan(0);
        expect(run.heard + run.read + run.paint).toBeCloseTo(run.total, 0);
        expect(run.draw).toBeLessThanOrEqual(run.paint);
      }
      expect(v.total.median).toBeGreaterThan(0);
    }
    // The row it watched for was on screen every time (a write that never showed is an error the script reports).
    expect(r.err).not.toMatch(/not on screen/);
  }, 120_000);
});

describe('what it prints', () => {
  it('writes sizes in decimal KB and MB, so a figure reads against the issue\'s budgets', () => {
    const r = perf(['small']);
    expect(r.status).toBe(0);
    const line = /\/api\/state payload: ([\d,]+) bytes \(([\d.]+) (KB|MB)\)/.exec(r.out);
    expect(line, r.out).not.toBeNull();
    const bytes = Number(line![1].replace(/,/g, ''));
    const unit = line![3] === 'MB' ? 1e6 : 1e3;
    // The same number, rounded as printed: not bytes over 1,048,576 under a label of MB.
    expect(Number(line![2])).toBe(Number((bytes / unit).toFixed(line![3] === 'MB' ? 2 : 1)));
    expect(r.out).not.toMatch(/KiB|MiB/);
    // The date the timestamps are counted back from is stated, so a diff can say why two runs differ.
    expect(r.out).toMatch(/dates counted back from \d{4}-\d{2}-\d{2}T00:00:00\.000Z/);
  });
});

describe('what it seeds', () => {
  const bytesAt = (shiftMs: number) => {
    const r = perf(['small', '--json'], { SHIFT_MS: String(shiftMs) });
    expect(r.status).toBe(0);
    const result = JSON.parse(r.out);
    return { bytes: result.payload.bytes as number, keys: result.payload.keys as Record<string, number>, anchor: result.seed.anchor as string };
  };

  it('is the same payload, byte for byte, whatever hour of the same UTC day it runs at', () => {
    // Shifts that stay inside today, in whichever direction has room: the case is the hour, not the date.
    const intoDay = Date.now() % DAY_MS;
    const hours = (n: number) => (intoDay >= 7 * 36e5 ? -n : n) * 36e5;
    for (let attempt = 0; ; attempt++) {
      const runs = [0, hours(7), hours(3)].map(bytesAt);
      // A run that straddled midnight is a different date, which is not what is being held.
      if (new Set(runs.map((r) => r.anchor)).size > 1 && attempt === 0) continue;
      expect(new Set(runs.map((r) => r.anchor)).size).toBe(1);
      for (const run of runs) expect(run.bytes).toBe(runs[0].bytes);
      for (const run of runs) expect(run.keys).toEqual(runs[0].keys);
      expect(runs[0].anchor).toMatch(/T00:00:00\.000Z$/);
      return;
    }
  });
});
