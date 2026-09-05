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
 *   3. The plugin payload, copied into the Claude Code marketplace directory.
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

/**
 * Proves the native dependency actually loads, rather than trusting that npm
 * exiting 0 means a working binary. A prebuilt binary for the wrong ABI installs
 * cleanly and throws on first require — which would otherwise surface as a dead
 * MCP server three commands later.
 */
function verifyRuntime(): void {
  const entry = path.join(runtimeHome(), 'node_modules', 'eklavya', 'dist', 'server.js');
  if (!fs.existsSync(entry)) {
    process.stderr.write(`The runtime installed but ${entry} is missing.\n`);
    process.exit(1);
  }

  const probe = spawnSync(
    process.execPath,
    ['-e', 'require(process.argv[1]); console.log("ok")', path.join(runtimeHome(), 'node_modules', 'better-sqlite3')],
    { encoding: 'utf8' },
  );

  if (probe.status !== 0) {
    process.stderr.write(
      '\nThe SQLite driver installed but will not load:\n' +
        `${(probe.stderr ?? '').trim()}\n\n` +
        'This usually means the prebuilt binary does not match this Node version.\n' +
        `Try removing ${runtimeHome()} and running \`npx eklavya install\` again.\n`,
    );
    process.exit(1);
  }
}

// --- 3. the plugin payload --------------------------------------------------

function copyPayload(): void {
  const from = payloadDir();
  if (!fs.existsSync(from)) {
    process.stderr.write(
      `The plugin payload is missing from this package (expected ${from}).\n` +
        'This is a packaging bug — please report it.\n',
    );
    process.exit(1);
  }

  const to = marketplaceDir();
  // Replace rather than merge: a stale hook or skill left behind by an older
  // version is worse than a slow copy, and this directory is ours entirely.
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
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

  const installedPath = path.join(pluginsDir, 'installed_plugins.json');
  const installed = readJson(installedPath);
  if (typeof installed.version !== 'number') installed.version = 2;
  const plugins = (installed.plugins ?? {}) as Record<string, unknown>;
  plugins['eklavya@eklavya'] = [
    {
      scope: 'user',
      installPath: marketplaceDir(),
      version,
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
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

function deregister(): void {
  const pluginsDir = path.join(claudeHome(), 'plugins');

  const marketplaces = path.join(pluginsDir, 'known_marketplaces.json');
  const known = readJson(marketplaces);
  if ('eklavya' in known) {
    delete known.eklavya;
    writeJson(marketplaces, known);
  }

  const installedPath = path.join(pluginsDir, 'installed_plugins.json');
  const installed = readJson(installedPath);
  const plugins = (installed.plugins ?? {}) as Record<string, unknown>;
  if ('eklavya@eklavya' in plugins) {
    delete plugins['eklavya@eklavya'];
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

  copyPayload();
  say(`  plugin      ${marketplaceDir()}`);

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
  say('Done. Restart Claude Code (or start a session) and Eklavya loads with it.');
  say('Next: run /eklavya:setup in Claude Code to choose a mode, or `eklavya doctor` here.');
}

export function uninstall(args: string[]): void {
  const purge = args.includes('--purge');

  deregister();
  say('  registered  removed from Claude Code');

  fs.rmSync(marketplaceDir(), { recursive: true, force: true });
  say('  plugin      removed');

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
  say('Eklavya is uninstalled. Restart Claude Code to unload it.');
}
