import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, type DB } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { validateSeedGraph, type SeedGraph } from '../src/seed.js';
import { packFingerprint } from '../src/packs.js';
import { workSince } from '../src/session.js';
import { DEFAULT_PORT, dashboardPort, makePrivate } from '../src/paths.js';
import { hasAskedQuestion, insertConcept, mergeWorktreeProjects, resolveTopic } from '../src/store.js';
import { tokenJaccard } from '../src/slug.js';
import { readStdinBounded } from '../src/stdin.js';
import { parseStamp } from '../src/time.js';
import { DEFAULT_CONFIG, coerce, mainRepoRoot, readConfigFile, writeConfigFile } from '../src/config.js';
import {
  SETTING_RULES,
  applySetting,
  defaultAt,
  normalizeSetting,
  parseValue,
  settingProblem,
} from '../src/config-path.js';
import { tempDbPath, cleanup } from './helpers.js';

let tmp = '';
const envBackup = { ...process.env };

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-core-')));
  process.env.EKLAVYA_HOME = path.join(tmp, 'home');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = { ...envBackup };
});

describe('coerce, namespaced fields', () => {
  it('keeps what is valid and drops what is not', () => {
    const out = coerce(
      {
        dashboard_autostart: false,
        memory: { batch_max_events: 12.7, retention_days: null },
        privacy: { redact_patterns: ['sk-[a-z]+'] },
        retrieval: { mode: 'hybrid', max_tokens: 900.5 },
        notifications: {
          sinks: [
            null,
            'not a sink',
            { kind: 'pager', target: 'x' },
            { kind: 'file', target: '   ' },
            { kind: 'file', target: ' /tmp/out.log ' },
          ],
        },
        providers: { observer: { kind: 'openai', model: 'x' }, embeddings: { kind: 'anthropic', model: '  ' } },
        sync: { target: null, device_id: ' laptop ' },
      },
      DEFAULT_CONFIG,
    );
    expect(out.dashboard_autostart).toBe(false);
    expect(out.memory.batch_max_events).toBe(12);
    expect(out.memory.retention_days).toBeNull();
    expect(out.privacy.redact_patterns).toEqual(['sk-[a-z]+']);
    expect(out.retrieval).toMatchObject({ mode: 'hybrid', max_tokens: 900 });
    expect(out.notifications.sinks).toEqual([{ kind: 'file', target: '/tmp/out.log', args: undefined, events: undefined }]);
    expect(out.providers).toEqual({ observer: null, embeddings: null });
    expect(out.sync).toMatchObject({ target: null, device_id: 'laptop' });
  });

  it('ignores out-of-range numbers and clears a device id set to null', () => {
    const out = coerce(
      {
        memory: { batch_max_events: 0 },
        retrieval: { mode: 'fuzzy', max_tokens: -1 },
        sync: { device_id: null },
      },
      { ...DEFAULT_CONFIG, sync: { ...DEFAULT_CONFIG.sync, device_id: 'old' } },
    );
    expect(out.memory.batch_max_events).toBe(DEFAULT_CONFIG.memory.batch_max_events);
    expect(out.retrieval.mode).toBe(DEFAULT_CONFIG.retrieval.mode);
    expect(out.retrieval.max_tokens).toBe(DEFAULT_CONFIG.retrieval.max_tokens);
    expect(out.sync.device_id).toBeNull();
  });
});

describe('mainRepoRoot', () => {
  it('keeps a .git file that names no gitdir', () => {
    fs.writeFileSync(path.join(tmp, '.git'), 'something else\n');
    expect(mainRepoRoot(tmp)).toBe(tmp);
  });

  it('keeps a gitdir outside the worktrees layout, as a submodule has', () => {
    fs.writeFileSync(path.join(tmp, '.git'), 'gitdir: ../elsewhere/modules/lib\n');
    expect(mainRepoRoot(tmp)).toBe(tmp);
  });
});

describe('config files', () => {
  it('reads a file holding a JSON array as empty settings', () => {
    const file = path.join(tmp, 'config.json');
    fs.writeFileSync(file, '[1, 2]');
    expect(readConfigFile(file)).toEqual({});
  });

  it('retires a legacy mode even when the quiz written is empty', () => {
    const file = path.join(tmp, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ mode: 'enforced' }));
    writeConfigFile(file, { quiz: undefined });
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.mode).toBeUndefined();
    expect(written.quiz).toEqual({ enabled: true, enforced: true });
  });
});

