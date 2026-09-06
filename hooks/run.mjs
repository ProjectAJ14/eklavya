#!/usr/bin/env node
/**
 * The one entry point every Eklavya hook and the MCP server go through.
 *
 * Why this file exists at all: hook commands run under `sh -c` on macOS and
 * Linux, but on Windows under Git Bash, or PowerShell, or — if WSL is installed
 * — WSL's bash, which cannot see Windows paths. Shell hooks are a documented
 * minefield there (claude-code#18610, #21847, #23556, #73971). The hooks
 * reference names the one portable form: `node` plus a script path, because
 * `node.exe` is a real executable and needs no shell. So hooks.json says
 *
 *     "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs", "<name>"]
 *
 * and every platform-specific decision lives here instead of one shell script
 * per hook.
 *
 * The second job is finding the runtime. The plugin payload is source and
 * manifests only — no `dist/`, no `node_modules/`, because a git-installed
 * plugin has neither. The compiled server, the hooks and their one native
 * dependency live in the runtime directory that `eklavya install` populates.
 * Resolution order, most specific first:
 *
 *   1. EKLAVYA_RUNTIME        — tests, and anyone pinning a build
 *   2. the plugin's own mcp/dist   — a development checkout, so edits take effect
 *   3. ~/.eklavya/runtime     — what `npx eklavya install` writes
 *   4. npx eklavya@<pinned>   — the plugin was installed via /plugin and the
 *                               runtime is not there yet
 *
 * Rule 4 is what keeps the two install routes interchangeable: `/plugin install`
 * alone gets you a working MCP server immediately, and the first session heals
 * the rest in the background.
 *
 * Hard rule: a hook must never break a session. Everything here
 * fails to exit 0 in silence.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const name = process.argv[2];
// Not `import.meta.dirname`: it is undefined before Node 20.11, and this file
// has to survive being run by an old Node long enough to say so.
const hereDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? path.dirname(hereDir);
const runtimeHome = process.env.EKLAVYA_RUNTIME ?? path.join(homedir(), '.eklavya', 'runtime');

/** Node 22 is where better-sqlite3 ships a prebuilt binary for every platform
 *  Eklavya supports. Below it, `npm install` falls through to node-gyp and needs
 *  a C++ toolchain — which is exactly the Windows install failure we removed. */
const MIN_NODE_MAJOR = 22;

function pinnedVersion() {
  try {
    const manifest = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    return JSON.parse(readFileSync(manifest, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** The compiled entry point for `name`, or null if no build is reachable. */
function resolveEntry() {
  const relative = name === 'server' ? ['dist', 'server.js'] : ['dist', 'hooks', `${name}.js`];

  const candidates = [
    process.env.EKLAVYA_RUNTIME ? path.join(process.env.EKLAVYA_RUNTIME, ...relative) : null,
    // A development checkout: the plugin root is the repo, so mcp/dist is the
    // build under edit. Requires node_modules too, or better-sqlite3 is missing.
    existsSync(path.join(pluginRoot, 'mcp', 'node_modules', 'better-sqlite3'))
      ? path.join(pluginRoot, 'mcp', ...relative)
      : null,
    path.join(runtimeHome, 'node_modules', 'eklavya', ...relative),
  ].filter(Boolean);

  return candidates.find((file) => existsSync(file)) ?? null;
}

/**
 * Installs the runtime in the background, at most once.
 *
 * This is the self-heal for the `/plugin install` route, which puts the plugin
 * on disk but cannot run npm for us. Detached and fully ignored: the session
 * that triggers it is never blocked, never waits, and never sees the output.
 */
function healInBackground() {
  const version = pinnedVersion();
  if (!version) return;

  // Claim the attempt BEFORE spawning. Every hook fires per session and the
  // check alone would let every one of them start its own npm — a spawn storm
  // on the machine of the person whose install is already struggling. An hour
  // makes the claim self-expiring, so a heal that dies still gets retried
  // tomorrow instead of wedging the runtime as missing forever.
  const stamp = path.join(runtimeHome, '.installing');
  try {
    const age = Date.now() - statSync(stamp).mtimeMs;
    if (age < 60 * 60 * 1000) return;
  } catch {
    /* no stamp: this is the first attempt */
  }

  try {
    mkdirSync(runtimeHome, { recursive: true });
    writeFileSync(stamp, new Date().toISOString());
  } catch {
    // Cannot even write the stamp, so we cannot bound the retries. Doing
    // nothing is the safe failure: the explicit installer still works.
    return;
  }

  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(
      npm,
      ['install', `eklavya@${version}`, '--prefix', runtimeHome, '--omit=dev', '--no-audit', '--no-fund'],
      { detached: true, stdio: 'ignore', shell: process.platform === 'win32' },
    );
    child.unref();
  } catch {
    /* A failed heal is a slow install, not a broken session. */
  }
}

async function main() {
  if (!name) process.exit(0);

  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    // Only the server is worth complaining about — a hook that says this on
    // every tool call is noise. The installer already refuses loudly.
    if (name === 'server') {
      process.stderr.write(
        `[eklavya] Node ${MIN_NODE_MAJOR}+ is required (found ${process.versions.node}).\n`,
      );
    }
    process.exit(0);
  }

  const entry = resolveEntry();

  if (entry) {
    await import(pathToFileURL(entry).href);
    return;
  }

  if (name === 'server') {
    // No runtime yet: fetch it on demand so `/plugin install` alone gives a
    // working server. stdout is the MCP transport, so npx's chatter must not
    // land there.
    const version = pinnedVersion();
    if (!version) process.exit(0);
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(npx, ['--yes', `eklavya@${version}`, 'serve'], {
      stdio: ['inherit', 'inherit', 'ignore'],
      shell: process.platform === 'win32',
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  // A hook with no runtime has nothing to say. Start the heal and get out of
  // the way — the next session will have it.
  healInBackground();
  process.exit(0);
}

main().catch(() => process.exit(0));
