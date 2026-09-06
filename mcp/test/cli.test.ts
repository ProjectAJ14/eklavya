import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDbPath, cleanup } from './helpers.js';

const cliPath = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'cli.js');

let dbFile = '';
let home = '';
let repo = '';
let claudeDir = '';
let runtimeDir = '';

function eklavya(args: string[], cwd = repo) {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      EKLAVYA_DB: dbFile,
      EKLAVYA_HOME: home,
      // `doctor` checks the install, so it has to be pointed at a fake one.
      // Without these it reads the developer's real ~/.claude and ~/.eklavya
      // and its exit code depends on whose machine the suite is running on.
      EKLAVYA_RUNTIME: runtimeDir,
      CLAUDE_CONFIG_DIR: claudeDir,
    },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * The smallest tree `health()` accepts: a compiled server, a loadable driver,
 * a registered-and-enabled plugin, and our own user skill. Each test that cares
 * about a failure breaks exactly one of these.
 */
function fakeInstall(): void {
  const driver = path.join(runtimeDir, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(path.join(runtimeDir, 'node_modules', 'eklavya', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'node_modules', 'eklavya', 'dist', 'server.js'), '');
  fs.mkdirSync(driver, { recursive: true });
  fs.writeFileSync(path.join(driver, 'package.json'), '{"main":"index.js"}');
  fs.writeFileSync(path.join(driver, 'index.js'), '');

  fs.mkdirSync(path.join(claudeDir, 'plugins', 'marketplaces', 'eklavya'), { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'eklavya@eklavya': [{ scope: 'user' }] } }),
  );
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'eklavya@eklavya': true } }),
  );

  const skill = path.join(claudeDir, 'skills', 'eklavya');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: eklavya\n---\n');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-repo-')));
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-claude-'));
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-rt-'));
  fs.mkdirSync(path.join(repo, '.git'));
  dbFile = tempDbPath('cli');
  fakeInstall();
});

