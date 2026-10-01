import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDbPath, cleanup } from './helpers.js';
import { openDb } from '../src/db.js';

/**
 * The CLI's branches `cli.test.ts` does not reach: the telemetry command,
 * doctor's rarer rows, the dashboard and artifact commands, the updater's
 * verdicts and the forward to a newer runtime. Every run is the real
 * `dist/cli.js` in a throwaway home; nothing touches the network.
 */
const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(mcpRoot, 'dist', 'cli.js');
const ownVersion = JSON.parse(fs.readFileSync(path.join(mcpRoot, 'package.json'), 'utf8')).version as string;

let dbFile = '';
let home = '';
let repo = '';
let claudeDir = '';
let runtimeDir = '';
let scratch = '';
let port = 0;
const children: ChildProcess[] = [];
const servers: http.Server[] = [];

/**
 * Loaded into every child: a SIGTERM ends the process through `exit`, so a
 * server stopped by a test still writes its coverage, and `fetch` answers
 * without a network when a test asks it to.
 */
function preload(): string {
  const file = path.join(scratch, 'preload.mjs');
  fs.writeFileSync(
    file,
    `process.on('SIGTERM', () => process.exit(0));
     if (process.env.TEST_FETCH) globalThis.fetch = async () => ({ ok: process.env.TEST_FETCH === 'ok' });\n`,
  );
  return pathToFileURL(file).href;
}

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...process.env,
    EKLAVYA_DB: dbFile,
    EKLAVYA_HOME: home,
    EKLAVYA_RUNTIME: runtimeDir,
    CLAUDE_CONFIG_DIR: claudeDir,
    EKLAVYA_DASHBOARD_PORT: String(port),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload()}`.trim(),
  };
  delete out.DO_NOT_TRACK;
  delete out.EKLAVYA_TELEMETRY;
  delete out.EKLAVYA_FORWARDED;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

function eklavya(args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; cli?: string } = {}) {
  const res = spawnSync(process.execPath, [opts.cli ?? cliPath, ...args], {
    cwd: opts.cwd ?? repo,
    encoding: 'utf8',
    env: env(opts.env),
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Without blocking this process, so a server it runs can answer the child. */
function eklavyaAsync(args: string[], extra: Record<string, string | undefined> = {}) {
  const child = spawn(process.execPath, [cliPath, ...args], { cwd: repo, env: env(extra) });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const done = new Promise<{ status: number | null; stdout: string; stderr: string }>((r) =>
    child.on('close', (code) => r({ status: code, stdout, stderr })),
  );
  const until = async (re: RegExp) => {
    for (let i = 0; i < 200 && !re.test(stdout); i++) await new Promise((r) => setTimeout(r, 25));
    return stdout;
  };
  return { child, done, until };
}

/** The smallest tree `health()` accepts; the same as `cli.test.ts`'s. */
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
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'eklavya@eklavya': true } }));
  for (const name of ['eklavya', 'eklavya-artifacts']) {
    const skill = path.join(claudeDir, 'skills', name);
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
}

function globalConfig(value: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(value));
}

/** The runtime the updater owns (not `EKLAVYA_RUNTIME`), at `version`. */
function ownedRuntime(version: string, cli?: string): string {
  const pkg = path.join(home, 'runtime', 'node_modules', 'eklavya');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version }));
  if (cli !== undefined) fs.writeFileSync(path.join(pkg, 'dist', 'cli.js'), cli);
  return pkg;
}

/** A directory of stand-in commands, to put first on PATH. */
function bin(scripts: Record<string, string>, links: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(scratch, 'bin-'));
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  for (const name of links) {
    const real = spawnSync('which', [name], { encoding: 'utf8' }).stdout.trim();
    if (real) fs.symlinkSync(real, path.join(dir, name));
  }
  return dir;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port: p } = s.address() as net.AddressInfo;
      s.close(() => resolve(p));
    });
  });
}

/** Something on the dashboard port: an Eklavya health answer, or not. */
function listen(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const health = (body: Record<string, unknown>): http.RequestListener => (_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ app: 'eklavya', version: '999.0.0', pid: process.pid, db: dbFile, ...body }));
};

/**
 * A copy of `dist/` inside `mcp/` (so the driver still resolves), with its
 * source maps pointed at the real `src/` so the copy's coverage still counts.
 */
function stageDist(): string {
  const root = fs.mkdtempSync(path.join(mcpRoot, '.tmp-cli-cov-'));
  fs.cpSync(path.join(mcpRoot, 'dist'), path.join(root, 'dist'), { recursive: true });
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js.map')) {
        const map = JSON.parse(fs.readFileSync(p, 'utf8'));
        const rel = path.relative(path.join(root, 'dist'), path.dirname(p));
        map.sources = map.sources.map((s: string) => path.resolve(mcpRoot, 'dist', rel, s));
        fs.writeFileSync(p, JSON.stringify(map));
      }
    }
  };
  walk(path.join(root, 'dist'));
  staged.push(root);
  return root;
}
const staged: string[] = [];

beforeEach(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-clicov-'));
  home = path.join(scratch, 'home');
  fs.mkdirSync(home);
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-clicov-repo-')));
  claudeDir = path.join(scratch, 'claude');
  runtimeDir = path.join(scratch, 'rt');
  fs.mkdirSync(path.join(repo, '.git'));
  dbFile = tempDbPath('cli-cov');
  port = await freePort();
  fakeInstall();
});

afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  for (const dir of staged.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  cleanup(dbFile);
  for (const dir of [scratch, repo]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('export-rules from a half-bundled build', () => {
  it('refuses without the skill, and without a reference it cites', () => {
    const root = stageDist();
    const cli = path.join(root, 'dist', 'cli.js');
    const tutor = path.join(root, 'dist', 'assets', 'tutor');
    const refs = path.join(tutor, 'references');
    const victim = fs.readdirSync(refs).filter((f) => f.endsWith('.md')).sort()[0]!;
    fs.rmSync(path.join(refs, victim));
    const missingRef = eklavya(['export-rules'], { cli });
    expect(missingRef.status).toBe(1);
    expect(missingRef.stderr).toContain(`reference files are missing: ${victim}`);

    fs.rmSync(path.join(tutor, 'SKILL.md'));
    const missingSkill = eklavya(['export-rules'], { cli });
    expect(missingSkill.status).toBe(1);
    expect(missingSkill.stderr).toMatch(/bundled tutor skill is missing/);
  });

  it('inlines only markdown, and needs no references folder when the skill cites none', () => {
    const root = stageDist();
    const cli = path.join(root, 'dist', 'cli.js');
    const tutor = path.join(root, 'dist', 'assets', 'tutor');
    fs.writeFileSync(path.join(tutor, 'references', 'notes.txt'), 'NOT-MARKDOWN');
    expect(eklavya(['export-rules'], { cli }).stdout).not.toContain('NOT-MARKDOWN');

    fs.rmSync(path.join(tutor, 'references'), { recursive: true });
    fs.writeFileSync(path.join(tutor, 'SKILL.md'), '---\nname: tutor\n---\nONLY THE SKILL\n');
    const res = eklavya(['export-rules'], { cli });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/ONLY THE SKILL\n$/);
  });

  it('reports a server that cannot load', () => {
    const root = stageDist();
    fs.rmSync(path.join(root, 'dist', 'server.js'));
    const res = eklavya(['serve'], { cli: path.join(root, 'dist', 'cli.js') });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/^eklavya serve: /);
  });
});

describe('forwarding to a newer runtime', () => {
  it('runs the runtime\'s CLI when it is newer, and passes its exit status back', () => {
    ownedRuntime('999.0.0', "process.stdout.write('runtime ' + process.argv.slice(2).join(' ') + ' ' + process.env.EKLAVYA_FORWARDED); process.exit(3);");
    const res = eklavya(['db-path']);
    expect(res.status).toBe(3);
    expect(res.stdout).toBe('runtime db-path 1');
  });

  it('exits 1 when the runtime\'s CLI dies on a signal', () => {
    ownedRuntime('999.0.0', "process.kill(process.pid, 'SIGKILL');");
    expect(eklavya(['db-path']).status).toBe(1);
  });

  it('runs itself when the runtime is not newer, is already forwarded to, or is this very file', () => {
    ownedRuntime('0.0.1', "process.exit(3);");
    expect(eklavya(['db-path']).stdout).toBe(`${dbFile}\n`);
    ownedRuntime('999.0.0', "process.exit(3);");
    expect(eklavya(['db-path'], { env: { EKLAVYA_FORWARDED: '1' } }).stdout).toBe(`${dbFile}\n`);
    const pkg = ownedRuntime('999.0.0');
    fs.rmSync(path.join(pkg, 'dist', 'cli.js'), { force: true });
    fs.symlinkSync(cliPath, path.join(pkg, 'dist', 'cli.js'));
    expect(eklavya(['db-path']).stdout).toBe(`${dbFile}\n`);
  });

  it('runs itself when its own version cannot be read', () => {
    const root = stageDist();
    ownedRuntime('999.0.0', "process.exit(3);");
    expect(eklavya(['db-path'], { cli: path.join(root, 'dist', 'cli.js') }).stdout).toBe(`${dbFile}\n`);
  });
});

describe('config', () => {
  const cases: Array<[string, string[], RegExp, string?]> = [
    ['a retired mode value', ['config', 'set', 'mode', 'loud'], /`mode` was replaced by `quiz\.enabled`/],
    ['an unknown action', ['config', 'frob'], /Unknown config action "frob"\./],
    ['set without a value', ['config', 'set', 'focus'], /^Usage: eklavya config set <key> <value>$/m],
    ['unset without a key', ['config', 'unset'], /^Usage: eklavya config unset <key> \[--project\]$/m],
    ['--topic without a value', ['config', 'set', 'focus', 'learn', '--topic'], /--topic needs a value\./],
    ['--topic on another key', ['config', 'set', 'cadence', 'end', '--topic', 'x'], /--topic only applies when setting focus\./],
    ['a global-only key unset for a project', ['config', 'unset', 'telemetry', '--project'], /./],
  ];
  for (const [name, argv, want] of cases) {
    it(`refuses ${name}`, () => {
      const res = eklavya(argv);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(want);
    });
  }

  it('has no project to scope to outside a repository, and says so in get', () => {
    const outside = fs.mkdtempSync(path.join(scratch, 'plain-'));
    const res = eklavya(['config', 'set', 'cadence', 'end', '--project'], { cwd: outside });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Not inside a git repository/);
    expect(eklavya(['config', 'get'], { cwd: outside }).stdout).toMatch(/^project: \(none — not in a git repository\)$/m);
  });

  it('sets focus_topic directly even with --topic given', () => {
    const res = eklavya(['config', 'set', 'focus_topic', 'caching', '--topic', 'ignored']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^focus_topic = "caching"/m);
  });

  it('sets focus learn and its topic in one call', () => {
    const res = eklavya(['config', 'set', 'focus', 'learn', '--topic', 'caching']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^focus = "learn"/m);
    expect(res.stdout).toMatch(/^focus_topic = "caching"/m);
  });

  it('translates mode off and says memory keeps recording', () => {
    expect(eklavya(['config', 'set', 'mode', 'off']).stdout).toMatch(/This stops the questions only/);
  });
});

describe('telemetry', () => {
  it('reports on and off, turns itself on and off, and says when something else keeps it off', () => {
    expect(eklavya(['telemetry']).stdout).toMatch(/^on · anonymous daily usage counts\n.*\nturn off: eklavya telemetry off\n$/);
    expect(eklavya(['telemetry', 'off']).stdout).toMatch(/^telemetry = false {2}-> /);
    expect(eklavya(['telemetry', 'status']).stdout).toMatch(/^off \(telemetry is false\)[\s\S]*turn on: eklavya telemetry on/);
    const on = eklavya(['telemetry', 'on'], { env: { DO_NOT_TRACK: '1' } });
    expect(on.stdout).toMatch(/^telemetry = true/);
    expect(on.stdout).toMatch(/still off: DO_NOT_TRACK is set/);
    expect(eklavya(['telemetry', 'on']).stdout).not.toMatch(/still off/);
  });

  it('shows when it last sent', () => {
    fs.writeFileSync(path.join(home, 'telemetry.json'), JSON.stringify({ sent_at: '2026-09-24T10:00:00.000Z' }));
    expect(eklavya(['telemetry']).stdout).toMatch(/ · last sent 2026-09-24T10:00:00\.000Z\n/);
  });

  it('prints the next ping, with its install id', () => {
    const res = eklavya(['telemetry', 'show']);
    expect(res.status).toBe(0);
    const ping = JSON.parse(res.stdout);
    expect(ping.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ping.events.map((e: { name: string }) => e.name)).toContain('daily_active');
  });

  it('says why a send did not happen, and nothing in the background', () => {
    expect(eklavya(['telemetry', 'send']).stdout).toBe('not sent\n');
    expect(eklavya(['telemetry', 'send'], { env: { DO_NOT_TRACK: '1' } }).stdout).toBe('not sent (DO_NOT_TRACK is set)\n');
    expect(eklavya(['telemetry', 'send', '--background']).stdout).toBe('');
  });

  it('sends from an installed runtime', () => {
    ownedRuntime('0.0.1');
    const res = eklavya(['telemetry', 'send'], { env: { EKLAVYA_RUNTIME: undefined, CI: undefined, TEST_FETCH: 'ok' } });
    expect(res.stdout).toBe('sent\n');
    expect(JSON.parse(fs.readFileSync(path.join(home, 'telemetry.json'), 'utf8')).sent_at).toBeTruthy();
  });

  it('refuses a subcommand it does not have', () => {
    const res = eklavya(['telemetry', 'loud']);
    expect(res.status).toBe(1);
    expect(res.stderr).toBe('Usage: eklavya telemetry [status|on|off|show]\n');
  });
});

describe('doctor', () => {
  const doctor = (extra: Record<string, string | undefined> = {}, cwd = repo) => eklavya(['doctor'], { env: extra, cwd });

  it('reports the updater\'s state, success and failure, and says update is the fix', () => {
    ownedRuntime('0.0.1');
    fs.writeFileSync(path.join(home, 'update.json'), JSON.stringify({ ok_at: '2026-09-01T00:00:00Z', latest: '0.0.2' }));
    let res = doctor();
    expect(res.stdout).toMatch(/automatic · runtime 0\.0\.1 · latest 0\.0\.2 \(last succeeded 2026-09-01T00:00:00Z\)/);
    expect(res.status).toBe(0);

    fs.writeFileSync(path.join(home, 'update.json'), JSON.stringify({ error: 'npm view failed: offline', checked_at: '2026-09-02T00:00:00Z' }));
    res = doctor();
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/FAILED — npm view failed: offline \(2026-09-02T00:00:00Z\)/);
    expect(res.stdout).toMatch(/Updates are failing\. Run: eklavya update/);

    fs.writeFileSync(path.join(home, 'update.json'), JSON.stringify({ error: 'npm view failed: offline' }));
    expect(doctor().stdout).toMatch(/FAILED — npm view failed: offline\n/);
  });

  it('marks updates and the usage ping as choices when they are off', () => {
    globalConfig({ auto_update: false, telemetry: false });
    fs.writeFileSync(path.join(home, 'telemetry.json'), JSON.stringify({ sent_at: '2026-09-24T10:00:00.000Z' }));
    const res = doctor();
    expect(res.stdout).toMatch(/off \(auto_update is false\) — run eklavya update by hand · runtime not installed \(has not run yet\)/);
    expect(res.stdout).toMatch(/off \(telemetry is false\) \(last sent 2026-09-24T10:00:00\.000Z\)/);
  });

  it('runs outside a repository, with no project file to read', () => {
    const outside = fs.mkdtempSync(path.join(scratch, 'plain-'));
    const res = doctor({}, outside);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toMatch(/project {5}/);
  });

  it('fails when the database cannot be opened', () => {
    const res = doctor({ EKLAVYA_DB: scratch });
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/FAILED — unable to open database file/);
    expect(res.stdout).toMatch(/Something is broken\. Run: eklavya install/);
  });

  it('degrades each memory read instead of failing on a half-built database', () => {
    openDb(dbFile).exec('DROP TABLE memory_jobs');
    const res = doctor();
    expect(res.stdout).toMatch(/queue 0 pending · 0 paused · 0 failed/);
  });

  it('names the quiz contradiction, memory off, sync, a provider and every dial', () => {
    globalConfig({
      quiz: { enabled: false, enforced: true },
      memory: { enabled: false },
      sync: { enabled: true, target: null },
      providers: { observer: { kind: 'anthropic', model: 'haiku' } },
      focus: 'learn',
      cadence: 'end',
    });
    const res = doctor();
    expect(res.status).toBe(1);
    for (const want of [
      /FAILED — quiz\.enabled is false and quiz\.enforced is true/,
      /off \(memory\.enabled is false\)/,
      /sync on -> \(no target set — set sync\.target\)/,
      /provider configured — batches leave this machine/,
      /off — memory is unaffected/,
      /learn \(no topic set\)/,
      /end \(all questions at the end of the task\)/,
    ]) expect(res.stdout).toMatch(want);
  });

  it('names a learn topic, a sync target, and what the project overrides', () => {
    globalConfig({ focus: 'learn', focus_topic: 'caching', cadence: 'interleaved', sync: { enabled: true, target: path.join(scratch, 'shared') } });
    expect(eklavya(['config', 'set', 'cadence', 'end', '--project']).status).toBe(0);
    const res = doctor();
    expect(res.stdout).toMatch(/learn \(caching\)/);
    expect(res.stdout).toMatch(new RegExp(`sync on -> ${path.join(scratch, 'shared').replace(/[/\\]/g, '\\$&')}`));
    expect(res.stdout).toMatch(/overrides {3}for this project: cadence/);
  });

  it('names each class a paused queue is stuck on, and permanent failures', () => {
    const db = openDb(dbFile);
    const job = (status: string, cls: string | null) => {
      const b = db.prepare("INSERT INTO memory_batches (project, session_id, reason) VALUES (?, 's1', 'manual')").run(repo).lastInsertRowid;
      db.prepare('INSERT INTO memory_jobs (batch_id, status, error_class) VALUES (?, ?, ?)').run(b, status, cls);
    };
    job('paused', 'missing');
    job('paused', 'quota');
    job('failed', 'parse');
    db.close();
    const res = doctor();
    expect(res.stdout).toMatch(/2 job\(s\) paused \(missing, quota\)/);
    expect(res.stdout).toMatch(/put claude on the PATH .*, or wait out the usage limit, then: eklavya memory process/);
    expect(res.stdout).toMatch(/1 job\(s\) failed permanently \(parse\)/);
  });

  it('says to fix what paused an unclassified queue', () => {
    const db = openDb(dbFile);
    const b = db.prepare("INSERT INTO memory_batches (project, session_id, reason) VALUES (?, 's1', 'manual')").run(repo).lastInsertRowid;
    db.prepare("INSERT INTO memory_jobs (batch_id, status) VALUES (?, 'paused')").run(b);
    db.close();
    const res = doctor();
    expect(res.stdout).toMatch(/1 job\(s\) paused \(unclassified\)/);
    expect(res.stdout).toMatch(/fix what paused it, then: eklavya memory process/);
    expect(res.stdout).toMatch(/Memory needs attention/);
  });

  it('needs a fix by hand for a config file that does not parse', () => {
    fs.writeFileSync(path.join(home, 'config.json'), '{ nope');
    const res = doctor();
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/config {6}FAILED — /);
    expect(res.stdout).toMatch(/Needs a fix by hand — see above/);
  });

  describe('the terminal gate', () => {
    beforeEach(() => {
      fs.rmSync(path.join(repo, '.git'), { recursive: true });
      spawnSync('git', ['init', '-q'], { cwd: repo });
    });
    const hook = () => fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n# >>> eklavya gate >>>\n');

    it('warns an enforced gate without jq and sqlite3 on PATH', () => {
      globalConfig({ quiz: { enabled: true, enforced: true } });
      const res = doctor({ PATH: bin({}, ['git']) });
      expect(res.stdout).toMatch(/jq and sqlite3 not on PATH — the terminal commit gate needs them if you install it/);
      expect(res.status).toBe(0);
    });

    it('fails an installed gate without them, since it lets every commit through', () => {
      hook();
      const res = doctor({ PATH: bin({}, ['git']) });
      expect(res.stdout).toMatch(/git hook {4}.*pre-commit/);
      expect(res.stdout).toMatch(/FAILED — jq and sqlite3 not on PATH; the commit gate lets every commit through/);
      expect(res.status).toBe(1);
    });

    it('is quiet about an installed gate that has both', () => {
      hook();
      const res = doctor({ PATH: bin({ jq: 'exit 0', sqlite3: 'exit 0' }, ['git']) });
      expect(res.stdout).toMatch(/git hook/);
      expect(res.stdout).not.toMatch(/not on PATH/);
    });
  });

  it('names a pack still inside the checkout, one without a version, and a set of only broken ones', () => {
    const packs = path.join(repo, '.eklavya', 'packs');
    fs.mkdirSync(packs, { recursive: true });
    fs.writeFileSync(path.join(packs, 'old.json'), JSON.stringify({
      pack: 'legacy-pack', domain: 'rust', concepts: [{ slug: 'rust-lifetimes', name: 'Lifetimes', tier: 1 }],
    }));
    let res = doctor();
    expect(res.stdout).toMatch(/1 loaded — legacy-pack \(repo\)/);
    expect(res.stdout).toMatch(/1 still inside the checkout \(legacy-pack\)/);

    fs.writeFileSync(path.join(packs, 'old.json'), '{ broken');
    res = doctor();
    expect(res.stdout).toMatch(/packs {7}0 loaded\n/);
  });
});

describe('statusline input', () => {
  const bar = (input: string, extra: Record<string, string | undefined> = {}, args = ['statusline']) => {
    const res = spawnSync(process.execPath, [cliPath, ...args], { cwd: repo, input, encoding: 'utf8', env: env(extra) });
    return res.stdout;
  };

  it('reads the workspace directory, and falls back on input it cannot use', () => {
    openDb(dbFile).close();
    expect(bar(JSON.stringify({ workspace: { current_dir: repo } }), { NO_COLOR: '1' })).toMatch(/\[EKLAVYA concept/);
    expect(bar('null', { NO_COLOR: '1' })).toMatch(/\[EKLAVYA concept/);
    expect(bar('{not json', { NO_COLOR: '1' })).toMatch(/\[EKLAVYA concept/);
    expect(bar('', { NO_COLOR: '1' })).toMatch(/\[EKLAVYA concept/);
  });

  it('shows a pinned level without the database, in colour unless told not to', () => {
    globalConfig({ difficulty: 'hard' });
    const out = bar(JSON.stringify({ cwd: repo }), { NO_COLOR: undefined });
    expect(out).toMatch(/hard/);
    expect(out).toMatch(/\x1b\[/);
  });
});

describe('dashboard', () => {
  it('reports what is on its port', async () => {
    expect(eklavya(['dashboard', 'status']).stdout).toBe(`No dashboard on http://127.0.0.1:${port}. Start one: eklavya dashboard\n`);

    const ours = await listen(health({}));
    let run = eklavyaAsync(['dashboard', 'status']);
    expect((await run.done).stdout).toBe(`Eklavya dashboard on http://127.0.0.1:${port} · 999.0.0 · pid ${process.pid}\nReading ${dbFile}\n`);
    await new Promise((r) => ours.close(r));

    await listen((_req, res) => res.end('hello'));
    run = eklavyaAsync(['dashboard', 'status']);
    expect((await run.done).stdout).toBe(`Port ${port} is taken by something that is not an Eklavya dashboard.\n`);
  });

  it('stops the dashboard it finds, and says when there was none', async () => {
    expect(eklavya(['dashboard', 'stop']).stdout).toBe(`No Eklavya dashboard was running on http://127.0.0.1:${port}.\n`);

    for (const autostart of [true, false]) {
      globalConfig({ dashboard_autostart: autostart });
      const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      children.push(victim);
      const server = await listen(health({ pid: victim.pid }));
      victim.on('exit', () => server.close());
      const run = eklavyaAsync(['dashboard', 'stop']);
      const { stdout } = await run.done;
      expect(stdout).toMatch(new RegExp(`^Stopped the dashboard on http://127\\.0\\.0\\.1:${port}\\.`));
      if (autostart) expect(stdout).toMatch(/The next session starts it again/);
      else expect(stdout).not.toMatch(/next session/);
    }
  });

  it('refuses a --port that is not a number', () => {
    const res = eklavya(['dashboard', '--port', 'many']);
    expect(res.status).toBe(1);
    expect(res.stderr).toBe('eklavya dashboard: --port needs a number\n');
  });

  it('reuses a background dashboard already serving this database, and opens it', async () => {
    const opened = path.join(scratch, 'opened');
    const opener = bin({ open: `echo "$1" > "${opened}"`, 'xdg-open': `echo "$1" > "${opened}"` });
    await listen(health({}));
    let run = eklavyaAsync(['dashboard', '--no-open']);
    expect((await run.done).stdout).toMatch(/\(already running in the background\)\nReading .* — stop it: eklavya dashboard stop\n$/);

    run = eklavyaAsync(['dashboard'], { PATH: `${opener}${path.delimiter}${process.env.PATH}` });
    expect((await run.done).stdout).toMatch(/Opening it in your browser…\n$/);
    for (let i = 0; i < 200 && !fs.existsSync(opened); i++) await new Promise((r) => setTimeout(r, 25));
    expect(fs.readFileSync(opened, 'utf8').trim()).toBe(`http://127.0.0.1:${port}`);
  });

  it('starts one in the background when nothing answers, and stops it again', async () => {
    const run = eklavyaAsync(['dashboard', '--no-open']);
    expect((await run.done).stdout).toMatch(/\(started in the background\)/);
    const stop = eklavyaAsync(['dashboard', 'stop']);
    expect((await stop.done).stdout).toMatch(/^Stopped the dashboard/);
  });

  it('serves in the foreground when the port is someone else\'s, and opens that one', async () => {
    const opened = path.join(scratch, 'opened');
    const opener = bin({ open: `echo "$1" > "${opened}"`, 'xdg-open': `echo "$1" > "${opened}"` });
    await listen((_req, res) => res.end('hello'));
    const run = eklavyaAsync(['dashboard'], { PATH: `${opener}${path.delimiter}${process.env.PATH}` });
    const out = await run.until(/Opening it in your browser/);
    expect(out).toMatch(/press Ctrl\+C to stop\.\nOpening it in your browser…\n/);
    run.child.kill('SIGTERM');
    expect((await run.done).status).toBe(0);
  });

  it('serves the background copy on its own port only, and leaves quietly when that is taken', async () => {
    await listen((_req, res) => res.end('hello'));
    const res = eklavyaAsync(['dashboard', '--serve']);
    expect((await res.done).status).toBe(0);
  });

  it('fails a foreground --port that is taken', async () => {
    await listen((_req, res) => res.end('hello'));
    const run = eklavyaAsync(['dashboard', '--port', String(port), '--no-open']);
    const { status, stderr } = await run.done;
    expect(status).toBe(1);
    expect(stderr).toMatch(/^eklavya dashboard: /);
  });
});

