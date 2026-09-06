/**
 * `eklavya install` — the whole setup, from a terminal, on macOS or Windows.
 *
 * Claude Code's own route is `/plugin marketplace add` + `/plugin install`, and
 * that still works. This is the other door: it needs no Claude Code session, and
 * it is the one that can install what Eklavya depends on, because a slash
 * command cannot run npm.
 *
 * What it has to get right, in order:
 *
 *   1. Node 22+. Below that, better-sqlite3 has no prebuilt binary and npm falls
 *      through to node-gyp, which needs a C++ toolchain nobody has on Windows.
 *      This is a hard refusal with per-platform instructions, not a warning:
 *      continuing produces a half-install that fails later and mystifies.
 *   2. The runtime. `npm install eklavya@<version> --prefix ~/.eklavya/runtime`
 *      puts the compiled server, the hooks and that one native dependency
 *      somewhere both install routes can find them.
 *   3. The plugin payload, copied into the Claude Code marketplace directory —
 *      or, where that directory is a git checkout `/plugin marketplace add`
 *      made, fast-forwarded with a pull instead of overwritten.
 *   3b. The user-level skill, copied into `~/.claude/skills/eklavya/`, so
 *      "make Eklavya go easier on me" works in plain chat and keeps working
 *      where the plugin is not loaded.
 *   4. Claude Code's three registry files, written directly. There is no public
 *      API for "install this plugin" from outside a session, so this reproduces
 *      what `/plugin install` does. See the comment on `register()`.
 *   5. The database, created and seeded.
 *
 * Every step is idempotent: running it twice is how you upgrade.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { dbPath, eklavyaHome } from './paths.js';

const MIN_NODE_MAJOR = 22;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** The npm package root — `dist/` under a build, so one level up. */
function packageRoot(): string {
  return path.dirname(moduleDir);
}

/** The plugin payload the build copies into the package (see copy-assets.mjs). */
function payloadDir(): string {
  return path.join(moduleDir, 'plugin');
}

function packageVersion(): string {
  const manifest = path.join(packageRoot(), 'package.json');
  return JSON.parse(fs.readFileSync(manifest, 'utf8')).version as string;
}

/**
 * Claude Code's config root. `CLAUDE_CONFIG_DIR` is the documented override and
 * people with several profiles do set it — writing to `~/.claude` regardless
 * would install into a directory their Claude Code never reads.
 */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

export function marketplaceDir(): string {
  return path.join(claudeHome(), 'plugins', 'marketplaces', 'eklavya');
}

export function runtimeHome(): string {
  return process.env.EKLAVYA_RUNTIME ?? path.join(eklavyaHome(), 'runtime');
}

const say = (line: string) => process.stdout.write(`${line}\n`);

// --- 1. prerequisites -------------------------------------------------------

/** How to get a modern Node, on the platform actually in front of them. */
function nodeAdvice(): string {
  if (process.platform === 'win32') {
    return [
      '  winget install OpenJS.NodeJS.LTS',
      '  …or download the installer from https://nodejs.org',
    ].join('\n');
  }
  if (process.platform === 'darwin') {
    return ['  brew install node', '  …or download the installer from https://nodejs.org'].join('\n');
  }
  return [
    '  Use your distribution package, nvm, or https://nodejs.org',
    '  e.g. nvm install 22 && nvm use 22',
  ].join('\n');
}

function checkNode(): void {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= MIN_NODE_MAJOR) return;

  process.stderr.write(
    `Eklavya needs Node ${MIN_NODE_MAJOR} or newer — this is Node ${process.versions.node}.\n\n` +
      'Below Node 22, the SQLite driver has no prebuilt binary for your platform and npm\n' +
      'tries to compile it, which needs a full C++ toolchain. Upgrading Node is the fix:\n\n' +
      `${nodeAdvice()}\n\nThen run \`npx eklavya install\` again.\n`,
  );
  process.exit(1);
}

/**
 * git is optional, and saying so matters. Eklavya keys a project's difficulty
 * level on the repository root, and the commit gate is a git hook — without git
 * both degrade to the shared bucket rather than failing.
 */
