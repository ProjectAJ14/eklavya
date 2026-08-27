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

function eklavya(args: string[], cwd = repo) {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
  dbFile = tempDbPath('cli');
});

afterEach(() => {
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
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