describe('config-path parsing', () => {
  it('has no default under a leaf', () => {
    expect(defaultAt('quiz.enabled.deeper')).toBeUndefined();
  });

  it('parses by the type of the default at that key', () => {
    expect(parseValue('memory.retention_days', '30')).toBe(30);
    expect(parseValue('memory.retention_days', 'forever')).toBe('forever');
    expect(parseValue('quiet', 'maybe')).toBe('maybe');
    expect(parseValue('level_up_after', 'ten')).toBe('ten');
    expect(parseValue('quiz', '{"enabled":false}')).toEqual({ enabled: false });
    expect(parseValue('quiz', '{broken')).toBe('{broken');
    expect(parseValue('no.such.key', 'text')).toBe('text');
  });

  it('keeps a non-string list item for validation to refuse', () => {
    expect(normalizeSetting('domains_enabled', [' react ', 7, ''])).toEqual(['react', 7]);
  });

  it('says a list line is too long', () => {
    expect(settingProblem('privacy.exclude_tools', ['x'.repeat(201)])).toBe('privacy.exclude_tools lines are at most 200 characters.');
  });

  it('asks for text without offering to clear a text setting that cannot be empty', () => {
    SETTING_RULES['test.required_text'] = { type: 'text', nullable: false, maxLength: 10 };
    try {
      expect(settingProblem('test.required_text', '  ')).toBe('test.required_text needs some text.');
    } finally {
      delete SETTING_RULES['test.required_text'];
    }
  });
});

describe('applySetting', () => {
  it('refuses an unknown key', () => {
    expect(() => applySetting('no_such_setting', 1, null)).toThrow(/Unknown setting "no_such_setting"/);
  });

  it('refuses a value the rules allow but coerce would drop', () => {
    const original = SETTING_RULES.cadence!;
    SETTING_RULES.cadence = { type: 'enum', options: ['interleaved', 'end', 'sometimes'] };
    try {
      expect(() => applySetting('cadence', 'sometimes', null)).toThrow('"sometimes" is not a valid value for cadence.');
    } finally {
      SETTING_RULES.cadence = original;
    }
  });

  it('writes companion settings alongside, normalised, and checks them', () => {
    const { target, patch } = applySetting('focus', 'learn', null, { focus_topic: '  react hooks  ' });
    expect(patch).toMatchObject({ focus: 'learn', focus_topic: 'react hooks' });
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toMatchObject({ focus: 'learn', focus_topic: 'react hooks' });
    expect(() => applySetting('focus', 'learn', null, { focus_topic: 42 })).toThrow(/focus_topic/);
  });
});

