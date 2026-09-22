import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDbPath, cleanup } from './helpers.js';
import { openDb } from '../src/db.js';
import { setCurrentSession, setSessionOff } from '../src/session.js';
import { insertEntry } from '../src/memory/store.js';

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
    expect(res.stdout).toMatch(/journal:\s+wal/);
    expect(res.stdout).toMatch(/concepts: 8\d/);
    expect(res.stdout).toMatch(/mode:\s+ambient/);
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
    expect(res.stdout).toMatch(/packs:\s+1 loaded — eklavya-pack-rust@1\.0\.0 \(global\)/);
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
    expect(res.stdout).toMatch(/packs:\s+FAILED/);
    expect(res.stdout).not.toMatch(/Run: eklavya install/);
  });
});

describe('eklavya doctor reports the memory half', () => {
  it('answers on an empty database without throwing or inventing numbers', () => {
    const res = eklavya(['doctor']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/memory:\s+on · capture full/);
    expect(res.stdout).toMatch(/memory:\s+0 entries, 0 evidence events \(0 not yet summarised\)/);
    expect(res.stdout).toMatch(/memory:\s+queue 0 pending · 0 paused · 0 failed/);
    expect(res.stdout).toMatch(/memory:\s+last evidence — none captured yet/);
    expect(res.stdout).toMatch(/memory:\s+sync off/);
    expect(res.stdout).toMatch(/memory:\s+provider none — nothing leaves this machine/);
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
    expect(res.stdout).toMatch(/memory:\s+FAILED — 1 job\(s\) paused \(auth\)/);
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
    expect(res.stdout).toMatch(/memory:\s+FAILED — 3 event\(s\) dropped/);
    expect(res.stdout).toMatch(/eklavya memory replay/);
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

describe('eklavya statusline', () => {
  const bar = (sessionId: string) =>
    eklavya(['statusline', '--no-color'], repo, JSON.stringify({ cwd: repo, session_id: sessionId }))
      .stdout;

  it('shows the dials', () => {
    openDb(dbFile).close();
    expect(bar('sess-1')).toMatch(/\[EKLAVYA ambient/);
  });

  it('still shows the dials when the database cannot be read', () => {
    // The session check needs the database; the bar does not. Before this, a
    // corrupt file threw past the level lookup and the line vanished entirely.
    fs.writeFileSync(dbFile, 'this is not a sqlite file at all');
    expect(bar('sess-1')).toMatch(/\[EKLAVYA ambient/);
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
    ).toMatch(/\[EKLAVYA ambient/);
  });

  it('goes dark for a session that was turned off', () => {
    // A bar still reciting the dials of a session that will not ask anything is
    // the small lie that becomes a bug report.
    const db = openDb(dbFile);
    setSessionOff(db, 'sess-1', true);
    db.close();

    expect(bar('sess-1')).toBe('');
    expect(bar('sess-2')).toMatch(/\[EKLAVYA ambient/);
  });
});

describe('what the CLI says about a repo config it refused', () => {
  it('names the ignored keys in doctor and in config get, rather than staying quiet', () => {
    const hostile = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-refused-'));
    fs.mkdirSync(path.join(hostile, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(hostile, '.eklavya.json'),
      JSON.stringify({
        mode: 'enforced',
        notifications: { enabled: true, sinks: [{ kind: 'file', target: '/tmp/x' }] },
      }),
    );

    const doctor = eklavya(['doctor'], hostile);
    expect(doctor.stdout).toMatch(/IGNORED:.*notifications/);
    // The dial it was allowed to set still applies — the refusal is narrow.
    expect(doctor.stdout).toMatch(/mode:\s+enforced/);

    const get = eklavya(['config', 'get'], hostile);
    expect(get.stdout).toMatch(/ignored from the repo config: notifications/);

    fs.rmSync(hostile, { recursive: true, force: true });
  });

  it('refuses to write one with --repo instead of writing a setting that is then ignored', () => {
    const hostile = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-refused-write-'));
    fs.mkdirSync(path.join(hostile, '.git'), { recursive: true });

    const res = eklavya(['config', 'set', 'sync.enabled', 'true', '--repo'], hostile);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/only be set globally/);
    expect(fs.existsSync(path.join(hostile, '.eklavya.json'))).toBe(false);

    fs.rmSync(hostile, { recursive: true, force: true });
  });
});
