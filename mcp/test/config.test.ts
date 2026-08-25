import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, loadConfig, writeConfigFile, findRepoConfig, isDomainEnabled } from '../src/config.js';

let home = '';
let repo = '';
const originalHome = process.env.EKLAVYA_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-repo-'));
  fs.mkdirSync(path.join(repo, '.git'));
  process.env.EKLAVYA_HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = originalHome;
});

const writeGlobal = (o: unknown) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(o));
const writeRepo = (o: unknown, dir = repo) => fs.writeFileSync(path.join(dir, '.eklavya.json'), JSON.stringify(o));

describe('config precedence', () => {
  it('falls back to defaults when nothing is configured', () => {
    expect(loadConfig(repo).config).toEqual(DEFAULT_CONFIG);
  });

  it('reads global config', () => {
    writeGlobal({ mode: 'enforced', max_questions_per_task: 6 });
    const { config } = loadConfig(repo);
    expect(config.mode).toBe('enforced');
    expect(config.max_questions_per_task).toBe(6);
  });

  it('lets the repo override the global — this is how a lead pins a mode', () => {
    writeGlobal({ mode: 'ambient', pass_threshold: 0.5 });
    writeRepo({ mode: 'enforced' });
    const { config } = loadConfig(repo);
    expect(config.mode).toBe('enforced');
    // Keys the repo did not mention still come from global.
    expect(config.pass_threshold).toBe(0.5);
  });

  it('finds a repo config from a nested directory', () => {
    writeRepo({ mode: 'enforced' });
    const nested = path.join(repo, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    expect(loadConfig(nested).config.mode).toBe('enforced');
  });

  it('does not escape the git root when looking for a repo config', () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-outer-'));
    try {
      const inner = path.join(outer, 'inner');
      fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
      writeRepo({ mode: 'enforced' }, outer);
      expect(loadConfig(inner).repoPath).toBeNull();
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });
});

describe('config validation', () => {
  it('ignores malformed values rather than adopting them', () => {
    writeGlobal({ mode: 'chaos', pass_threshold: 7, max_questions_per_task: -3 });
    expect(loadConfig(repo).config).toEqual(DEFAULT_CONFIG);
  });

  it('survives a corrupt config file', () => {
    fs.writeFileSync(path.join(home, 'config.json'), '{ not json');
    expect(loadConfig(repo).config).toEqual(DEFAULT_CONFIG);
  });
});

describe('writeConfigFile', () => {
  it('merges into the existing file instead of replacing it', () => {
    const file = path.join(home, 'config.json');
    writeConfigFile(file, { mode: 'enforced' });
    writeConfigFile(file, { quiet: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ mode: 'enforced', quiet: true });
  });

  it('preserves keys Eklavya does not know about', () => {
    const file = path.join(home, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ future_setting: 42 }));
    writeConfigFile(file, { quiet: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).future_setting).toBe(42);
  });

  it('leaves no temp file behind — the git hook may read mid-write', () => {
    writeConfigFile(path.join(home, 'config.json'), { quiet: true });
    expect(fs.readdirSync(home).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});

describe('findRepoConfig', () => {
  it('reports the git root even with no repo config present', () => {
    expect(findRepoConfig(repo).repoRoot).toBe(path.resolve(repo));
  });
});

describe('isDomainEnabled', () => {
  it('treats * as everything', () => {
    expect(isDomainEnabled(DEFAULT_CONFIG, 'anything')).toBe(true);
  });

  it('filters to the listed domains', () => {
    const cfg = { ...DEFAULT_CONFIG, domains_enabled: ['react'] };
    expect(isDomainEnabled(cfg, 'react')).toBe(true);
    expect(isDomainEnabled(cfg, 'web-auth')).toBe(false);
  });
});