describe('database and migrations', () => {
  it('lets SQLite report a path it cannot open', () => {
    // A directory: the 0600 pre-create fails quietly, then SQLite refuses it.
    expect(() => openDb(tmp)).toThrow();
  });

  it('refuses a migration file without a number', () => {
    const dir = path.join(tmp, 'migrations');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'abc_init.sql'), 'SELECT 1;');
    const db = new Database(':memory:');
    try {
      expect(() => runMigrations(db, dir)).toThrow('Migration filename must start with a number: abc_init.sql');
    } finally {
      db.close();
    }
  });

  it('reads no work stretch from a database without a meta table', () => {
    const db = new Database(':memory:');
    try {
      expect(workSince(db as unknown as DB, 's1')).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('seed validation', () => {
  const concept = (slug: string, over: Record<string, unknown> = {}) => ({ slug, name: slug, tier: 1, ...over });
  const graph = (over: Partial<SeedGraph>): SeedGraph => ({ domain: 'd', concepts: [concept('a'), concept('b')], ...over }) as SeedGraph;

  it.each([
    ['missing domain', graph({ domain: '' }), 'f.json: missing "domain"'],
    ['empty concept list', graph({ concepts: [] }), 'f.json: "concepts" must be a non-empty array'],
    ['duplicate slug', graph({ concepts: [concept('a'), concept('a')] as SeedGraph['concepts'] }), 'f.json: duplicate slug "a"'],
    ['missing name', graph({ concepts: [concept('a', { name: '' })] as SeedGraph['concepts'] }), 'f.json: concept "a" missing name'],
    ['self edge', graph({ edges: [{ from: 'a', to: 'a', relation: 'related_to' }] }), 'f.json: self-edge on "a"'],
    ['unknown from', graph({ edges: [{ from: 'zz', to: 'a', relation: 'related_to' }] }), 'f.json: edge from unknown slug "zz"'],
  ])('refuses a %s', (_label, g, message) => {
    expect(() => validateSeedGraph(g, 'f.json')).toThrow(message);
  });

  it('checks both ends of an external edge are valid slugs', () => {
    const opts = { allowExternalEdges: true };
    expect(() => validateSeedGraph(graph({ edges: [{ from: 'Bad Slug', to: 'a', relation: 'related_to' }] }), 'p.json', opts))
      .toThrow('p.json: edge from invalid slug "Bad Slug"');
    expect(() => validateSeedGraph(graph({ edges: [{ from: 'a', to: 'Bad Slug', relation: 'related_to' }] }), 'p.json', opts))
      .toThrow('p.json: edge to invalid slug "Bad Slug"');
    expect(() => validateSeedGraph(graph({ edges: [{ from: 'a', to: 'shipped-concept', relation: 'related_to' }] }), 'p.json', opts))
      .not.toThrow();
  });
});

describe('pack fingerprint', () => {
  it('still hashes a file that vanished, by its path', () => {
    const gone = path.join(tmp, 'gone.json');
    const a = packFingerprint([gone]);
    expect(a).toBe(packFingerprint([gone]));
    fs.writeFileSync(gone, '{}');
    expect(packFingerprint([gone])).not.toBe(a);
  });
});

describe('paths', () => {
  it('leaves permissions alone where there is no uid to compare, as on Windows', () => {
    const file = path.join(tmp, 'f');
    fs.writeFileSync(file, 'x', { mode: 0o644 });
    const getuid = process.getuid;
    (process as { getuid?: unknown }).getuid = undefined;
    try {
      makePrivate(file, 0o600);
    } finally {
      process.getuid = getuid;
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });

  it('leaves a path owned by another account alone', () => {
    // `/` is root's; the suite never runs as root in CI, and asking for 0o777
    // means nothing would be tightened even if it did.
    const before = fs.statSync('/').mode;
    makePrivate('/', 0o777);
    expect(fs.statSync('/').mode).toBe(before);
  });

  it('falls back to the default port for a nonsense override', () => {
    process.env.EKLAVYA_DASHBOARD_PORT = 'not-a-port';
    expect(dashboardPort()).toBe(DEFAULT_PORT);
    process.env.EKLAVYA_DASHBOARD_PORT = '70000';
    expect(dashboardPort()).toBe(DEFAULT_PORT);
  });
});

describe('store helpers', () => {
  let dbFile = '';
  let db: DB;
  beforeEach(() => {
    dbFile = tempDbPath('core-store');
    db = openDb(dbFile);
  });
  afterEach(() => {
    db.close();
    cleanup(dbFile);
  });

  it('records a concept with no stated source as the model’s', () => {
    expect(insertConcept(db, { slug: 'no-source-given', name: 'No source', domain: 'general', tier: 1 }).source).toBe('llm');
  });

  it('never matches a question with nothing left to fingerprint', () => {
    const c = insertConcept(db, { slug: 'fp-empty', name: 'fp', domain: 'general', tier: 1 });
    db.prepare('INSERT INTO attempts (concept_id, question, grade, difficulty) VALUES (?, ?, 3, 1)').run(c.id, '???');
    expect(hasAskedQuestion(db, c.id, '???')).toBe(false);
  });

  it('resolves a blank topic to nothing', () => {
    expect(resolveTopic(db, '   ')).toEqual({ domain: null, slugs: [] });
  });

  it('folds a worktree’s answers into its main checkout even with no level row', () => {
    const main = path.join(tmp, 'main');
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
    const c = insertConcept(db, { slug: 'wt-fold', name: 'wt', domain: 'general', tier: 1 });
    db.prepare('INSERT INTO attempts (concept_id, question, grade, difficulty, repo) VALUES (?, ?, 3, 1, ?)').run(c.id, 'q?', wt);
    db.prepare("DELETE FROM meta WHERE key = 'worktree_projects_merged'").run();

    mergeWorktreeProjects(db);
    expect((db.prepare('SELECT repo FROM attempts WHERE concept_id = ?').get(c.id) as { repo: string }).repo).toBe(main);
    expect(db.prepare('SELECT count(*) AS n FROM project_levels').get()).toEqual({ n: 0 });
  });
});

describe('small parsers', () => {
  it('scores an empty slug as sharing nothing', () => {
    expect(tokenJaccard('', 'a-b')).toBe(0);
  });

  it('reads an unparseable timestamp as null', () => {
    expect(parseStamp('not a time')).toBeNull();
  });

  it('reads nothing from a terminal instead of waiting for a human', async () => {
    const stdin = process.stdin as { isTTY?: boolean };
    const was = stdin.isTTY;
    stdin.isTTY = true;
    try {
      await expect(readStdinBounded()).resolves.toBe('');
    } finally {
      stdin.isTTY = was;
    }
  });
});