describe('artifacts', () => {
  it('refuses a flag it does not know, a missing title and a kind it has not got', () => {
    expect(eklavya(['artifacts', 'new', 'T', '--colour', 'red']).stderr).toMatch(/^eklavya artifacts new: /);
    expect(eklavya(['artifacts', 'new']).stderr).toMatch(/give the page a title/);
    expect(eklavya(['artifacts', 'new', 'T', '--kind', 'poster']).stderr).toMatch(/--kind is artifact or explainer/);
    expect(eklavya(['artifacts', 'frob']).stderr).toMatch(/^Usage: eklavya artifacts new <title>/);
  });

  it('lists nothing, then each page, and only this project\'s with --here', () => {
    expect(eklavya(['artifacts', 'list']).stdout).toBe('No artifacts yet.\n');
    const other = fs.mkdtempSync(path.join(scratch, 'other-'));
    eklavya(['artifacts', 'new', 'Here page']);
    eklavya(['artifacts', 'new', 'Why', '--kind', 'explainer'], { cwd: other });
    const all = eklavya(['artifacts', 'list']).stdout;
    expect(all).toMatch(/ {2}artifact {3}Here page\n/);
    expect(all).toMatch(/ {2}explainer {2}Why\n/);
    const here = eklavya(['artifacts', 'list', '--here']).stdout;
    expect(here).toMatch(/Here page/);
    expect(here).not.toMatch(/Why/);
  });

  it('opens a page by path or id, and refuses one it cannot find', () => {
    const opened = path.join(scratch, 'opened');
    const opener = bin({ open: `echo "$1" >> "${opened}"`, 'xdg-open': `echo "$1" >> "${opened}"` });
    const PATH = `${opener}${path.delimiter}${process.env.PATH}`;
    const made = eklavya(['artifacts', 'new', 'Open me', '--open'], { env: { PATH } }).stdout.trim();
    expect(fs.existsSync(made)).toBe(true);
    const id = JSON.parse(eklavya(['artifacts', 'list', '--json']).stdout)[0].id as string;
    expect(eklavya(['artifacts', 'open', made], { env: { PATH } }).stdout).toBe(`${made}\n`);
    expect(eklavya(['artifacts', 'open', id], { env: { PATH } }).stdout.trim()).toMatch(/Open-me\.html$|open-me\.html$/);
    expect(eklavya(['artifacts', 'open']).stderr).toMatch(/name the file or its id/);
    expect(eklavya(['artifacts', 'open', 'nope/none.html']).stderr).toMatch(/no artifact at nope\/none\.html/);
  });
});