function checkGit(): boolean {
  const probe = spawnSync('git', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  return probe.status === 0;
}

/**
 * Is `eklavya` on the caller's PATH?
 *
 * It usually is not. `npx eklavya install` runs the package out of npx's cache
 * and leaves no global binary, so telling that caller to "run `eklavya doctor`"
 * sends them straight into `command not found`. The runtime install does put a
 * real binary at `~/.eklavya/runtime/node_modules/.bin/eklavya`, but nothing
 * puts that directory on PATH, and writing into a global bin ourselves is not
 * this installer's business.
 *
 * So: check, and say something true either way.
 */
function cliOnPath(): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32'
    ? ['eklavya.cmd', 'eklavya.exe', 'eklavya.ps1', 'eklavya']
    : ['eklavya'];
  return dirs.some((d) => names.some((n) => {
    try {
      return fs.statSync(path.join(d, n)).isFile() || fs.lstatSync(path.join(d, n)).isSymbolicLink();
    } catch {
      return false;
    }
  }));
}

// --- 2. the runtime ---------------------------------------------------------

function installRuntime(version: string): void {
  const home = runtimeHome();
  fs.mkdirSync(home, { recursive: true });

  // A stamp file so the plugin's background self-heal does not race a manual
  // install. Removed in the finally, whatever happens.
  const stamp = path.join(home, '.installing');
  fs.writeFileSync(stamp, String(process.pid), 'utf8');

  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(
      npm,
      [
        'install',
        `eklavya@${version}`,
        '--prefix',
        home,
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
      ],
      { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' },
    );

    if (result.status !== 0) {
      process.stderr.write(
        '\nInstalling the Eklavya runtime failed. The output above says why — the usual\n' +
          'causes are no network, or a registry proxy that blocks the download.\n' +
          `You can retry with: npm install eklavya@${version} --prefix ${home}\n`,
      );
      process.exit(1);
    }
  } finally {
    try {
      fs.rmSync(stamp, { force: true });
    } catch {
      /* nothing depends on the stamp being gone */
    }
  }
}

/** The compiled server the plugin actually loads, wherever the runtime is. */
function runtimeEntry(): string {
  return path.join(runtimeHome(), 'node_modules', 'eklavya', 'dist', 'server.js');
}

/**
 * Loads the native dependency in a child process and returns why it failed, or
 * null if it works. A prebuilt binary for the wrong ABI installs cleanly and
 * throws on first require — which would otherwise surface as a dead MCP server
 * three commands later.
 *
 * Out of process on purpose: a bad `.node` can abort the interpreter rather than
 * throw, and `doctor` must survive reporting that.
 */
function driverError(): string | null {
  const probe = spawnSync(
    process.execPath,
    ['-e', 'require(process.argv[1]); console.log("ok")', path.join(runtimeHome(), 'node_modules', 'better-sqlite3')],
    { encoding: 'utf8' },
  );
  if (probe.status === 0) return null;

  // Node's crash dump is source excerpt, then the error, then a stack, then a
  // `Node.js v26.7.0` trailer. The last line is that trailer and says nothing;
  // the `Error:` line is the one naming the missing symbol or wrong ABI.
  const out = (probe.stderr ?? '').trim().split('\n').map((l) => l.trim());
  return out.find((l) => /^[A-Za-z]*Error:/.test(l)) ?? out.find(Boolean) ?? 'unknown error';
}

/** Install-time gate: the same two checks, but fatal. */
function verifyRuntime(): void {
  const entry = runtimeEntry();
  if (!fs.existsSync(entry)) {
    process.stderr.write(`The runtime installed but ${entry} is missing.\n`);
    process.exit(1);
  }

  const err = driverError();
  if (err) {
    process.stderr.write(
      '\nThe SQLite driver installed but will not load:\n' +
        `${err}\n\n` +
        'This usually means the prebuilt binary does not match this Node version.\n' +
        `Try removing ${runtimeHome()} and running \`npx eklavya install\` again.\n`,
    );
    process.exit(1);
  }
}

// --- 3. the plugin payload --------------------------------------------------

/**
 * True when the marketplace directory is a git checkout Claude Code maintains.
 *
 * `/plugin marketplace add ProjectAJ14/eklavya` clones the repository here and
 * keeps it current with `autoUpdate`. Eklavya's marketplace manifest lists its
 * plugin at `./`, so the plugin IS that checkout — which means replacing the
 * directory would delete the clone and leave autoUpdate pulling into nothing.
 */
