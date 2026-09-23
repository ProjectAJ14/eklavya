import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configFileProblem,
  isGlobalOnlyKey,
  loadConfig,
  migrateLegacyRepoConfig,
  writeConfigFile,
} from '../src/config.js';
import { openDb } from '../src/db.js';
import { projectConfigPath } from '../src/paths.js';
import { UnreadableFileError } from '../src/safe-write.js';

/**
 * The config files are the developer's, and the database is their history.
 *
 * Three promises, each of which was broken before this file existed: a config
 * file Eklavya cannot parse is never overwritten (it used to be read as `{}`
 * and replaced by the one key being set), every write leaves the previous bytes
 * in `<file>.eklavya-bak`, and nothing under `~/.eklavya` is readable by other
 * users of the machine.
 */

let home = '';
let repo = '';
let priorHome: string | undefined;
let priorDb: string | undefined;

const globalFile = () => path.join(home, 'config.json');
const mode = (file: string) => fs.statSync(file).mode & 0o777;
const posix = process.platform !== 'win32';

beforeEach(() => {
  priorHome = process.env.EKLAVYA_HOME;
  priorDb = process.env.EKLAVYA_DB;
  home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-safety-')), 'home');
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-safety-repo-')));
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  process.env.EKLAVYA_HOME = home;
  delete process.env.EKLAVYA_DB;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = priorHome;
  if (priorDb === undefined) delete process.env.EKLAVYA_DB;
  else process.env.EKLAVYA_DB = priorDb;
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('writeConfigFile on a file it cannot parse', () => {
  it('refuses, and leaves every byte where it was', () => {
    fs.mkdirSync(home, { recursive: true });
    const broken = '{ "focus": "project", "memory": { "enabled": false }, }\n';
    fs.writeFileSync(globalFile(), broken);

    expect(() => writeConfigFile(globalFile(), { difficulty: 'hard' })).toThrow(UnreadableFileError);
    expect(fs.readFileSync(globalFile(), 'utf8')).toBe(broken);
    expect(fs.existsSync(`${globalFile()}.eklavya-bak`)).toBe(false);
  });

  it('refuses a file that parses to something other than an object', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(globalFile(), '["focus"]');
    expect(() => writeConfigFile(globalFile(), { focus: 'concept' })).toThrow(UnreadableFileError);
    expect(fs.readFileSync(globalFile(), 'utf8')).toBe('["focus"]');
  });

  it('treats an empty file as missing, since there is nothing in it to lose', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(globalFile(), '');
    writeConfigFile(globalFile(), { focus: 'learn' });
    expect(JSON.parse(fs.readFileSync(globalFile(), 'utf8'))).toEqual({ focus: 'learn' });
  });

  it('keeps a legacy repo file in place when the project file it would merge into is broken', () => {
    fs.writeFileSync(path.join(repo, '.eklavya.json'), JSON.stringify({ focus: 'project' }));
    const target = projectConfigPath(repo);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{ nope');

    expect(migrateLegacyRepoConfig(repo)).toBe(false);
    expect(fs.existsSync(path.join(repo, '.eklavya.json'))).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('{ nope');
  });
});

describe('writeConfigFile backs up before it changes anything', () => {
  it('copies the previous bytes to <file>.eklavya-bak', () => {
    writeConfigFile(globalFile(), { focus: 'project' });
    const first = fs.readFileSync(globalFile(), 'utf8');
    // The first write had nothing to back up.
    expect(fs.existsSync(`${globalFile()}.eklavya-bak`)).toBe(false);

    writeConfigFile(globalFile(), { cadence: 'end' });
    expect(fs.readFileSync(`${globalFile()}.eklavya-bak`, 'utf8')).toBe(first);
    expect(JSON.parse(fs.readFileSync(globalFile(), 'utf8'))).toEqual({ focus: 'project', cadence: 'end' });
  });

  it('writes a project file the same way', () => {
    const target = projectConfigPath(repo);
    writeConfigFile(target, { focus: 'project', project: repo });
    writeConfigFile(target, { cadence: 'end', project: repo });
    expect(JSON.parse(fs.readFileSync(`${target}.eklavya-bak`, 'utf8'))).toEqual({ focus: 'project', project: repo });
  });
});

describe('configFileProblem', () => {
  it('is null when both files are fine or absent', () => {
    expect(configFileProblem(repo)).toBeNull();
    writeConfigFile(globalFile(), { focus: 'project' });
    expect(configFileProblem(repo)).toBeNull();
  });

  it('names a global file that does not parse, and loadConfig still falls back to defaults', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(globalFile(), '{ "focus": ');

    const problem = configFileProblem(repo);
    expect(problem).toContain(globalFile());
    expect(problem).toMatch(/not valid JSON/);
    expect(loadConfig(repo).config.focus).toBe('concept');
  });

  it('names this project’s file when that is the broken one', () => {
    const target = projectConfigPath(repo);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'focus=project');

    const problem = configFileProblem(repo);
    expect(problem).toContain(target);
    expect(problem).not.toContain(globalFile());
  });

  it('names both when both are broken', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(globalFile(), '{');
    const target = projectConfigPath(repo);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{');

    const problem = configFileProblem(repo) ?? '';
    expect(problem).toContain(globalFile());
    expect(problem).toContain(target);
  });

  it('is callable with no argument, from the current directory', () => {
    expect(configFileProblem()).toBeNull();
  });
});

