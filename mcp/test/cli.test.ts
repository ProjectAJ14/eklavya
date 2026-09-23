import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { tempDbPath, cleanup } from './helpers.js';
import { openDb } from '../src/db.js';
import { setCurrentSession, setSessionOff } from '../src/session.js';
import { appendEvent, insertEntry } from '../src/memory/store.js';
import { projectKey } from '../src/store.js';

const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(mcpRoot, 'dist', 'cli.js');

let dbFile = '';
let home = '';
let repo = '';
let claudeDir = '';
let runtimeDir = '';

function eklavya(args: string[], cwd = repo, input?: string) {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
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
    // Mid-body, not a heading: a heading survives the body being deleted.
    expect(out).toMatch(/Options belong in/);                     // writing-mcq
    expect(out).toMatch(/A blank is not a skip/);                 // grading
    expect(out).toMatch(/reused on a different project/);         // focus-and-level
  });

  it('tells that editor the references are further down the same file', () => {
    expect(eklavya(['export-rules']).stdout).toMatch(/further down this same\s+file/);
  });

  it('refuses to emit a rules file when a reference did not bundle', () => {
    // The preamble tells the editor the material is further down this file. If
    // a reference is missing that promise is false, and it is worse than an
    // empty file: the model is assured the rules are here somewhere and hunts
    // instead of falling back. `copy-assets.mjs` only warns when a copy fails,
    // so a half-bundled build is reachable rather than hypothetical.
    //
    // Run from a copy of dist/ so the real one stays intact for every other
    // test; inside mcp/ so the driver still resolves through mcp/node_modules.
    const staged = path.join(mcpRoot, '.tmp-export-rules');
    fs.rmSync(staged, { recursive: true, force: true });
    try {
      fs.cpSync(path.join(mcpRoot, 'dist'), path.join(staged, 'dist'), { recursive: true });
      const refs = path.join(staged, 'dist', 'assets', 'tutor', 'references');
      const victim = fs.readdirSync(refs).filter((f) => f.endsWith('.md')).sort()[0];
      fs.rmSync(path.join(refs, victim));

      const res = spawnSync(process.execPath, [path.join(staged, 'dist', 'cli.js'), 'export-rules'], {
        encoding: 'utf8',
        env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home },
      });

      expect(res.status).toBe(1);
      expect(res.stderr).toContain(victim);
      // And nothing on stdout that an editor would mistake for a rules file.
      expect(res.stdout ?? '').not.toMatch(/alwaysApply/);
    } finally {
      fs.rmSync(staged, { recursive: true, force: true });
    }
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
    expect(JSON.parse(res.stdout.slice(0, res.stdout.indexOf('\n\n'))).quiz).toEqual({
      enabled: true,
      enforced: false,
    });
    expect(res.stdout).toMatch(/project: .+projects./);
  });

  it('sets a global value and reads it back', () => {
    expect(eklavya(['config', 'set', 'quiz.enforced', 'true']).status).toBe(0);
    expect(eklavya(['config', 'get']).stdout).toMatch(/"enforced": true/);
  });

  // `mode` is not a settable key any more, but people have it in their fingers
  // and in every doc written before the rename. Translating and saying so beats
  // a dead-end "unknown setting" for a word that still works in config files.
  it('translates a legacy `config set mode` rather than refusing it', () => {
    const res = eklavya(['config', 'set', 'mode', 'off']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/quiz\.enabled false/);
    expect(res.stdout).toMatch(/memory keeps recording/);
    expect(eklavya(['config', 'get']).stdout).toMatch(/"enabled": false/);
  });

  it('coerces numbers and booleans rather than storing strings', () => {
    eklavya(['config', 'set', 'pass_threshold', '0.9']);
    eklavya(['config', 'set', 'quiet', 'true']);
    const written = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(written.pass_threshold).toBe(0.9);
    expect(written.quiet).toBe(true);
  });

  it('scopes to the project with --repo, and the project wins', () => {
    eklavya(['config', 'set', 'quiz.enforced', 'false']);
    expect(eklavya(['config', 'set', 'quiz.enforced', 'true', '--repo']).status).toBe(0);
    // Outside the checkout, keyed by it. Nothing lands in the working tree.
    expect(fs.existsSync(path.join(repo, '.eklavya.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'projects', repo.replace(/[/\\:]/g, '-'), 'config.json'))).toBe(true);
    expect(eklavya(['config', 'get']).stdout).toMatch(/"enforced": true/);
  });

  it('refuses an unknown setting instead of writing junk', () => {
    const res = eklavya(['config', 'set', 'made_up_key', '1']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Unknown setting/);
  });
});

/** A pack in the learner's own directory — the scope `doctor` labels `global`. */
function writeGlobalPack(name: string, body: unknown): void {
  const dir = path.join(home, 'packs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body));
}

describe('eklavya doctor', () => {
  it('reports the database, seed count and journal mode', () => {
    const res = eklavya(['doctor']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/journal\s+wal/);
    expect(res.stdout).toMatch(/concepts\s+8\d/);
    expect(res.stdout).toMatch(/quiz\s+on/);
  });

  it('creates the database if it does not exist yet', () => {
    expect(fs.existsSync(dbFile)).toBe(false);
    eklavya(['doctor']);
    expect(fs.existsSync(dbFile)).toBe(true);
  });

  it('names each concept pack it loaded, with its scope', () => {
    writeGlobalPack('rust', {
      pack: 'eklavya-pack-rust',
      version: '1.0.0',
      domain: 'rust',
      concepts: [{ slug: 'rust-ownership', name: 'Ownership', tier: 1 }],
    });
    const res = eklavya(['doctor']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/1 loaded — eklavya-pack-rust@1\.0\.0 \(global\)/);
  });

  it('counts an edge whose endpoint names nothing, which is silent everywhere else', () => {
    writeGlobalPack('typo', {
      pack: 'typo',
      domain: 'rust',
      concepts: [{ slug: 'rust-ownership', name: 'Ownership', tier: 1 }],
      edges: [{ from: 'rust-ownershp', to: 'rust-ownership', relation: 'prerequisite_of' }],
    });
    expect(eklavya(['doctor']).stdout).toMatch(/1 edge\(s\) dropped/);
  });

  it('reports a broken pack without failing the run', () => {
    // The blanket remedy `doctor` prints is `eklavya install`, which never
    // touches ~/.eklavya/packs/ and could not repair this if it wanted to.
    fs.mkdirSync(path.join(home, 'packs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'packs', 'broken.json'), '{ not json');
    const res = eklavya(['doctor']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/FAILED/);
    expect(res.stdout).not.toMatch(/Run: eklavya install/);
  });
});

describe('eklavya doctor reports the memory half', () => {
  it('answers on an empty database without throwing or inventing numbers', () => {
    const res = eklavya(['doctor']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/on · capture full/);
    expect(res.stdout).toMatch(/0 entries, 0 evidence events \(0 not yet summarised\)/);
    expect(res.stdout).toMatch(/queue 0 pending · 0 paused · 0 failed/);
    expect(res.stdout).toMatch(/last evidence — none captured yet/);
    expect(res.stdout).toMatch(/sync off/);
    expect(res.stdout).toMatch(/provider none — nothing leaves this machine/);
  });

  it('fails on a paused queue and names the fix, with the class and never the message', () => {
    const db = openDb(dbFile);
    db.prepare("INSERT INTO memory_batches (project, session_id, reason) VALUES (?, 's1', 'manual')").run(repo);
    db.prepare(
      `INSERT INTO memory_jobs (batch_id, status, error_class, last_error)
       VALUES (1, 'paused', 'auth', 'https://api.example.com?key=sk-do-not-print-me')`,
    ).run();
    db.close();

    const res = eklavya(['doctor']);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/FAILED — 1 job\(s\) paused \(auth\)/);
    expect(res.stdout).toMatch(/log in to Claude Code/);
    expect(res.stdout).not.toMatch(/PATH/);
    expect(res.stdout).toMatch(/eklavya memory process/);
    // `last_error` is the provider's own prose and has carried a token in it.
    expect(res.stdout).not.toContain('sk-do-not-print-me');
    // The blanket remedy is for a broken install; it cannot repair a queue.
    expect(res.stdout).not.toMatch(/Something is broken/);
  });

  it('fails on dropped events and points at the only remaining copy', () => {
    fs.mkdirSync(path.join(home, 'spool'), { recursive: true });
    fs.writeFileSync(path.join(home, 'spool', 'dropped.json'), JSON.stringify({ count: 3 }));

    const res = eklavya(['doctor']);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/FAILED — 3 event\(s\) dropped/);
    expect(res.stdout).toMatch(/eklavya memory replay/);
  });
});

describe('eklavya doctor checks the install', () => {
  it('passes and stays silent when everything is wired up', () => {
    const res = eklavya(['doctor']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/runtime\s+\//);
    expect(res.stdout).toMatch(/driver\s+better-sqlite3 loads/);
    expect(res.stdout).toMatch(/plugin\s.*registered, enabled/);
    expect(res.stdout).toMatch(/skill\s+\//);
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
      /runtime\s+FAILED — no compiled server at/,
    ],
    [
      'the native driver will not load',
      () =>
        fs.writeFileSync(
          path.join(runtimeDir, 'node_modules', 'better-sqlite3', 'index.js'),
          'throw new Error("dlopen: wrong ABI");',
        ),
      /driver\s+FAILED — will not load on Node .* — Error: dlopen: wrong ABI/,
    ],
    [
      'the plugin was dropped from the registry',
      () =>
        fs.writeFileSync(
          path.join(claudeDir, 'plugins', 'installed_plugins.json'),
          JSON.stringify({ version: 2, plugins: {} }),
        ),
      /plugin\s+FAILED — .*on disk but not registered/,
    ],
    [
      'the plugin was switched off',
      () =>
        fs.writeFileSync(
          path.join(claudeDir, 'settings.json'),
          JSON.stringify({ enabledPlugins: { 'eklavya@eklavya': false } }),
        ),
      /plugin\s+FAILED — registered but not enabled/,
    ],
    [
      // Anything but an explicit `true` is off. Reading a vanished key as
      // healthy would hide the exact failure this command exists to catch.
      'the enablement key vanished entirely',
      () => fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({})),
      /plugin\s+FAILED — registered but not enabled/,
    ],
    [
      'the user skill is gone',
      () => fs.rmSync(path.join(claudeDir, 'skills', 'eklavya'), { recursive: true, force: true }),
      /skill\s+FAILED — nothing at/,
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
    expect(res.stdout).toMatch(/skill\s+FAILED — .*different skill named eklavya — move it first/);
  });

  // A broken install must not cost the report: whoever is reading this still
  // needs to see their mode and level, not a stack trace.
  it('still reports config and level when the install is broken', () => {
    fs.rmSync(path.join(runtimeDir, 'node_modules'), { recursive: true, force: true });
    const res = eklavya(['doctor']);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/quiz\s+on/);
    expect(res.stdout).toMatch(/level\s+easy/);
  });
});

describe('eklavya memory', () => {
  it('reports health on an empty database without inventing numbers', () => {
    const res = eklavya(['memory', 'status']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/entries:\s+0 here, 0 in total/);
    expect(res.stdout).toMatch(/queue:\s+0 pending · 0 paused · 0 failed/);
    expect(res.stdout).toMatch(/oldest job:\s+—/);
    // No provider configured is the default, and the line has to say what that
    // means rather than just printing "null".
    expect(res.stdout).toMatch(/provider:\s+none — nothing leaves this machine/);
    expect(res.stdout).toMatch(/summarizer:\s+local-v1/);
    expect(res.stdout).toMatch(/Your savings: — no context reused yet/);
  });

  it('searches, and says so plainly when there is nothing to find', () => {
    const res = eklavya(['memory', 'search', 'refresh token']);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('No matches.\n');
  });

  it('finds an entry once one exists', () => {
    const db = openDb(dbFile);
    insertEntry(db, {
      project: repo,
      title: 'Refresh token rotation',
      narrative: 'The old token is revoked when a new one is issued.',
      occurredAt: '2025-10-04T11:30:00.000Z',
    });
    db.close();

    const res = eklavya(['memory', 'search', 'refresh', '--limit', '5']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Refresh token rotation/);
  });

  it('rejects a mode it cannot run instead of silently picking one', () => {
    const res = eklavya(['memory', 'search', 'anything', '--mode', 'telepathy']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/keyword, semantic or hybrid/);
  });

  it('exits non-zero on an unknown memory subcommand', () => {
    expect(eklavya(['memory', 'nonsense']).status).toBe(1);
  });

  it('exports and restores: the pair is the backup, and either half alone is not', () => {
    const db = openDb(dbFile);
    insertEntry(db, {
      project: repo,
      title: 'Refresh token rotation',
      narrative: 'The old token is revoked when a new one is issued.',
      tags: ['auth'],
    });
    db.close();

    const file = path.join(home, 'backup.json');
    expect(eklavya(['memory', 'export', file]).status).toBe(0);

    // The drill the migration guide describes: lose the database, restore it.
    fs.rmSync(dbFile, { force: true });
    const first = eklavya(['memory', 'restore', file]);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/entries:\s+1 restored, 0 already here/);
    expect(first.stdout).toMatch(/reindexed: 1 entries/);
    expect(eklavya(['memory', 'search', 'refresh']).stdout).toMatch(/Refresh token rotation/);

    // Additive, so running it twice is not a way to double your history.
    const second = eklavya(['memory', 'restore', file]);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/entries:\s+0 restored, 1 already here/);
    expect(eklavya(['memory', 'status']).stdout).toMatch(/entries:\s+1 here, 1 in total/);
  });

  it('refuses an export version it does not understand, naming both versions', () => {
    const file = path.join(home, 'from-the-future.json');
    fs.writeFileSync(file, JSON.stringify({ schema_version: 99, entries: [] }));

    const res = eklavya(['memory', 'restore', file]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/version 99/);
    expect(res.stderr).toMatch(/understands version 1/);
  });
});

/**
 * The rest of this file's memory coverage is about the layer above the memory
 * functions: which one a subcommand reaches, and whether a flag arrives there
 * at all. `memory-import.test.ts` and `memory-sync.test.ts` call those
 * functions directly and would keep passing while `--max` was read as a string
 * or `prune` dispatched to `status`.
 */

/** One entry in this checkout's memory, for the read subcommands to find. */
function addEntry(title: string, opts: { project?: string; occurredAt?: string } = {}): void {
  const db = openDb(dbFile);
  insertEntry(db, {
    project: opts.project ?? repo,
    title,
    narrative: 'The old refresh token is revoked when a new one is issued.',
    occurredAt: opts.occurredAt,
  });
  db.close();
}

/**
 * Queued jobs whose batches hold no events. The worker finishes each as
 * `skipped` without a summarizer call, so the count is a clean measure of how
 * many jobs one run was allowed to take — which is what `--max` sets.
 */
function queueJobs(count: number, status = 'pending'): void {
  const db = openDb(dbFile);
  for (let i = 0; i < count; i++) {
    const batch = db
      .prepare("INSERT INTO memory_batches (project, session_id, reason) VALUES (?, 's1', 'manual')")
      .run(repo);
    db.prepare('INSERT INTO memory_jobs (batch_id, status) VALUES (?, ?)').run(batch.lastInsertRowid, status);
  }
  db.close();
}

function jobStatuses(): Record<string, number> {
  const db = openDb(dbFile);
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM memory_jobs GROUP BY status').all() as {
    status: string;
    n: number;
  }[];
  db.close();
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/**
 * A Claude Mem database trimmed to what the importer reads.
 *
 * `importFrom` selects `*` from `observations`, so a column it wants and this
 * table has not got arrives as `undefined` rather than an error — which is why
 * the full nine-table schema in `memory-import.test.ts` is not repeated here.
 * That suite tests the import; these tests only need a source that is real
 * enough for the argument parsing to have something to point at.
 */
function writeClaudeMemDb(file: string, project = 'demo-repo'): string {
  const src = new Database(file);
  src.exec(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT, project TEXT NOT NULL,
    type TEXT, title TEXT, narrative TEXT, created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL,
    merged_into_project TEXT)`);
  src
    .prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
       VALUES ('s1', ?, 'decision', 'Imported decision', 'The old token is revoked.', ?, ?)`,
    )
    .run(project, '2025-10-04T11:30:00.000Z', Date.UTC(2025, 9, 4, 11, 30));
  src.close();
  return file;
}