function isGitManaged(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

function git(dir: string, args: string[]) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/**
 * Bring a git-managed checkout up to date the only way that is safe: `git pull
 * --ff-only`, which is what `/plugin update` amounts to.
 *
 * Two things it will not do. It will not touch a checkout with local changes —
 * someone editing the plugin in place is developing against it, and losing
 * their work to an installer is not a trade Eklavya gets to make. And it will
 * not force anything: a diverged or detached checkout fails the pull and is
 * reported, not resolved.
 *
 * This tracks the checkout's own branch, so it lands on whatever that branch
 * points at now, which is not necessarily the npm version being installed.
 * That is the same thing `/plugin update` would have given them.
 */
type CheckoutResult = 'updated' | 'current' | 'dirty' | 'failed';

function updateCheckout(dir: string): CheckoutResult {
  const head = () => git(dir, ['rev-parse', 'HEAD']).stdout?.trim() ?? '';
  const before = head();
  if (!before) return 'failed';
  if (git(dir, ['status', '--porcelain']).stdout?.trim()) return 'dirty';
  const pull = git(dir, ['pull', '--ff-only', '--quiet']);
  if (pull.status !== 0) {
    // git's own reason, or "could not pull" is a support ticket with no clue in it.
    const why = (pull.stderr ?? '').trim();
    if (why) process.stderr.write(`${why}\n`);
    return 'failed';
  }
  return head() === before ? 'current' : 'updated';
}

type PayloadResult = 'copied' | CheckoutResult;

function copyPayload(): PayloadResult {
  const from = payloadDir();
  if (!fs.existsSync(from)) {
    process.stderr.write(
      `The plugin payload is missing from this package (expected ${from}).\n` +
        'This is a packaging bug — please report it.\n',
    );
    process.exit(1);
  }

  const to = marketplaceDir();

  // Someone else's directory. Git is the source of truth for its contents, so
  // copying over the top would only produce a checkout whose files no longer
  // match its own HEAD — pull it instead.
  if (isGitManaged(to)) return updateCheckout(to);

  // Ours, so replace rather than merge: a stale hook or skill left behind by an
  // older version is worse than a slow copy.
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  return 'copied';
}

// --- 3b. the user-level skill -----------------------------------------------

/**
 * `~/.claude/skills/eklavya/` — the one part of Eklavya that is installed for
 * the *user* rather than for the plugin.
 *
 * The plugin's own skills are all `disable-model-invocation: true`, so they are
 * slash commands and nothing else: "go easier on me" in plain chat reaches
 * none of them. This skill is model-invocable and teaches an agent to drive the
 * `eklavya` CLI, which also means it keeps working where the plugin is not
 * loaded at all — a bare terminal session, another editor, a repo where the
 * plugin is disabled.
 */
export function userSkillDir(): string {
  return path.join(claudeHome(), 'skills', 'eklavya');
}

function skillPayloadDir(): string {
  return path.join(moduleDir, 'user-skill', 'eklavya');
}

/**
 * True when the file at this path is ours to replace.
 *
 * `~/.claude/skills/` is the user's own namespace, not a directory Eklavya
 * owns, and a name collision there is somebody's hand-written skill. Reading
 * the frontmatter `name` is enough to tell them apart, and an unreadable or
 * unrecognised file is treated as theirs — refusing to overwrite something we
 * cannot identify is the safe direction to be wrong in.
 */
function isOurSkill(file: string): boolean {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 2048);
    return /^name:\s*["']?eklavya["']?\s*$/m.test(head);
  } catch {
    return false;
  }
}

type SkillResult = 'installed' | 'foreign' | 'missing';

function installSkill(): SkillResult {
  const from = skillPayloadDir();
  if (!fs.existsSync(from)) return 'missing';

  const to = userSkillDir();
  const target = path.join(to, 'SKILL.md');
  if (fs.existsSync(target) && !isOurSkill(target)) return 'foreign';

  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  return 'installed';
}