// One machine-wide queue holds every project's events, and the worker drains
// it with whatever config it was started under. A project-level observer
// would therefore decide whether *another* project's work leaves the machine.
describe('providers are global-only', () => {
  function writeProject(config: Record<string, unknown>): void {
    const target = projectConfigPath(repo);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ ...config, project: repo }));
  }

  it('ignores providers.observer set in a project file, and says so', () => {
    writeProject({ focus: 'project', providers: { observer: { kind: 'anthropic', model: 'theirs' } } });
    const resolved = loadConfig(repo);
    expect(resolved.config.providers.observer).toBeNull();
    expect(resolved.ignored).toEqual(['providers']);
    // The rest of the project file still applies.
    expect(resolved.config.focus).toBe('project');
  });

  it('keeps the global setting when a project tries to clear it', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(globalFile(), JSON.stringify({ providers: { observer: { kind: 'anthropic', model: 'mine' } } }));
    writeProject({ providers: { observer: null } });

    const resolved = loadConfig(repo);
    expect(resolved.config.providers.observer?.model).toBe('mine');
    expect(resolved.overrides).not.toContain('providers');
  });

  it('applies the global setting everywhere', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(globalFile(), JSON.stringify({ providers: { observer: { kind: 'anthropic', model: 'mine' } } }));
    expect(loadConfig(repo).config.providers.observer?.model).toBe('mine');
    expect(loadConfig(repo).ignored).toEqual([]);
  });

  it('isGlobalOnlyKey covers the namespace and every key under it', () => {
    expect(isGlobalOnlyKey('providers')).toBe(true);
    expect(isGlobalOnlyKey('providers.observer')).toBe(true);
    expect(isGlobalOnlyKey('providers.embeddings')).toBe(true);
    expect(isGlobalOnlyKey('focus')).toBe(false);
    expect(isGlobalOnlyKey('providersx')).toBe(false);
  });
});

describe.runIf(posix)('file permissions', () => {
  it('creates ~/.eklavya as 0700 and the database, WAL and SHM as 0600', () => {
    const db = openDb();
    try {
      db.prepare('CREATE TABLE IF NOT EXISTS perm_probe (x)').run();
      db.prepare('INSERT INTO perm_probe VALUES (1)').run();
      expect(mode(home)).toBe(0o700);
      const file = path.join(home, 'knowledge.db');
      expect(mode(file)).toBe(0o600);
      for (const side of ['-wal', '-shm']) {
        if (fs.existsSync(file + side)) expect(mode(file + side)).toBe(0o600);
      }
    } finally {
      db.close();
    }
  });

  it('tightens an existing install that was left world-readable', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.chmodSync(home, 0o755);
    openDb().close();
    const file = path.join(home, 'knowledge.db');
    fs.chmodSync(file, 0o644);
    fs.chmodSync(home, 0o755);

    openDb().close();
    expect(mode(home)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
  });

  it('writes config.json as 0600, and tightens one that was 0644', () => {
    writeConfigFile(globalFile(), { focus: 'project' });
    expect(mode(globalFile())).toBe(0o600);
    expect(mode(home)).toBe(0o700);

    fs.chmodSync(globalFile(), 0o644);
    writeConfigFile(globalFile(), { cadence: 'end' });
    expect(mode(globalFile())).toBe(0o600);
    expect(mode(`${globalFile()}.eklavya-bak`)).toBe(0o600);
  });

  it('leaves the directory of a database pointed elsewhere alone, but makes the file private', () => {
    // EKLAVYA_DB can name any file; its directory is created private only if
    // Eklavya is the one creating it.
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-shared-'));
    fs.chmodSync(shared, 0o755);
    process.env.EKLAVYA_DB = path.join(shared, 'k.db');
    try {
      openDb().close();
      expect(mode(shared)).toBe(0o755);
      expect(mode(path.join(shared, 'k.db'))).toBe(0o600);
    } finally {
      fs.rmSync(shared, { recursive: true, force: true });
    }
  });
});
