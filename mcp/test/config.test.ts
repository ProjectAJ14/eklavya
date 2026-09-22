import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, loadConfig, writeConfigFile, findRepoConfig, isDomainEnabled } from '../src/config.js';
import { projectConfigPath } from '../src/paths.js';

let home = '';
let repo = '';
const originalHome = process.env.EKLAVYA_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-repo-')));
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
/**
 * Settings for a checkout, written where they actually live: outside it, under
 * `<home>/projects/<slug>/`. Nothing this suite does puts a file in a repo.
 */
const writeRepo = (o: Record<string, unknown>, dir = repo) => {
  const target = projectConfigPath(dir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ ...o, project: dir }));
};

describe('config precedence', () => {
  it('falls back to defaults when nothing is configured', () => {
    expect(loadConfig(repo).config).toEqual(DEFAULT_CONFIG);
  });

  it('reads global config', () => {
    writeGlobal({ quiz: { enforced: true }, max_questions_per_task: 6 });
    const { config } = loadConfig(repo);
    expect(config.quiz.enforced).toBe(true);
    expect(config.max_questions_per_task).toBe(6);
  });

  it('lets the repo override the global — this is how a lead pins the gate', () => {
    writeGlobal({ quiz: { enforced: false }, pass_threshold: 0.5 });
    writeRepo({ quiz: { enforced: true } });
    const { config } = loadConfig(repo);
    expect(config.quiz.enforced).toBe(true);
    // Keys the repo did not mention still come from global.
    expect(config.pass_threshold).toBe(0.5);
  });

  it('finds a repo config from a nested directory', () => {
    writeRepo({ quiz: { enforced: true } });
    const nested = path.join(repo, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    expect(loadConfig(nested).config.quiz.enforced).toBe(true);
  });

  it('stops the walk at the git root, so an enclosing directory is not this project', () => {
    const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-outer-')));
    try {
      const inner = path.join(outer, 'inner');
      fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
      // The checkout is `inner`, so that is what settings are keyed by --
      // `outer` is somebody else's directory that happens to contain it.
      const resolved = loadConfig(inner);
      expect(resolved.repoRoot).toBe(inner);
      expect(resolved.projectPath).toBe(projectConfigPath(inner));
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });
});

describe('cadence — the third dial', () => {
  it('interleaves by default: the promise is learning while the agent works', () => {
    expect(DEFAULT_CONFIG.cadence).toBe('interleaved');
    expect(loadConfig(repo).config.cadence).toBe('interleaved');
  });

  it('can be turned off per repo without touching the other dials', () => {
    writeGlobal({ quiz: { enforced: true }, focus: 'learn', focus_topic: 'caching' });
    writeRepo({ cadence: 'end' });

    const resolved = loadConfig(repo);
    expect(resolved.config.cadence).toBe('end');
    expect(resolved.config.quiz.enforced).toBe(true);
    expect(resolved.config.focus).toBe('learn');
  });

  it('ignores a cadence it does not recognise rather than failing the session', () => {
    writeGlobal({ cadence: 'whenever' });
    expect(loadConfig(repo).config.cadence).toBe('interleaved');
  });

  it('reads the checkpoint gap, and refuses a negative one', () => {
    expect(DEFAULT_CONFIG.min_minutes_between_checkpoints).toBe(4);
    writeGlobal({ min_minutes_between_checkpoints: 0 });
    expect(loadConfig(repo).config.min_minutes_between_checkpoints).toBe(0);
    writeGlobal({ min_minutes_between_checkpoints: -5 });
    expect(loadConfig(repo).config.min_minutes_between_checkpoints).toBe(4);
  });
});

describe('focus — the second dial', () => {
  it('defaults to concept — understanding that outlives the current diff', () => {
    expect(DEFAULT_CONFIG.focus).toBe('concept');
    expect(DEFAULT_CONFIG.focus_topic).toBe(null);
    writeGlobal({ quiz: { enforced: true } });
    expect(loadConfig(repo).config.focus).toBe('concept');
  });

  it('is independent of quiz — enforced plus learn is a real combination', () => {
    writeGlobal({ quiz: { enforced: true }, focus: 'learn', focus_topic: 'caching' });
    const { config } = loadConfig(repo);
    expect(config.quiz.enforced).toBe(true);
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
    writeGlobal({ quiz: { enforced: false }, focus: 'learn', focus_topic: 'caching' });
    writeRepo({ quiz: { enforced: true }, focus: 'project' });

    const resolved = loadConfig(repo);
    expect(resolved.config.focus).toBe('project'); // repo still wins
    expect(resolved.overrides.sort()).toEqual(['focus', 'quiz']);
  });

  it('does not report a repo setting the global never had as an override', () => {
    writeGlobal({ quiz: { enforced: false } });
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

describe('quiz — the dial that replaced `mode`', () => {
  it('defaults to questions on and nothing gated', () => {
    expect(DEFAULT_CONFIG.quiz).toEqual({ enabled: true, enforced: false });
  });

  // The compatibility promise. `.eklavya.json` is committed, so a repo written
  // against the old dial outlives the rename by years; dropping the alias would
  // not error, it would silently revert a lead's pinned gate to the default.
  it.each([
    ['ambient', { enabled: true, enforced: false }],
    ['enforced', { enabled: true, enforced: true }],
    ['off', { enabled: false, enforced: false }],
  ])('reads the retired `mode: %s` as its quiz equivalent', (mode, expected) => {
    writeGlobal({ mode });
    expect(loadConfig(repo).config.quiz).toEqual(expected);
  });

  it('lets an explicit quiz win over a mode left behind in the same file', () => {
    writeGlobal({ mode: 'off', quiz: { enabled: true, enforced: true } });
    expect(loadConfig(repo).config.quiz).toEqual({ enabled: true, enforced: true });
  });

  it('reads a repo `mode` over a global `quiz`, like any other repo override', () => {
    writeGlobal({ quiz: { enabled: true, enforced: false } });
    writeRepo({ mode: 'enforced' });
    expect(loadConfig(repo).config.quiz.enforced).toBe(true);
  });

  it('takes one flag without resetting the other', () => {
    writeGlobal({ quiz: { enforced: true } });
    const { quiz } = loadConfig(repo).config;
    expect(quiz).toEqual({ enabled: true, enforced: true });
  });

  // The one combination the flags can express and the enum could not. A gate
  // needs passed questions; with questions off nothing would ever ask one, so
  // enforcement here is a commit hook nobody can ever get past.
  it('refuses to enforce a gate that has no questions behind it', () => {
    writeGlobal({ quiz: { enabled: false, enforced: true } });
    expect(loadConfig(repo).config.quiz).toEqual({ enabled: false, enforced: false });
  });

  it('applies that rule across the file boundary too', () => {
    writeGlobal({ quiz: { enforced: true } });
    writeRepo({ quiz: { enabled: false } });
    expect(loadConfig(repo).config.quiz).toEqual({ enabled: false, enforced: false });
  });
});

describe('config validation', () => {
  it('ignores malformed values rather than adopting them', () => {
    writeGlobal({ mode: 'chaos', quiz: { enabled: 'yes' }, pass_threshold: 7, max_questions_per_task: -3 });
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
    writeConfigFile(file, { quiz: { enforced: true } });
    writeConfigFile(file, { quiet: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ quiz: { enforced: true }, quiet: true });
  });

  it('preserves keys Eklavya does not know about', () => {
    const file = path.join(home, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ future_setting: 42 }));
    writeConfigFile(file, { quiet: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).future_setting).toBe(42);
  });

  // Two checkouts can share a slug. A write for one must not take over the
  // file stamped for the other.
  it('refuses to write over a file stamped for a different checkout', () => {
    const file = path.join(home, 'project.json');
    fs.writeFileSync(file, JSON.stringify({ focus: 'concept', project: '/a/b-c' }));
    expect(() => writeConfigFile(file, { focus: 'project', project: '/a-b/c' })).toThrow(/different checkout/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ focus: 'concept', project: '/a/b-c' });
    expect(writeConfigFile(file, { focus: 'project', project: '/a/b-c' }).focus).toBe('project');
  });

  // Left beside a new `quiz.enabled: false`, `mode: enforced` resolved to
  // enforced-and-silent and `doctor` reported a conflict nobody wrote.
  it('folds a retired `mode` into a `quiz` written over it', () => {
    const file = path.join(home, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ mode: 'enforced' }));
    expect(writeConfigFile(file, { quiz: { enabled: false } })).toEqual({ quiz: { enabled: false, enforced: false } });

    fs.writeFileSync(file, JSON.stringify({ mode: 'enforced' }));
    expect(writeConfigFile(file, { quiz: { enabled: true } })).toEqual({ quiz: { enabled: true, enforced: true } });

    fs.writeFileSync(file, JSON.stringify({ mode: 'off' }));
    expect(writeConfigFile(file, { quiet: true })).toEqual({ mode: 'off', quiet: true });
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

describe('the difficulty dial', () => {
  it('defaults to earning the level, starting at easy', () => {
    expect(DEFAULT_CONFIG.difficulty).toBe('auto');
    expect(DEFAULT_CONFIG.level_up_after).toBe(100);
    expect(DEFAULT_CONFIG.level_up_accuracy).toBe(0.7);
  });

  it('accepts a pin, at either scope', () => {
    writeGlobal({ difficulty: 'hard' });
    expect(loadConfig(repo).config.difficulty).toBe('hard');

    // A repo pinning easy is an onboarding codebase that stays gentle for
    // everyone, and it must win over the contributor's own setting.
    writeRepo({ difficulty: 'easy' });
    const resolved = loadConfig(repo);
    expect(resolved.config.difficulty).toBe('easy');
    expect(resolved.overrides).toContain('difficulty');
  });

  it('ignores a level that is not a level', () => {
    writeGlobal({ difficulty: 'expert' });
    expect(loadConfig(repo).config.difficulty).toBe('auto');
  });

  it('ignores a runway that could never be reached', () => {
    writeGlobal({ level_up_after: 0, level_up_accuracy: 1.4 });
    const { config } = loadConfig(repo);
    expect(config.level_up_after).toBe(100);
    expect(config.level_up_accuracy).toBe(0.7);
  });

  it('takes a shortened runway as written', () => {
    writeGlobal({ level_up_after: 40, level_up_accuracy: 0.8 });
    const { config } = loadConfig(repo);
    expect(config.level_up_after).toBe(40);
    expect(config.level_up_accuracy).toBe(0.8);
  });
});