/** Symmetric with installSkill(): never removes a skill that is not ours. */
function removeSkill(): boolean {
  const dir = userSkillDir();
  const target = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(target) || !isOurSkill(target)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// --- 4. Claude Code's registries --------------------------------------------

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Write via temp file + rename: Claude Code may be reading this mid-write. */
function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Registers the plugin the way `/plugin install` would.
 *
 * There is no supported CLI for this, so these three files are written directly.
 * That is a real cost and worth naming: their shape is Claude Code's private
 * business and can change — `installed_plugins.json` already carries a
 * `"version": 2`. The mitigation is that every write is additive and keyed, so a
 * shape change loses the registration rather than corrupting anyone's config,
 * and `eklavya doctor` reports it.
 *
 * The marketplace is registered with its GitHub source even though the files
 * came from npm, and deliberately: that is what lets Claude Code's own
 * `/plugin update` take over afterwards. npm is the on-ramp, not the channel.
 *
 * ponytail: three private files, no public API. If Claude Code ever ships
 * `claude plugin install --local`, delete this and shell out to it.
 */
function register(version: string): void {
  const pluginsDir = path.join(claudeHome(), 'plugins');

  const marketplaces = path.join(pluginsDir, 'known_marketplaces.json');
  const known = readJson(marketplaces);
  known.eklavya = {
    source: { source: 'github', repo: 'ProjectAJ14/eklavya' },
    installLocation: marketplaceDir(),
    lastUpdated: new Date().toISOString(),
    autoUpdate: true,
  };
  writeJson(marketplaces, known);

  // The value here is an ARRAY, one entry per scope: a `user` install and any
  // number of `local` ones, each pinned to a project directory. Assigning a
  // fresh array would silently uninstall the plugin from every project someone
  // had added it to -- so this replaces the `user` entry and leaves the rest
  // exactly as it found them.
  const installedPath = path.join(pluginsDir, 'installed_plugins.json');
  const installed = readJson(installedPath);
  if (typeof installed.version !== 'number') installed.version = 2;
  const plugins = (installed.plugins ?? {}) as Record<string, unknown>;

  const existing = Array.isArray(plugins['eklavya@eklavya'])
    ? (plugins['eklavya@eklavya'] as Array<Record<string, unknown>>)
    : [];
  const otherScopes = existing.filter((entry) => entry?.scope !== 'user');
  const previousUser = existing.find((entry) => entry?.scope === 'user');
  const now = new Date().toISOString();

  plugins['eklavya@eklavya'] = [
    ...otherScopes,
    {
      scope: 'user',
      installPath: marketplaceDir(),
      version,
      // Kept, so re-running this reads as an upgrade rather than a fresh install.
      installedAt: (previousUser?.installedAt as string | undefined) ?? now,
      lastUpdated: now,
    },
  ];
  installed.plugins = plugins;
  writeJson(installedPath, installed);

  const settingsPath = path.join(claudeHome(), 'settings.json');
  const settings = readJson(settingsPath);
  const enabled = (settings.enabledPlugins ?? {}) as Record<string, boolean>;
  enabled['eklavya@eklavya'] = true;
  settings.enabledPlugins = enabled;
  writeJson(settingsPath, settings);
}

function deregister(): Array<Record<string, unknown>> {
  const pluginsDir = path.join(claudeHome(), 'plugins');

  const marketplaces = path.join(pluginsDir, 'known_marketplaces.json');
  const known = readJson(marketplaces);
  if ('eklavya' in known) {
    delete known.eklavya;
    writeJson(marketplaces, known);
  }

  // Symmetric with register(): drop the `user` entry this CLI owns and leave
  // project-scoped installs alone. Returns them so the caller can say they are
  // still there rather than leaving someone with a half-removed plugin.
  const installedPath = path.join(pluginsDir, 'installed_plugins.json');
  const installed = readJson(installedPath);
  const plugins = (installed.plugins ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(plugins['eklavya@eklavya'])
    ? (plugins['eklavya@eklavya'] as Array<Record<string, unknown>>)
    : [];
  const otherScopes = existing.filter((entry) => entry?.scope !== 'user');

  if (existing.length > 0) {
    if (otherScopes.length > 0) plugins['eklavya@eklavya'] = otherScopes;
    else delete plugins['eklavya@eklavya'];
    installed.plugins = plugins;
    writeJson(installedPath, installed);
  }

  const settingsPath = path.join(claudeHome(), 'settings.json');
  const settings = readJson(settingsPath);
  const enabled = (settings.enabledPlugins ?? {}) as Record<string, boolean>;
  if ('eklavya@eklavya' in enabled) {
    delete enabled['eklavya@eklavya'];
    settings.enabledPlugins = enabled;
    writeJson(settingsPath, settings);
  }

  return otherScopes;
}

// --- health -----------------------------------------------------------------

export type Check = { name: string; ok: boolean; detail: string };

/**
 * What `eklavya doctor` checks beyond the database: the four things that break
 * *after* a successful install and that nothing else notices.
 *
 * They are silent failures, every one. The hooks exit 0 whatever happens
 *, so a dead runtime or a de-registered plugin costs a learner a
 * week of quizzes with no error anywhere — the only symptom is that Eklavya
 * stopped asking. This is the one place that says so.
 *
 * Every failure has the same fix, because `install()` is idempotent by design:
 * re-running it reinstalls the runtime, re-copies the payload and rewrites the
 * registry files. `doctor` names that command rather than repairing anything
 * itself — a diagnostic that silently rewrites the user's Claude Code config is
 * not a diagnostic.
 */
export function health(): Check[] {
  const checks: Check[] = [];

  const entry = runtimeEntry();
  const haveRuntime = fs.existsSync(entry);
  checks.push({
    name: 'runtime',
    ok: haveRuntime,
    detail: haveRuntime ? runtimeHome() : `no compiled server at ${entry}`,
  });

  // Only meaningful once the runtime is there; probing an absent directory
  // would report a require error that says nothing the line above did not.
  if (haveRuntime) {
    const err = driverError();
    checks.push({
      name: 'driver',
      ok: err === null,
      detail: err === null
        ? `better-sqlite3 loads on Node ${process.versions.node}`
        : `will not load on Node ${process.versions.node} — ${err}`,
    });
  }

  checks.push(pluginCheck());

  const skillFile = path.join(userSkillDir(), 'SKILL.md');
  const haveSkill = fs.existsSync(skillFile);
  checks.push({
    name: 'skill',
    ok: haveSkill && isOurSkill(skillFile),
    detail: !haveSkill
      ? `nothing at ${skillFile}`
      : isOurSkill(skillFile)
        ? userSkillDir()
        // `install` will not overwrite someone else's skill either, so "run
        // install" alone is a dead end here. Name the step that unblocks it.
        : `${skillFile} is a different skill named eklavya — move it first`,
  });

  return checks;
}

/**
 * Is the plugin still registered with Claude Code and switched on?
 *
 * Reads the three files `register()` writes. Their shape is Claude Code's
 * private business and can change, which is exactly why this reports rather
 * than repairs: a shape change should read as "not registered" and be fixed by
 * an installer that knows the current shape, not patched here.
 */
function pluginCheck(): Check {
  const dir = marketplaceDir();
  if (!fs.existsSync(dir)) {
    return { name: 'plugin', ok: false, detail: `nothing at ${dir}` };
  }

  const installed = readJson(path.join(claudeHome(), 'plugins', 'installed_plugins.json'));
  const entries = (installed.plugins as Record<string, unknown> | undefined)?.['eklavya@eklavya'];
  const registered = Array.isArray(entries) && entries.length > 0;
  if (!registered) {
    return { name: 'plugin', ok: false, detail: `${dir} — on disk but not registered` };
  }

  // Anything but an explicit `true` counts as off. Both install routes write
  // this key — `register()` here, and `/plugin install` in Claude Code — so a
  // missing one means something removed it, and reading that as healthy is the
  // one failure this whole command exists to prevent. Being wrong the other way
  // costs a run of an idempotent installer.
  const settings = readJson(path.join(claudeHome(), 'settings.json'));
  const enabled = (settings.enabledPlugins as Record<string, boolean> | undefined)?.['eklavya@eklavya'];
  if (enabled !== true) {
    return { name: 'plugin', ok: false, detail: 'registered but not enabled in settings.json' };
  }

  return { name: 'plugin', ok: true, detail: `${dir} — registered, enabled` };
}

// --- commands ---------------------------------------------------------------

export function install(args: string[]): void {
  const version = packageVersion();
  say(`Installing Eklavya ${version}`);

  checkNode();
  say(`  node        ${process.versions.node}`);

  if (!args.includes('--skip-runtime')) {
    say('  runtime     installing (first run downloads the SQLite driver)…');
    installRuntime(version);
    verifyRuntime();
    say(`  runtime     ${runtimeHome()}`);
  }

  const payload = copyPayload();
  const notes: Record<PayloadResult, string> = {
    copied: '',
    updated: ' (git checkout — pulled)',
    current: ' (git checkout — already current)',
    dirty: ' (git checkout with local changes — left as it is)',
    failed: ' (git checkout — could not pull, left as it is)',
  };
  say(`  plugin      ${marketplaceDir()}${notes[payload]}`);

  if (!args.includes('--skip-skill')) {
    const skill = installSkill();
    if (skill === 'installed') say(`  skill       ${userSkillDir()}`);
    else if (skill === 'foreign') {
      say(`  skill       skipped — ${path.join(userSkillDir(), 'SKILL.md')} is not ours`);
    } else say('  skill       not in this package (skipped)');
  }

  register(version);
  say('  registered  eklavya@eklavya, enabled for Claude Code');

  // Creating the DB here rather than on first server start means `eklavya
  // doctor` and the dashboard work before Claude Code has ever been opened.
  const db = openDb();
  db.close();
  say(`  database    ${dbPath()}`);

  if (!checkGit()) {
    say('');
    say('  note: git was not found. Eklavya still works — the per-project difficulty');
    say('        level falls back to a shared bucket, and the commit gate needs git.');
  }

  say('');
  if (payload === 'dirty' || payload === 'failed') {
    // Said plainly, because otherwise this install looks like it did nothing.
    say('You added Eklavya through `/plugin marketplace add`, so the plugin files are');
    say(payload === 'dirty'
      ? 'that git checkout — and it has uncommitted changes, so this left it alone.'
      : 'that git checkout, and pulling it failed — so this left it alone.');
    say('The runtime and database above are installed and current.');
    say('To move the plugin itself, commit or stash there and re-run this, or use');
    say('`/plugin update eklavya` in Claude Code.');
    say('');
  }
  say('Done. Restart Claude Code (or start a session) and Eklavya loads with it.');
  if (cliOnPath()) {
    say('Next: run /eklavya:setup in Claude Code to choose a mode, or `eklavya doctor` here.');
  } else {
    // Ran through npx, most likely: the plugin is installed but no `eklavya`
    // command exists. Say so rather than suggesting one that is not there.
    say('Next: run /eklavya:setup in Claude Code to choose a mode.');
    say('');
    say('The `eklavya` command is not on your PATH. For the CLI — `doctor`,');
    say('`dashboard`, `config` — install it once:');
    say('');
    say('  npm install -g eklavya');
  }
}

export function uninstall(args: string[]): void {
  const purge = args.includes('--purge');

  const otherScopes = deregister();
  say('  registered  removed from Claude Code');

  // Removing the shared directory out from under a project-scoped install would
  // leave that project pointing at nothing, so it stays until those go too.
  if (otherScopes.length === 0) {
    fs.rmSync(marketplaceDir(), { recursive: true, force: true });
    say('  plugin      removed');
  } else {
    say(`  plugin      kept — still installed in ${otherScopes.length} project(s)`);
  }

  if (removeSkill()) say('  skill       removed');

  fs.rmSync(runtimeHome(), { recursive: true, force: true });
  say('  runtime     removed');

  if (purge) {
    // Only ever on an explicit flag. This is everything the learner has done —
    // months of spaced repetition — and an uninstall that silently deletes it is
    // not an uninstall, it is data loss.
    fs.rmSync(eklavyaHome(), { recursive: true, force: true });
    say(`  data        removed (${eklavyaHome()})`);
  } else {
    say(`  data        kept (${dbPath()}) — pass --purge to delete your learning history`);
  }

  say('');
  if (otherScopes.length > 0) {
    say('Removed for your user account. These project-scoped installs remain, and');
    say('were not touched — remove them with `/plugin uninstall` in each project:');
    for (const entry of otherScopes) {
      say(`  ${String(entry.projectPath ?? 'unknown project')} (${String(entry.version ?? '?')})`);
    }
    say('');
  }
  say('Eklavya is uninstalled. Restart Claude Code to unload it.');
}
