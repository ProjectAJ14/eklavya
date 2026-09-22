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
 *   6. The dials, walked one at a time on every run (`onboard.ts`) — and, if
 *      Claude Mem is here, which of the two records memory. See `claude-mem.ts`.
 *
 * Every step is idempotent: running it twice is how you upgrade.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { dbPath, eklavyaHome, globalConfigPath } from './paths.js';
import { check, dim, heading, paint, plain, spin, verdict } from './theme.js';
import { loadGlobalConfig, readConfigFile, writeConfigFile } from './config.js';
import { ImportError, IMPORTED_TABLES } from './memory/import.js';
import { importOffThread } from './memory/import-worker.js';
import { askOne, onboard, type MemoryOwner } from './onboard.js';
import {
  activeClaudeMemPluginIds,
  claudeMemDb,
  claudeMemDir,
  removeClaudeMemPlugin,
  retireClaudeMemDir,
} from './claude-mem.js';

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

async function installRuntime(version: string): Promise<void> {
  const home = runtimeHome();
  fs.mkdirSync(home, { recursive: true });

  // A stamp file so the plugin's background self-heal does not race a manual
  // install. Removed in the finally, whatever happens.
  const stamp = path.join(home, '.installing');
  fs.writeFileSync(stamp, String(process.pid), 'utf8');

  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    // Async and captured, not inherited: npm writing over the spinner's row
    // garbles both. Its output is replayed below if it fails.
    const result = await spin('runtime', 'installing (first run downloads the SQLite driver)…', () =>
      new Promise<{ status: number | null; output: string }>((resolve) => {
        let output = '';
        const child = spawn(
          npm,
          ['install', `eklavya@${version}`, '--prefix', home, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
          { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
        );
        child.stdout.on('data', (d) => (output += d));
        child.stderr.on('data', (d) => (output += d));
        child.once('error', (err) => resolve({ status: null, output: `${output}${err.message}\n` }));
        child.once('close', (status) => resolve({ status, output }));
      }),
    );

    if (result.status !== 0) {
      process.stderr.write(result.output);
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
  composeStatusLine(settings);
  writeJson(settingsPath, settings);
}

/** The status bar command this installer owns, and the only one it will remove. */
const STATUS_LINE_COMMAND = `node ${path.join(runtimeHome(), 'node_modules', 'eklavya', 'dist', 'cli.js')} statusline`;

/**
 * Puts the dials in the status bar, and never over somebody else's.
 *
 * `statusLine` holds one command, so "install ours" and "keep yours" cannot
 * both happen — and between the two, keeping theirs is obviously right: a
 * status bar is a thing people build deliberately, often with a script that
 * took an afternoon. So this writes only into an empty slot, and the manual
 * keeps the by-hand instructions for anyone who wants to compose the two
 * themselves.
 *
 * The removal in `deregister` matches on the command being exactly ours, which
 * is what stops an uninstall taking a line it did not write.
 */
function composeStatusLine(settings: Record<string, unknown>): void {
  const existing = settings.statusLine;
  if (existing !== undefined && existing !== null) {
    const command = (existing as { command?: unknown })?.command;
    // Ours already, possibly from an older runtime path: refresh it.
    if (typeof command === 'string' && /dist[\\/]cli\.js["']? statusline\b/.test(command)) {
      settings.statusLine = { type: 'command', command: STATUS_LINE_COMMAND, padding: 0 };
    }
    return;
  }
  settings.statusLine = { type: 'command', command: STATUS_LINE_COMMAND, padding: 0 };
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
  // Only a status line that is exactly ours. Somebody else's stays, and so
  // does one they composed by hand around ours -- this installer did not write
  // it and has no business deciding what is left of it.
  const line = (settings.statusLine as { command?: unknown } | undefined)?.command;
  const ownsStatusLine = typeof line === 'string' && line === STATUS_LINE_COMMAND;
  if (ownsStatusLine) {
    delete settings.statusLine;
    writeJson(settingsPath, settings);
  }
  if ('eklavya@eklavya' in enabled) {
    delete enabled['eklavya@eklavya'];
    settings.enabledPlugins = enabled;
    writeJson(settingsPath, settings);
  }

  return otherScopes;
}

// --- 6. Claude Mem ---------------------------------------------------------

function setEklavyaMemory(enabled: boolean): void {
  const file = globalConfigPath();
  const memory = (readConfigFile(file).memory ?? {}) as Record<string, unknown>;
  if (memory.enabled === enabled || (enabled && memory.enabled === undefined)) return;
  writeConfigFile(file, { memory: { ...memory, enabled } });
}

/** Every retired Claude Mem database: `~/.claude-mem.retired`, `.retired-2`, … */
function retiredClaudeMemDbs(): string[] {
  const dir = claudeMemDir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.dirname(dir));
  } catch {
    return [];
  }
  const base = path.basename(dir);
  return names
    .filter((n) => n === `${base}.retired` || n.startsWith(`${base}.retired-`))
    .map((n) => path.join(path.dirname(dir), n, 'claude-mem.db'))
    .filter((f) => fs.existsSync(f));
}

/**
 * Imports `source` -- or, for one already imported, re-checks it -- and proves
 * the result row by row. Idempotent, so every install can run it: a first
 * migration imports, a later install files what an earlier run could not
 * place (a checkout found since, or one moved), and adds nothing twice.
 *
 * A project two checkouts could be is asked about, not guessed. Throws when
 * the import fails or any source row is missing.
 */
async function crossReference(source: string): Promise<void> {
  const shown = source.replace(os.homedir(), '~');
  const run = (projectMap: Record<string, string>) =>
    spin('claude-mem', `checking ${shown} against Eklavya…`, () =>
      importOffThread({ dbFile: dbPath(), source, opts: { projectMap }, guessFrom: claudeHome() }),
    );
  let { report, verified, unsure } = await run({});
  let rehomed = report.rehomed;

  const chosen: Record<string, string> = {};
  for (const [name, paths] of Object.entries(unsure)) {
    const pick = await askOne(name, `Claude Mem history — ${paths.length} checkouts carry this name`, 'skip', [
      ...paths.map((p) => ({ value: p, detail: '' })),
      { value: 'skip', detail: 'leave it unplaced for now' },
    ]);
    if (pick && pick !== 'skip') chosen[name] = pick;
  }
  if (Object.keys(chosen).length) {
    ({ report, verified } = await run(chosen));
    rehomed += report.rehomed;
  }

  if (!report.validation.ok) throw new ImportError(report.validation.notes.join('; '));
  // By id, not by count: a fresh migration retires the source next, so this is
  // the last moment a gap is cheap to see.
  const missing = verified.tables.reduce((n, t) => n + t.missing.length, 0);
  if (missing) throw new ImportError(`${missing} source row(s) did not arrive`);

  const total = verified.tables.reduce((n, t) => n + t.present, 0);
  const added = IMPORTED_TABLES.reduce((n, t) => n + report.imported[t], 0);
  const news = [added && `${added} imported`, rehomed && `${rehomed} filed under their checkout`].filter(Boolean);
  check('ok', 'claude-mem', `${total} rows, all here ${dim(`— ${news.length ? news.join(', ') : 'nothing new'} · ${shown}`)}`);

  const unplaced = verified.projects.filter((p) => Object.keys(p.filedUnder).some((k) => !path.isAbsolute(k)));
  if (unplaced.length) {
    const names = unplaced.map((p) => p.project);
    check('warn', 'unplaced', `${names.length} project(s) ${dim(`— ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}`)}`);
    check(null, '', dim(`searchable with --all-projects; place one: eklavya memory import ${shown} --map <name>=<checkout>`));
  }
}

/**
 * Two recorders is the one outcome this must never leave behind, so every path
 * out of here ends with exactly one: a failed import keeps Claude Mem and
 * switches Eklavya's recording off, rather than leaving both half-on.
 */
async function resolveClaudeMem(owner: MemoryOwner): Promise<void> {
  const ids = activeClaudeMemPluginIds(claudeHome());
  const haveDb = fs.existsSync(claudeMemDb());

  if (owner === 'claude-mem') {
    setEklavyaMemory(false);
    check('skip', 'memory', `off ${dim('— Claude Mem keeps recording')}`);
    check(null, '', dim('switch later: eklavya install --memory eklavya'));
    return;
  }

  if (haveDb) {
    try {
      // Inside the try: a corrupt source fails here, and must take the same
      // one-recorder exit as a failed import.
      await crossReference(claudeMemDb());
    } catch (err) {
      setEklavyaMemory(false);
      check('fail', 'claude-mem', `import failed ${dim(`— ${(err as Error).message}`)}`);
      check(null, '', dim('kept Claude Mem, turned Eklavya memory off. Retry: eklavya memory import'));
      return;
    }
  }

  setEklavyaMemory(true);
  if (ids.length) {
    const how = await spin('claude-mem', 'uninstalling the plugin…', () => removeClaudeMemPlugin(claudeHome(), ids));
    check('ok', 'claude-mem', `plugin ${how}`);
  }
  // ponytail: Claude Mem's background worker, if one is up, lives until its
  // next restart; with no plugin left, nothing restarts it.
  if (!fs.existsSync(claudeMemDir())) return;
  try {
    // Windows refuses to rename a directory with a file held open -- Claude
    // Mem's worker, typically. The import already happened; the move is tidying.
    if (haveDb) check('ok', 'claude-mem', `data moved to ${retireClaudeMemDir()} ${dim('— delete it once you are happy')}`);
    else check('ok', 'claude-mem', `data left at ${claudeMemDir()}`);
  } catch (err) {
    check('warn', 'claude-mem', `data left at ${claudeMemDir()} ${dim(`— could not move it: ${(err as Error).message}`)}`);
  }
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

export async function install(args: string[]): Promise<void> {
  const flagAt = args.indexOf('--memory');
  const memoryFlag = flagAt < 0 ? null : args[flagAt + 1];
  if (memoryFlag !== null && memoryFlag !== 'eklavya' && memoryFlag !== 'claude-mem') {
    process.stderr.write('--memory takes eklavya or claude-mem\n');
    process.exit(1);
  }
  const version = packageVersion();
  heading(`eklavya install ${dim(version)}`);

  checkNode();
  check('ok', 'node', process.versions.node);

  if (!args.includes('--skip-runtime')) {
    await installRuntime(version);
    verifyRuntime();
    check('ok', 'runtime', runtimeHome());
  }

  const payload = copyPayload();
  const notes: Record<PayloadResult, string> = {
    copied: '',
    updated: 'git checkout — pulled',
    current: 'git checkout — already current',
    dirty: 'git checkout with local changes — left as it is',
    failed: 'git checkout — could not pull, left as it is',
  };
  const stuck = payload === 'dirty' || payload === 'failed';
  check(stuck ? 'warn' : 'ok', 'plugin', `${marketplaceDir()}${notes[payload] ? ` ${dim(`(${notes[payload]})`)}` : ''}`);

  if (!args.includes('--skip-skill')) {
    const skill = installSkill();
    if (skill === 'installed') check('ok', 'skill', userSkillDir());
    else if (skill === 'foreign') {
      check('skip', 'skill', `skipped ${dim(`— ${path.join(userSkillDir(), 'SKILL.md')} is not ours`)}`);
    } else check('skip', 'skill', dim('not in this package (skipped)'));
  }

  register(version);
  // "and the Code tab" is not padding: that tab runs the same engine against
  // the same `~/.claude`, so this one registration covers it and someone who
  // only ever opens Claude Desktop should not go looking for a second install.
  check('ok', 'registered', `eklavya@eklavya ${dim('— Claude Code CLI and the Code tab in Claude Desktop')}`);

  // Creating the DB here rather than on first server start means `eklavya
  // doctor` and the dashboard work before Claude Code has ever been opened.
  const db = openDb();
  db.close();
  check('ok', 'database', dbPath());

  const claudeMem = activeClaudeMemPluginIds(claudeHome()).length > 0 || fs.existsSync(claudeMemDb());
  const owner = await onboard({
    claudeMem,
    memoryFlag,
    hookScript: path.join(marketplaceDir(), 'scripts', 'install-git-hook.sh'),
  });
  if (owner) await resolveClaudeMem(owner);
  else if (loadGlobalConfig().memory.enabled) {
    // Claude Mem already retired -- by an earlier install, or on another
    // machine and copied over. Re-checking is how an upgrade picks up what an
    // older version left unplaced, with nothing to run by hand.
    for (const retired of retiredClaudeMemDbs()) {
      try {
        await crossReference(retired);
      } catch (err) {
        check('warn', 'claude-mem', `could not check ${retired} ${dim(`— ${(err as Error).message}`)}`);
      }
    }
  }

  if (!checkGit()) {
    check('warn', 'git', `not found ${dim('— the per-project level falls back to a shared bucket, and the commit gate needs git')}`);
  }

  // Cowork is the one surface this installer cannot reach. Its plugin list lives
  // inside Claude Desktop's own data directory, keyed by account and space, and
  // writing there would be reaching into private state on a guess — the same
  // objection `register()` raises about Claude Code's three files, with none of
  // the mitigation, because there is no documented shape to write. So: say where
  // the door is, and say the part people actually worry about, which is whether
  // they end up with two separate learning histories. They do not.
  check('skip', 'cowork', `installs separately ${dim('— Claude Desktop → Customize → Plugins → ProjectAJ14/eklavya')}`);
  check(null, '', dim('same database, so it is one learner, not two'));

  if (stuck) {
    // Said plainly, because otherwise this install looks like it did nothing.
    plain('');
    plain(dim('You added Eklavya through `/plugin marketplace add`, so the plugin files are'));
    plain(dim(payload === 'dirty'
      ? 'that git checkout — and it has uncommitted changes, so this left it alone.'
      : 'that git checkout, and pulling it failed — so this left it alone.'));
    plain(dim('The runtime and database above are installed and current. To move the plugin'));
    plain(dim('itself, commit or stash there and re-run this, or `/plugin update eklavya`.'));
  }
  verdict(null, 'DONE · restart Claude Code and Eklavya loads with it');
  if (cliOnPath()) {
    plain(dim('Next: build something in Claude Code — the questions follow. `eklavya doctor` checks the wiring.'));
  } else {
    // Ran through npx, most likely: the plugin is installed but no `eklavya`
    // command exists. Say so rather than suggesting one that is not there.
    plain(dim('Next: build something in Claude Code — the questions follow.'));
    plain('');
    plain(`The \`eklavya\` command is not on your PATH. For ${dim('doctor, dashboard, config')}:`);
    plain(`  ${paint.aged('npm install -g eklavya')}`);
  }
}

export function uninstall(args: string[]): void {
  const purge = args.includes('--purge');

  heading('eklavya uninstall');
  const otherScopes = deregister();
  check('ok', 'registered', 'removed from Claude Code');

  // Removing the shared directory out from under a project-scoped install would
  // leave that project pointing at nothing, so it stays until those go too.
  if (otherScopes.length === 0) {
    fs.rmSync(marketplaceDir(), { recursive: true, force: true });
    check('ok', 'plugin', 'removed');
  } else {
    check('skip', 'plugin', `kept ${dim(`— still installed in ${otherScopes.length} project(s)`)}`);
  }

  if (removeSkill()) check('ok', 'skill', 'removed');

  fs.rmSync(runtimeHome(), { recursive: true, force: true });
  check('ok', 'runtime', 'removed');

  if (purge) {
    // Only ever on an explicit flag. This is everything the learner has done —
    // months of spaced repetition — and an uninstall that silently deletes it is
    // not an uninstall, it is data loss.
    fs.rmSync(eklavyaHome(), { recursive: true, force: true });
    check('ok', 'data', `removed ${dim(`(${eklavyaHome()})`)}`);
  } else {
    check('skip', 'data', `kept ${dbPath()} ${dim('— pass --purge to delete your learning history')}`);
  }

  if (otherScopes.length > 0) {
    plain('');
    plain(dim('Removed for your user account. These project-scoped installs remain, and'));
    plain(dim('were not touched — remove them with `/plugin uninstall` in each project:'));
    for (const entry of otherScopes) {
      plain(`  ${String(entry.projectPath ?? 'unknown project')} ${dim(`(${String(entry.version ?? '?')})`)}`);
    }
  }
  verdict(null, 'UNINSTALLED · restart Claude Code to unload it');
}