afterEach(() => {
  cleanup(dbFile);
  for (const dir of [home, repo, claudeDir, runtimeDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('eklavya export-rules', () => {
  it('emits a Cursor rules file derived from the tutor skill', () => {
    const res = eklavya(['export-rules']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/alwaysApply: true/);
    // The pedagogy itself must come through, not just the wrapper.
    expect(res.stdout).toMatch(/One question at a time/);
    expect(res.stdout).toMatch(/record_attempt/);
    expect(res.stdout).toMatch(/get_learner_profile/);
  });

  it('strips the skill\'s own frontmatter so there is exactly one header', () => {
    const res = eklavya(['export-rules']);
    expect(res.stdout.match(/^---$/gm)?.length).toBe(2);
    expect(res.stdout).not.toMatch(/disable-model-invocation/);
  });

  it('inlines the reference files, because Cursor cannot open one on demand', () => {
    // The pedagogy lives in SKILL.md plus references/. Claude Code follows a
    // "read references/grading.md" pointer; a Cursor rules file is one
    // always-apply document where that pointer resolves to nothing. If this
    // breaks, Cursor gets the dispatch logic and none of the craft -- and every
    // other test still passes.
    const out = eklavya(['export-rules']).stdout;
    expect(out).toMatch(/Distractors are the whole question/);   // writing-mcq
    expect(out).toMatch(/A blank is not a skip/);                 // grading
    expect(out).toMatch(/reused on a different project/);         // focus-and-level
  });

  it('tells that editor the references are further down the same file', () => {
    expect(eklavya(['export-rules']).stdout).toMatch(/further down this\s+file/);
  });

  it('says where it came from, so nobody hand-edits the generated file', () => {
    expect(eklavya(['export-rules']).stdout).toMatch(/skills\/tutor\/SKILL\.md/);
  });

  it('writes to a file with --out, creating the directory', () => {
    const out = path.join(repo, '.cursor', 'rules', 'eklavya.md');
    const res = eklavya(['export-rules', '--out', out]);
    expect(res.status).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toMatch(/Eklavya tutor/);
  });

  it('complains when --out has no path', () => {
    expect(eklavya(['export-rules', '--out']).status).toBe(1);
  });
});

describe('eklavya config', () => {
  it('prints the effective config and where it came from', () => {
    const res = eklavya(['config', 'get']);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.slice(0, res.stdout.indexOf('\n\n'))).mode).toBe('ambient');
    expect(res.stdout).toMatch(/repo:\s+\(none\)/);
  });

  it('sets a global value and reads it back', () => {
    expect(eklavya(['config', 'set', 'mode', 'enforced']).status).toBe(0);
    expect(eklavya(['config', 'get']).stdout).toMatch(/"mode": "enforced"/);
  });

  it('coerces numbers and booleans rather than storing strings', () => {
    eklavya(['config', 'set', 'pass_threshold', '0.9']);
    eklavya(['config', 'set', 'quiet', 'true']);
    const written = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(written.pass_threshold).toBe(0.9);
    expect(written.quiet).toBe(true);
  });

  it('scopes to the repo with --repo, and the repo wins', () => {
    eklavya(['config', 'set', 'mode', 'ambient']);
    expect(eklavya(['config', 'set', 'mode', 'enforced', '--repo']).status).toBe(0);
    expect(fs.existsSync(path.join(repo, '.eklavya.json'))).toBe(true);
    expect(eklavya(['config', 'get']).stdout).toMatch(/"mode": "enforced"/);
  });

  it('refuses an unknown setting instead of writing junk', () => {
    const res = eklavya(['config', 'set', 'made_up_key', '1']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Unknown setting/);
  });
});

describe('eklavya doctor', () => {
  it('reports the database, seed count and journal mode', () => {
    const res = eklavya(['doctor']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/journal:\s+wal/);
    expect(res.stdout).toMatch(/concepts: 8\d/);
    expect(res.stdout).toMatch(/mode:\s+ambient/);
  });

  it('creates the database if it does not exist yet', () => {
    expect(fs.existsSync(dbFile)).toBe(false);
    eklavya(['doctor']);
    expect(fs.existsSync(dbFile)).toBe(true);
  });
});

describe('eklavya doctor checks the install', () => {
  it('passes and stays silent when everything is wired up', () => {
    const res = eklavya(['doctor']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/runtime:\s+\//);
    expect(res.stdout).toMatch(/driver:\s+better-sqlite3 loads/);
    expect(res.stdout).toMatch(/plugin:.*registered, enabled/);
    expect(res.stdout).toMatch(/skill:\s+\//);
    expect(res.stdout).not.toMatch(/FAILED/);
    expect(res.stdout).not.toMatch(/Something is broken/);
  });

  // The point of the whole feature: each of these breaks silently in real use,
  // because every hook exits 0 whatever happens. `doctor` is the only place
  // that says so, and it must name the repair — a report nobody can act on is
  // worse than no report.
  const breakages: Array<[string, () => void, RegExp]> = [
    [
      'the runtime is gone',
      () => fs.rmSync(path.join(runtimeDir, 'node_modules', 'eklavya'), { recursive: true, force: true }),
      /runtime:\s+FAILED — no compiled server at/,
    ],
    [
      'the native driver will not load',
      () =>
        fs.writeFileSync(
          path.join(runtimeDir, 'node_modules', 'better-sqlite3', 'index.js'),
          'throw new Error("dlopen: wrong ABI");',
        ),
      /driver:\s+FAILED — will not load on Node .* — Error: dlopen: wrong ABI/,
    ],
    [
      'the plugin was dropped from the registry',
      () =>
        fs.writeFileSync(
          path.join(claudeDir, 'plugins', 'installed_plugins.json'),
          JSON.stringify({ version: 2, plugins: {} }),
        ),
      /plugin:\s+FAILED — .*on disk but not registered/,
    ],
    [
      'the plugin was switched off',
      () =>
        fs.writeFileSync(
          path.join(claudeDir, 'settings.json'),
          JSON.stringify({ enabledPlugins: { 'eklavya@eklavya': false } }),
        ),
      /plugin:\s+FAILED — registered but not enabled/,
    ],
    [
      // Anything but an explicit `true` is off. Reading a vanished key as
      // healthy would hide the exact failure this command exists to catch.
      'the enablement key vanished entirely',
      () => fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({})),
      /plugin:\s+FAILED — registered but not enabled/,
    ],
    [
      'the user skill is gone',
      () => fs.rmSync(path.join(claudeDir, 'skills', 'eklavya'), { recursive: true, force: true }),
      /skill:\s+FAILED — nothing at/,
    ],
  ];

  for (const [name, breakIt, expected] of breakages) {
    it(`fails, says why and names the fix when ${name}`, () => {
      breakIt();
      const res = eklavya(['doctor']);
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(expected);
      expect(res.stdout).toMatch(/Something is broken\. Run: eklavya install/);
    });
  }

  // `install` will not overwrite a skill that is not ours, so pointing at it
  // would be a dead end. This one has to name the step that unblocks it.
  it('does not tell you to re-install over somebody else\'s skill', () => {
    fs.writeFileSync(
      path.join(claudeDir, 'skills', 'eklavya', 'SKILL.md'),
      '---\nname: my-own-thing\n---\n',
    );
    const res = eklavya(['doctor']);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/skill:\s+FAILED — .*different skill named eklavya — move it first/);
  });

  // A broken install must not cost the report: whoever is reading this still
  // needs to see their mode and level, not a stack trace.
  it('still reports config and level when the install is broken', () => {
    fs.rmSync(path.join(runtimeDir, 'node_modules'), { recursive: true, force: true });
    const res = eklavya(['doctor']);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/mode:\s+ambient/);
    expect(res.stdout).toMatch(/level:\s+easy/);
  });
});

describe('eklavya misc', () => {
  it('prints the database path', () => {
    expect(eklavya(['db-path']).stdout.trim()).toBe(dbFile);
  });

  it('shows usage with no arguments', () => {
    const res = eklavya([]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Usage:/);
  });

  it('exits non-zero on an unknown command', () => {
    expect(eklavya(['nonsense']).status).toBe(1);
  });
});

describe('eklavya doctor reports the difficulty level', () => {
  it('names the level and the runway', () => {
    const res = eklavya(['doctor']);
    expect(res.stdout).toMatch(/level:\s+easy \(0\/100 passing answers in/);
  });

  it('says when a pin is switching progression off', () => {
    eklavya(['config', 'set', 'difficulty', 'hard']);
    expect(eklavya(['doctor']).stdout).toMatch(/level:\s+hard \(pinned by config/);
  });
});
