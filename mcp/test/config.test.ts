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

describe('focus — the second dial', () => {
  it('defaults to concept — understanding that outlives the current diff', () => {
    expect(DEFAULT_CONFIG.focus).toBe('concept');
    expect(DEFAULT_CONFIG.focus_topic).toBe(null);
    writeGlobal({ mode: 'enforced' });
    expect(loadConfig(repo).config.focus).toBe('concept');
  });

  it('is independent of mode — enforced plus learn is a real combination', () => {
    writeGlobal({ mode: 'enforced', focus: 'learn', focus_topic: 'caching' });
    const { config } = loadConfig(repo);
    expect(config.mode).toBe('enforced');
    expect(config.focus).toBe('learn');
    expect(config.focus_topic).toBe('caching');
  });

  it('ignores a focus it does not recognise rather than failing the session', () => {
    writeGlobal({ focus: 'osmosis' });
    expect(loadConfig(repo).config.focus).toBe('concept');
  });

  it('treats a blank topic as unset', () => {
    writeGlobal({ focus: 'learn', focus_topic: '   ' });
    expect(loadConfig(repo).config.focus_topic).toBe(null);
  });

  it('names what the repo is overriding, so a personal focus cannot vanish silently', () => {
    writeGlobal({ mode: 'ambient', focus: 'learn', focus_topic: 'caching' });
    writeRepo({ mode: 'enforced', focus: 'project' });

    const resolved = loadConfig(repo);
    expect(resolved.config.focus).toBe('project'); // repo still wins
    expect(resolved.overrides.sort()).toEqual(['focus', 'mode']);
  });

  it('does not report a repo setting the global never had as an override', () => {
    writeGlobal({ mode: 'ambient' });
    writeRepo({ focus: 'concept' });

    const resolved = loadConfig(repo);
    expect(resolved.config.focus).toBe('concept');
    expect(resolved.overrides).toEqual([]);
  });

  it('does not report an override when both files agree', () => {
    writeGlobal({ focus: 'concept' });
    writeRepo({ focus: 'concept' });
    expect(loadConfig(repo).overrides).toEqual([]);
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
  it('resolves symlinks, so it matches what git rev-parse reports', () => {
    // macOS /tmp -> /private/tmp: the gate would never match without this.
    const viaSymlink = repo.replace('/private/var/', '/var/');
    if (viaSymlink !== repo && fs.existsSync(viaSymlink)) {
      expect(findRepoConfig(viaSymlink).repoRoot).toBe(fs.realpathSync(repo));
    }
  });

  it('reports the git root even with no repo config present', () => {
    expect(findRepoConfig(repo).repoRoot).toBe(fs.realpathSync(repo));
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