describe('update', () => {
  /** npm, as far as the updater can tell: `view` prints `latest`, `install` lays down that version. */
  function npm(latest: string, opts: { fail?: boolean } = {}): string {
    const runtimeCli = "process.exit(0)";
    return bin({
      npm: opts.fail
        ? 'echo "npm ERR! boom" >&2; exit 1'
        : `if [ "$1" = view ]; then echo ${latest}; exit 0; fi
pkg="$4/node_modules/eklavya"; mkdir -p "$pkg/dist"
echo '{"version":"${latest}"}' > "$pkg/package.json"
echo '${runtimeCli}' > "$pkg/dist/cli.js"`,
    });
  }
  const withNpm = (dir: string) => ({ PATH: `${dir}${path.delimiter}${process.env.PATH}`, EKLAVYA_RUNTIME: undefined });

  it('says it is up to date', () => {
    ownedRuntime('0.0.1');
    fs.writeFileSync(path.join(home, 'update.json'), JSON.stringify({ applied: '0.0.1' }));
    const res = eklavya(['update'], { env: withNpm(npm('0.0.1')) });
    expect(res.stdout).toMatch(/up to date · 0\.0\.1/);
    expect(res.status).toBe(0);
  });

  it('says what it updated from and to', () => {
    ownedRuntime('0.0.1');
    const res = eklavya(['update'], { env: withNpm(npm('0.0.2')) });
    expect(res.stdout).toMatch(/updated 0\.0\.1 → 0\.0\.2 · new sessions load it/);
  });

  it('says where it updated from when there was nothing', () => {
    const res = eklavya(['update'], { env: withNpm(npm('0.0.2')) });
    expect(res.stdout).toMatch(/updated nothing → 0\.0\.2/);
  });

  it('fails with npm\'s reason and exits 1', () => {
    const res = eklavya(['update'], { env: withNpm(npm('0.0.2', { fail: true })) });
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/could not update · npm view failed: .*boom/);
  });

  it('says when another update holds the lock', () => {
    fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(home, 'runtime', '.installing'), JSON.stringify({ pid: process.pid, token: 't', at: new Date().toISOString() }));
    expect(eklavya(['update'], { env: withNpm(npm('0.0.2')) }).stdout).toMatch(/an update is already running/);
  });

  it('prints nothing in the background, and skips when one is not due', () => {
    expect(eklavya(['update', '--background']).stdout).toBe('');
  });
});

describe('install', () => {
  it('reports an install that breaks with a sentence, not a stack', () => {
    // A database path that is a directory: every file check passes, then the open fails.
    const res = eklavya(['install', '--auto'], { env: { EKLAVYA_DB: scratch } });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/^eklavya install: /m);
  });
});