describe('eklavya memory dispatches each subcommand', () => {
  // One fingerprint per subcommand: a line no other memory function prints. A
  // switch that sent `prune` to `status` would still exit 0 and still print
  // something, so an exit code on its own proves nothing about dispatch.
  const dispatches: Array<[string, string[], RegExp]> = [
    ['status', ['memory', 'status'], /^project:\s+\//m],
    ['timeline', ['memory', 'timeline'], /^Nothing recorded for this project yet\.$/m],
    ['search', ['memory', 'search', 'anything'], /^No matches\.$/m],
    ['prune', ['memory', 'prune'], /^memory\.retention_days is not set/m],
    ['process', ['memory', 'process'], /^processed 0 · entries 0 · failed 0 · skipped 0$/m],
    ['sync status', ['memory', 'sync', 'status'], /^sync:\s+off \(set sync\.enabled\)$/m],
  ];

  for (const [name, argv, expected] of dispatches) {
    it(`runs ${name} on an empty database and exits 0`, () => {
      const res = eklavya(argv);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(expected);
    });
  }

  it('runs show against the entry the id names', () => {
    addEntry('Refresh token rotation');
    const res = eklavya(['memory', 'show', '1']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^#1\s+Refresh token rotation$/m);
    expect(res.stdout).toMatch(/^Evidence \(0\):$/m);
  });

  it('runs prune for real once retention_days is set', () => {
    // The unset case above short-circuits before `pruneEvidence` is called, so
    // on its own it cannot tell a correct dispatch from a missing one.
    eklavya(['config', 'set', 'memory.retention_days', '30']);
    const res = eklavya(['memory', 'prune']);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(`Deleted 0 raw evidence events older than 30 days in ${projectKey(repo)}.\n`);
  });

  it('prunes only the project it runs in', () => {
    // Retention is per project over one database: `memory prune` in one
    // checkout must not age out another checkout's evidence.
    const db = openDb(dbFile);
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    for (const [uid, project] of [['here', projectKey(repo)], ['elsewhere', '/tmp/some-other-project']]) {
      const { id } = appendEvent(db, { eventUid: uid, project, sessionId: uid, kind: 'tool_use', body: uid, occurredAt: old });
      db.prepare("UPDATE evidence_events SET status = 'summarized' WHERE id = ?").run(id);
    }
    db.close();
    eklavya(['config', 'set', 'memory.retention_days', '30']);
    const res = eklavya(['memory', 'prune']);
    expect(res.stdout).toMatch(/^Deleted 1 raw evidence events/);
    const check = new Database(dbFile, { readonly: true });
    const left = check.prepare('SELECT event_uid FROM evidence_events').all() as { event_uid: string }[];
    check.close();
    expect(left.map((r) => r.event_uid)).toEqual(['elsewhere']);
  });

  it('runs import, the one subcommand that reads a file rather than the database', () => {
    const source = writeClaudeMemDb(path.join(home, 'claude-mem.db'));
    const res = eklavya(['memory', 'import', source, '--dry-run']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(new RegExp(`^source:\\s+${source.replace(/[/\\]/g, '\\$&')}$`, 'm'));
  });

  it('answers an unknown subcommand with the memory usage, not the whole CLI\'s', () => {
    // The two are easy to confuse in the default branch, and the wrong one
    // hands somebody who mistyped `timeline` a screen about `serve` and
    // `install` with no list of the subcommands they meant.
    const res = eklavya(['memory', 'nonsense']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/^Usage: eklavya memory status\|search\|timeline\|show\|replay\|process\|stop\|backlog\|prune/m);
    expect(res.stderr).not.toMatch(/eklavya serve/);
  });
});

describe('eklavya memory flags reach the function they configure', () => {
  it('--limit caps the timeline, and caps it from the newest end', () => {
    for (const n of [1, 2, 3]) addEntry(`Token entry ${n}`, { occurredAt: `2025-0${n}-01T10:00:00.000Z` });
    expect(eklavya(['memory', 'timeline']).stdout.match(/^#\d/gm)).toHaveLength(3);

    const res = eklavya(['memory', 'timeline', '--limit', '2']);
    expect(res.status).toBe(0);
    expect(res.stdout.match(/^#\d/gm)).toHaveLength(2);
    // Which two matters: a `--limit` that never reached the query and got
    // truncated somewhere else could just as easily keep the oldest rows.
    expect(res.stdout).toMatch(/Token entry 3/);
    expect(res.stdout).not.toMatch(/Token entry 1/);
  });

  it('--since filters the timeline by date', () => {
    for (const n of [1, 2, 3]) addEntry(`Token entry ${n}`, { occurredAt: `2025-0${n}-01T10:00:00.000Z` });
    const res = eklavya(['memory', 'timeline', '--since', '2025-02-01']);
    expect(res.status).toBe(0);
    expect(res.stdout.match(/^#\d/gm)).toHaveLength(2);
    expect(res.stdout).not.toMatch(/Token entry 1/);
  });

  it('--limit caps search hits', () => {
    for (const n of [1, 2, 3]) addEntry(`Token entry ${n}`);
    expect(eklavya(['memory', 'search', 'token']).stdout.match(/^#\d/gm)).toHaveLength(3);
    const res = eklavya(['memory', 'search', 'token', '--limit', '2']);
    expect(res.status).toBe(0);
    expect(res.stdout.match(/^#\d/gm)).toHaveLength(2);
  });

  it('--all-projects is the only way another checkout\'s memory surfaces', () => {
    addEntry('Token here');
    addEntry('Token elsewhere', { project: '/some/other/checkout' });

    const scoped = eklavya(['memory', 'search', 'token']);
    expect(scoped.stdout).toMatch(/Token here/);
    expect(scoped.stdout).not.toMatch(/Token elsewhere/);

    const wide = eklavya(['memory', 'search', 'token', '--all-projects']);
    expect(wide.status).toBe(0);
    expect(wide.stdout).toMatch(/Token elsewhere/);
  });

  it('--mode picks the searcher, and the output names the one that ran', () => {
    addEntry('Refresh token rotation');
    // The default is hybrid, so a `--mode` that was parsed as part of the query
    // would still return this hit -- the `via` field is what tells them apart.
    expect(eklavya(['memory', 'search', 'refresh']).stdout).toMatch(/· hybrid$/m);
    const res = eklavya(['memory', 'search', 'refresh', '--mode', 'keyword']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/· keyword$/m);
    // ...and the flag's own value must not have been searched for.
    expect(res.stdout).toMatch(/Refresh token rotation/);
  });

  it('--max caps how many jobs one process run drains', () => {
    queueJobs(5);
    const res = eklavya(['memory', 'process', '--max', '2']);
    expect(res.status).toBe(0);
    // `"2"` ignored as a string leaves the default of 10 and drains all five;
    // this is the assertion that a number arrived.
    expect(res.stdout).toBe('processed 0 · entries 0 · failed 0 · skipped 2\n');
    expect(jobStatuses()).toEqual({ done: 2, pending: 3 });
  });

  it('process resumes paused jobs and says how many, which nothing else does', () => {
    queueJobs(2, 'paused');
    const res = eklavya(['memory', 'process']);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('resumed 2 paused · processed 0 · entries 0 · failed 0 · skipped 2\n');
    expect(jobStatuses()).toEqual({ done: 2 });
  });

  it('omits the resumed line when there was nothing paused', () => {
    // A line reporting work that did not happen is how `doctor`'s remedy stops
    // being believable: it says "run this", and this says it resumed nothing.
    queueJobs(1);
    expect(eklavya(['memory', 'process']).stdout).not.toMatch(/resumed/);
  });

  it('--target points sync at a folder for one run without turning sync on', () => {
    const target = path.join(home, 'shared');

    // `--target` overrides sync.target, never sync.enabled: pointing it
    // somewhere for a second is still a decision to publish this machine.
    const off = eklavya(['memory', 'sync', 'push', '--target', target]);
    expect(off.status).toBe(1);
    expect(off.stderr).toMatch(/Sync is off\./);

    eklavya(['config', 'set', 'sync.enabled', 'true']);
    addEntry('Refresh token rotation');
    const on = eklavya(['memory', 'sync', 'push', '--target', target]);
    expect(on.status).toBe(0);
    expect(on.stdout).toMatch(new RegExp(`^Pushed to ${target.replace(/[/\\]/g, '\\$&')} as `, 'm'));
    expect(fs.existsSync(path.join(target, 'devices'))).toBe(true);
  });

  it('--dry-run reports the source and writes nothing', () => {
    const source = writeClaudeMemDb(path.join(home, 'claude-mem.db'));
    const res = eklavya(['memory', 'import', source, '--dry-run']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Dry run: nothing was written, and the source was opened read-only\./);
    expect(eklavya(['memory', 'status']).stdout).toMatch(/entries:\s+0 here, 0 in total/);
  });

  it('--map files a source project under the checkout it names', () => {
    const source = writeClaudeMemDb(path.join(home, 'claude-mem.db'));
    const res = eklavya(['memory', 'import', source, '--map', `demo-repo=${repo}`]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(new RegExp(`^  mapped: demo-repo -> ${repo.replace(/[/\\]/g, '\\$&')}$`, 'm'));
    // The point of the mapping: the row is now findable from this checkout,
    // rather than only under --all-projects.
    expect(eklavya(['memory', 'search', 'imported']).stdout).toMatch(/Imported decision/);
  });

  it('--map-here uses the checkout the command was run from', () => {
    const source = writeClaudeMemDb(path.join(home, 'claude-mem.db'));
    const res = eklavya(['memory', 'import', source, '--map-here', 'demo-repo']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(new RegExp(`^  mapped: demo-repo -> ${repo.replace(/[/\\]/g, '\\$&')}$`, 'm'));
  });

  it('leaves an unmapped project where it was, and says it is only reachable widened', () => {
    const source = writeClaudeMemDb(path.join(home, 'claude-mem.db'));
    const res = eklavya(['memory', 'import', source]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^  kept as-is: demo-repo$/m);
    expect(res.stdout).toMatch(/only with --all-projects/);
    expect(eklavya(['memory', 'search', 'imported']).stdout).toBe('No matches.\n');
    expect(eklavya(['memory', 'search', 'imported', '--all-projects']).stdout).toMatch(/Imported decision/);
  });

  // The source is a positional, and every flag value sitting next to it is a
  // candidate for being picked up as one. Each of these once had to be argued
  // about rather than run.
  const positionals: Array<[string, (src: string) => string[]]> = [
    ['--resume', (src) => ['memory', 'import', src, '--resume']],
    ['--map-here, when the flag comes first', (src) => ['memory', 'import', '--map-here', 'demo-repo', src]],
    ['--map, when the flag comes first', (src) => ['memory', 'import', '--map', 'demo-repo=/tmp', src]],
  ];

  for (const [name, argvFor] of positionals) {
    it(`still finds the source path alongside ${name}`, () => {
      const source = writeClaudeMemDb(path.join(home, 'claude-mem.db'));
      const res = eklavya(argvFor(source));
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/^  observations\s+read 1 · imported 1/m);
    });
  }
});

describe('eklavya memory says what is wrong rather than exiting quietly', () => {
  const missing: Array<[string, string[], RegExp]> = [
    ['show', ['memory', 'show'], /^Usage: eklavya memory show <id>$/m],
    ['show, given something that is not an id', ['memory', 'show', 'latest'], /^Usage: eklavya memory show <id>$/m],
    ['search', ['memory', 'search'], /^Usage: eklavya memory search <query>/m],
    ['search, given only flags', ['memory', 'search', '--all-projects'], /^Usage: eklavya memory search <query>/m],
    ['export', ['memory', 'export'], /^Usage: eklavya memory export <path> \[--force\]$/m],
    ['restore', ['memory', 'restore'], /^Usage: eklavya memory restore <file>$/m],
    ['import', ['memory', 'import'], /^Usage: eklavya memory import <path-to-claude-mem\.db>/m],
    ['sync', ['memory', 'sync'], /^Usage: eklavya memory sync <push\|pull\|status>/m],
    ['sync, given a verb it has not got', ['memory', 'sync', 'upload'], /^Usage: eklavya memory sync <push\|pull\|status>/m],
  ];

  for (const [name, argv, expected] of missing) {
    it(`names the argument it wanted for ${name}`, () => {
      const res = eklavya(argv);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(expected);
      // Nothing on stdout: a usage line the caller has to fish out of a report
      // is the same as no usage line when the caller is a script.
      expect(res.stdout).toBe('');
    });
  }

  // A flag whose value was eaten by the next flag is the quiet failure this
  // guards: `--limit --all-projects` must not search for "--all-projects".
  const valueless: Array<[string, string[], string]> = [
    ['--limit on search', ['memory', 'search', 'token', '--limit'], '--limit needs a value.'],
    ['--mode on search', ['memory', 'search', 'token', '--mode'], '--mode needs a value.'],
    ['--limit swallowed by the next flag', ['memory', 'search', 'token', '--limit', '--all-projects'], '--limit needs a value.'],
    ['--since on timeline', ['memory', 'timeline', '--since'], '--since needs a value.'],
    ['--target on sync', ['memory', 'sync', 'status', '--target'], '--target needs a value.'],
    ['--map-here on import', ['memory', 'import', 'src.db', '--map-here'], 'Usage: --map-here <source-project>'],
  ];

  for (const [name, argv, expected] of valueless) {
    it(`refuses ${name} with no value`, () => {
      const res = eklavya(argv);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(expected);
    });
  }

  const badNumbers: Array<[string, string[], string]> = [
    ['zero', ['memory', 'search', 'token', '--limit', '0'], '--limit needs a positive number.'],
    ['a word', ['memory', 'search', 'token', '--limit', 'later'], '--limit needs a positive number.'],
    ['a negative', ['memory', 'timeline', '--limit', '-1'], '--limit needs a positive number.'],
    ['a word for --max', ['memory', 'process', '--max', 'lots'], '--max needs a positive number.'],
  ];

  for (const [name, argv, expected] of badNumbers) {
    it(`refuses ${name} instead of quietly falling back to the default`, () => {
      const res = eklavya(argv);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(expected);
    });
  }

  it('names a --map pair that has no path in it', () => {
    const res = eklavya(['memory', 'import', 'src.db', '--map', 'demo-repo']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Usage: --map <source-project>=<path-to-checkout>');
  });

  it('names the file when there is no Claude Mem database there', () => {
    const res = eklavya(['memory', 'import', path.join(home, 'nowhere.db')]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(path.join(home, 'nowhere.db'));
    expect(res.stderr).toMatch(/usually ~\/\.claude-mem\/claude-mem\.db/);
  });

  it('names the file when there is no export there', () => {
    const res = eklavya(['memory', 'restore', path.join(home, 'nowhere.json')]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(path.join(home, 'nowhere.json'));
    expect(res.stderr).toMatch(/Pass the file `eklavya memory export` wrote\./);
  });

  it('names the file when an export is not readable JSON', () => {
    const file = path.join(home, 'truncated.json');
    fs.writeFileSync(file, '{"schema_version": 1, "entr');
    const res = eklavya(['memory', 'restore', file]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/is not readable JSON/);
  });

  // FAILING — DEFECT. src/cli.ts:958-1023. `memoryImport` converts an
  // `ImportError` into a message and rethrows everything else, and nothing
  // below `inventory()` wraps better-sqlite3's own errors. Point `import` at a
  // file that is not a database -- the likeliest mistake there is, since the
  // argument is a path the developer types by hand -- and they get
  // `SqliteError: file is not a database` with a stack trace through
  // node_modules. The missing-file case next door is handled properly, and so
  // is `restore` given the same junk, so this is an oversight rather than a
  // policy.
  it('names the file when it is not a database at all, rather than throwing', () => {
    const file = path.join(home, 'notes.db');
    fs.writeFileSync(file, 'this is not a sqlite file at all');
    const res = eklavya(['memory', 'import', file]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(file);
    expect(res.stderr).not.toMatch(/node_modules/);
    expect(res.stderr).not.toMatch(/^\s+at /m);
  });

  // FAILING — DEFECT. src/cli.ts:825-826. `resumePaused(db)` runs on line 825;
  // `numberFlag(argv, '--max', 10)` is not evaluated until it is built as an
  // argument to `processPending` on line 826. So a rejected `--max` has already
  // moved every paused job back to pending, and because the failure path never
  // reaches the summary line, the `resumed N paused` report is never printed
  // either. The developer is told the command did nothing and the queue says
  // otherwise; if the credential behind the pause is still wrong, those jobs
  // now burn their retries invisibly. Validate the arguments before the write.
  it('does not resume paused jobs on a run it refused to make', () => {
    queueJobs(2, 'paused');
    const res = eklavya(['memory', 'process', '--max', 'lots']);
    expect(res.status).toBe(1);
    expect(jobStatuses()).toEqual({ paused: 2 });
  });

  // FAILING — DEFECT. src/cli.ts:939-942 (`--map-here` in `projectMapFrom`).
  // `projectKey(findRepoConfig(process.cwd()).repoRoot)` returns GLOBAL_PROJECT
  // ('*') when there is no checkout to find, so `--map-here` run outside one
  // files every imported row under the global bucket and reports
  // `would map: demo-repo -> *` as though it had worked. That is precisely the
  // outcome the function's own comment says the flag exists to prevent -- rows
  // in "a scope no session queries" -- and it is silent and permanent. The flag
  // means "here"; with no here, it should say so.
  it('refuses --map-here outside a checkout instead of filing rows under *', () => {
    const source = writeClaudeMemDb(path.join(home, 'claude-mem.db'));
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-nogit-'));
    try {
      const res = eklavya(['memory', 'import', source, '--dry-run', '--map-here', 'demo-repo'], loose);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/--map-here/);
      expect(res.stdout).not.toMatch(/would map: demo-repo -> \*/);
    } finally {
      fs.rmSync(loose, { recursive: true, force: true });
    }
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
    expect(res.stdout).toMatch(/level\s+easy \(0\/100 passing answers in/);
  });

  it('says when a pin is switching progression off', () => {
    eklavya(['config', 'set', 'difficulty', 'hard']);
    expect(eklavya(['doctor']).stdout).toMatch(/level\s+hard \(pinned by config/);
  });
});

describe('eklavya statusline', () => {
  const bar = (sessionId: string) =>
    eklavya(['statusline', '--no-color'], repo, JSON.stringify({ cwd: repo, session_id: sessionId }))
      .stdout;

  it('shows the dials', () => {
    openDb(dbFile).close();
    expect(bar('sess-1')).toMatch(/\[EKLAVYA concept/);
  });

  it('still shows the dials when the database cannot be read', () => {
    // The session check needs the database; the bar does not. Before this, a
    // corrupt file threw past the level lookup and the line vanished entirely.
    fs.writeFileSync(dbFile, 'this is not a sqlite file at all');
    expect(bar('sess-1')).toMatch(/\[EKLAVYA concept/);
  });

  it('keeps the bar when the host names no session', () => {
    // The fallback would be the shared current_session pointer, so suppressing
    // on a guess blanks every other terminal the moment one session goes quiet.
    const db = openDb(dbFile);
    setSessionOff(db, 'sess-1', true);
    setCurrentSession(db, 'sess-1');
    db.close();

    expect(
      eklavya(['statusline', '--no-color'], repo, JSON.stringify({ cwd: repo })).stdout,
    ).toMatch(/\[EKLAVYA concept/);
  });

  it('goes dark for a session that was turned off', () => {
    // A bar still reciting the dials of a session that will not ask anything is
    // the small lie that becomes a bug report.
    const db = openDb(dbFile);
    setSessionOff(db, 'sess-1', true);
    db.close();

    expect(bar('sess-1')).toBe('');
    expect(bar('sess-2')).toMatch(/\[EKLAVYA concept/);
  });
});

// The suite that used to live here tested a forbidden-key list: settings lived
// at <repo>/.eklavya.json, so a clone handed Eklavya a config file written by
// somebody else, and `notifications`, `sync`, `providers` and
// `retrieval.cross_project` had to be refused from it. Project settings are
// outside the checkout now and only you write them, so there is nothing to
// refuse. What is left to prove is that the old file stops mattering.
describe('a checkout that still has an .eklavya.json', () => {
  it('has it moved out, silently, by an ordinary command', () => {
    const legacy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-legacy-')));
    fs.mkdirSync(path.join(legacy, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(legacy, '.eklavya.json'),
      JSON.stringify({ quiz: { enforced: true }, notifications: { enabled: true, sinks: [] } }),
    );

    const get = eklavya(['config', 'get'], legacy);
    expect(get.status).toBe(0);
    // Gone from the working tree, with nothing said about it.
    expect(fs.existsSync(path.join(legacy, '.eklavya.json'))).toBe(false);
    expect(get.stdout).not.toMatch(/migrat|\.eklavya\.json/i);
    // And its settings are in force from where they landed.
    expect(get.stdout).toMatch(/"enforced": true/);
    expect(get.stdout).toMatch(new RegExp(`project: ${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    // Including the keys a cloned file was never allowed to set, which are
    // ordinary settings now that no config arrives from anybody else.
    expect(get.stdout).toMatch(/"notifications"/);

    fs.rmSync(legacy, { recursive: true, force: true });
  });

  it('writes project settings outside the checkout, never into it', () => {
    const fresh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-fresh-')));
    fs.mkdirSync(path.join(fresh, '.git'), { recursive: true });

    const res = eklavya(['config', 'set', 'sync.enabled', 'true', '--repo'], fresh);
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(fresh, '.eklavya.json'))).toBe(false);
    expect(fs.readdirSync(fresh).filter((f) => f.startsWith('.eklavya'))).toEqual([]);
    expect(eklavya(['config', 'get'], fresh).stdout).toMatch(/"enabled": true/);

    fs.rmSync(fresh, { recursive: true, force: true });
  });
});

describe('config set scope flags', () => {
  // `--project` was documented before it was parsed, and the CLI silently wrote
  // to the global config instead — a setting landing somewhere nobody asked for,
  // with a zero exit code saying it worked.
  it.each(['--project', '--repo'])('%s writes this codebase, not the global config', (flag) => {
    const res = eklavya(['config', 'set', 'difficulty', 'hard', flag]);
    expect(res.status).toBe(0);

    const projectFile = path.join(home, 'projects', repo.replace(/[/\\:]/g, '-'), 'config.json');
    expect(fs.existsSync(projectFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(projectFile, 'utf8'))).toMatchObject({ difficulty: 'hard' });

    // And not into the global file — which in this test does not exist at all,
    // because nothing has written one. That absence is the assertion.
    const globalFile = path.join(home, 'config.json');
    const global = fs.existsSync(globalFile)
      ? (JSON.parse(fs.readFileSync(globalFile, 'utf8')) as Record<string, unknown>)
      : {};
    expect(global.difficulty).toBeUndefined();
    expect(fs.readdirSync(repo).filter((f) => f.startsWith('.eklavya'))).toEqual([]);

    fs.rmSync(projectFile, { force: true });
  });
});

describe('doctor names where each setting came from', () => {
  // A project file that sets one key must not make the others claim they came
  // from it. Saying the wrong source for a setting is the same class of bug as
  // the dial this release renamed, and it showed up on a real install.
  it('marks only the keys the project file actually sets', () => {
    const dir = path.join(home, 'projects', repo.replace(/[/\\:]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ quiz: { enabled: false }, project: repo }),
    );

    const out = eklavya(['doctor']).stdout;
    expect(out).toMatch(/quiz\s.*\(set for this project\)/);
    // focus and cadence are defaults here, and must say nothing.
    expect(out).toMatch(/focus\s+concept\s*$/m);
    expect(out).toMatch(/cadence\s+interleaved[^\n]*$/m);
    expect(out).not.toMatch(/focus\s.*set for this project/);
    expect(out).not.toMatch(/cadence\s.*set for this project/);
  });
});

describe('the retired `mode` writes both flags', () => {
  // `mode` named a *pair* of states. Translating it to one dotted key left the
  // other flag standing: `mode ambient` over an existing `quiz.enforced: true`
  // reported success while commits stayed gated.
  it.each([
    ['ambient', { enabled: true, enforced: false }],
    ['enforced', { enabled: true, enforced: true }],
    ['off', { enabled: false, enforced: false }],
  ])('`config set mode %s` lands both', (mode, expected) => {
    // Start from the state each case has to overwrite, not from the default.
    eklavya(['config', 'set', 'quiz.enabled', String(mode === 'enforced' ? false : true)]);
    eklavya(['config', 'set', 'quiz.enforced', String(mode !== 'enforced')]);

    const res = eklavya(['config', 'set', 'mode', mode]);
    expect(res.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).quiz).toEqual(expected);
  });
});

// `config set` merged into whatever `readJson` returned, and a file with a
// trailing comma returned `{}` -- so fixing one dial wrote a one-key file over
// every other setting the developer had.
describe('config set on a config file it cannot parse', () => {
  it('exits non-zero, names the file, and leaves it byte-for-byte alone', () => {
    const file = path.join(home, 'config.json');
    const broken = '{ "focus": "project", "cadence": "end", }\n';
    fs.writeFileSync(file, broken);

    const res = eklavya(['config', 'set', 'difficulty', 'hard']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain(file);
    expect(res.stderr).toMatch(/not valid JSON/);
    expect(fs.readFileSync(file, 'utf8')).toBe(broken);
    expect(fs.existsSync(`${file}.eklavya-bak`)).toBe(false);
  });

  it('config get still works on defaults, and warns that the file is being ignored', () => {
    const file = path.join(home, 'config.json');
    fs.writeFileSync(file, '{ nope');
    const res = eklavya(['config', 'get']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/"focus": "concept"/);
    expect(res.stderr).toContain(file);
  });

  it('backs up the previous file on an ordinary set', () => {
    const file = path.join(home, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ focus: 'project' }));
    expect(eklavya(['config', 'set', 'cadence', 'end']).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(`${file}.eklavya-bak`, 'utf8'))).toEqual({ focus: 'project' });
  });
});

describe('providers are global-only', () => {
  it('refuses providers.* with --project and writes nothing', () => {
    const res = eklavya(['config', 'set', 'providers.observer', '{"kind":"anthropic","model":"m"}', '--project']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/global config/);
    expect(fs.existsSync(path.join(home, 'projects'))).toBe(false);
  });

  it('config get names a providers key a project file sets but cannot apply', () => {
    const slug = repo.replace(/[/\\:]/g, '-');
    const target = path.join(home, 'projects', slug, 'config.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ project: repo, providers: { observer: { kind: 'anthropic', model: 'm' } } }));
    const res = eklavya(['config', 'get']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/"observer": null/);
    expect(res.stdout).toMatch(/ignored in the project file.*providers/);
  });
});
