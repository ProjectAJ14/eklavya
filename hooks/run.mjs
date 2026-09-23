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
 * The same heal keeps rule 3 current. The plugin updates itself through Claude
 * Code (a marketplace pull, `/plugin update`); the runtime only moves when npm
 * runs. So when the runtime is older than the plugin pins, this run still uses
 * it — never blocking — and a background install brings it up to the pin,
 * unless the machine opted out with `auto_update: false`. A MISSING runtime is
 * installed whatever that setting says: without it nothing works, and
 * installing the plugin was the request for it.
 *
 * Hard rule: a hook must never break a session. Everything here
 * fails to exit 0 in silence.
 */
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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

/** The version of the runtime `eklavya install` wrote, or null. One small JSON read. */
function runtimeVersion() {
  try {
    const manifest = path.join(runtimeHome, 'node_modules', 'eklavya', 'package.json');
    return JSON.parse(readFileSync(manifest, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** True when version `a` is older than `b`, comparing the numeric parts; a prerelease tag is ignored. */
function olderThan(a, b) {
  const parts = (v) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/**
 * Starts the background heal when the runtime at `entry` is behind the plugin.
 *
 * Only for the runtime directory: an EKLAVYA_RUNTIME build or a development
 * checkout is somebody's deliberate choice. And only when it is BEHIND — a
 * runtime ahead of the plugin (a plugin rolled back, or updated late) is left
 * alone, because migrations only go forward and an older runtime may not
 * understand a database the newer one has already moved. `eklavya doctor`
 * reports the skew either way.
 */
function healIfBehind(entry) {
  if (!entry.startsWith(path.join(runtimeHome, 'node_modules', 'eklavya') + path.sep)) return;
  if (!autoUpdateEnabled()) return;
  const installed = runtimeVersion();
  const pinned = pinnedVersion();
  if (installed && pinned && olderThan(installed, pinned)) healInBackground();
}

/**
 * `auto_update` from the machine's config file — the global one only, as
 * `autoUpdateEnabled` in the runtime's `update.ts` reads it: a project cannot
 * opt the machine in or out. One small JSON read; anything unreadable is the
 * default, which is on.
 */
function autoUpdateEnabled() {
  try {
    const home = process.env.EKLAVYA_HOME ?? path.join(homedir(), '.eklavya');
    return JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')).auto_update !== false;
  } catch {
    return true;
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
  try {
    mkdirSync(runtimeHome, { recursive: true });
  } catch {
    return;
  }
  const stamp = path.join(runtimeHome, '.installing');
  const token = claimHeal(stamp);
  if (!token) return;

  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(
      npm,
      ['install', `eklavya@${version}`, '--prefix', runtimeHome, '--omit=dev', '--no-audit', '--no-fund'],
      { detached: true, stdio: 'ignore', shell: process.platform === 'win32' },
    );
    // No npm on PATH (a GUI-launched app, a Volta shim) is reported as an
    // 'error' event after this try has returned. Unheard, it kills the hook or
    // server this run goes on to import.
    child.on('error', () => {});
    child.unref();
    // The claim now belongs to npm, which outlives this process: it is live
    // exactly as long as npm runs. Nobody breaks a claim whose pid is alive,
    // so the stamp is still this run's to rewrite.
    if (child.pid) writeClaim(stamp, { pid: child.pid, token, at: new Date().toISOString() });
  } catch {
    /* A failed heal is a slow install, not a broken session. */
  }
}

/** Shared with the runtime's `install-lock.ts`, which holds the same rules. */
const LOCK_TTL_MS = 60 * 60 * 1000;
const LEGACY_DATE_MS = 10 * 60 * 1000;
/** How often the heal may start npm, finished or not. */
const HEAL_EVERY_MS = 60 * 60 * 1000;

function ownerOf(text) {
  const body = text.trim();
  if (/^\d+$/.test(body)) return { pid: Number(body), token: null };
  try {
    const value = JSON.parse(body);
    return { pid: typeof value.pid === 'number' ? value.pid : null, token: typeof value.token === 'string' ? value.token : null };
  } catch {
    return { pid: null, token: null };
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Is this stamp somebody's live claim on the runtime? */
function liveClaim(file, text) {
  const age = Date.now() - statSync(file).mtimeMs;
  if (age >= LOCK_TTL_MS) return false;
  const { pid } = ownerOf(text);
  return pid !== null ? pidAlive(pid) : age < LEGACY_DATE_MS;
}

/** Replaces the stamp in one step, so a reader never sees half of it. */
function writeClaim(stamp, owner) {
  try {
    const tmp = `${stamp}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(owner));
    renameSync(tmp, stamp);
  } catch {
    /* It still names this process, which is gone soon: the next claim breaks it. */
  }
}

/**
 * Take the runtime lock — the `.installing` stamp `eklavya install` and the
 * updater take too — and return its token, or null. The session's hooks and
 * its server start within milliseconds of each other, so a stat followed by a
 * write lets several through: creating with `wx` is the one step only one
 * process can win.
 *
 * A stamp is broken only when it is not a live claim — its pid is dead, or it
 * is past the hour — and, for the heal alone, only once it is an hour old: the
 * stamp a finished or failed heal leaves behind is also what keeps a broken
 * npm from being retried on every hook. Breaking is a rename (one winner), and
 * a fresh claim renamed by mistake is put back with `link`, which never
 * overwrites.
 */
function claimHeal(stamp) {
  const token = randomUUID();
  const create = () => {
    try {
      writeFileSync(stamp, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), { flag: 'wx' });
      return token;
    } catch {
      return null;
    }
  };
  if (create()) return token;
  const taken = `${stamp}.${process.pid}.${token}`;
  try {
    const judged = readFileSync(stamp, 'utf8');
    if (liveClaim(stamp, judged) || Date.now() - statSync(stamp).mtimeMs < HEAL_EVERY_MS) return null;
    renameSync(stamp, taken);
    if (readFileSync(taken, 'utf8') !== judged) {
      try {
        linkSync(taken, stamp);
      } catch {
        /* someone else holds it now; theirs stands */
      }
      rmSync(taken, { force: true });
      return null;
    }
    rmSync(taken, { force: true });
  } catch {
    // Cannot even read or move the stamp, so we cannot bound the retries.
    // Doing nothing is the safe failure: the explicit installer still works.
    rmSync(taken, { force: true });
    return null;
  }
  return create();
}

async function main() {
  if (!name) process.exit(0);
  // Eklavya's own `claude -p` summariser sets this. Its hooks, and any server
  // it might start, must do nothing at all: in one incident they ran anyway and
  // every helper's seam launched another worker. Checked before any import, so
  // not even a stale runtime can act on it. Mirrors `OBSERVER_ENV` in the
  // runtime's reservation module.
  if (process.env.EKLAVYA_INTERNAL_OBSERVER) process.exit(0);

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
    // Before the import: a server never returns from it, and the heal is a
    // detached spawn that costs this run nothing.
    healIfBehind(entry);
    await import(pathToFileURL(entry).href);
    return;
  }

  if (name === 'server') {
    // No runtime yet: fetch it on demand so `/plugin install` alone gives a
    // working server. stdout is the MCP transport, so npx's chatter must not
    // land there.
    const version = pinnedVersion();
    if (!version) process.exit(0);
    //
    // A release pushes the bumped plugin.json before `npm publish` finishes
    // (semantic-release commits in its prepare step and publishes after), so a
    // marketplace pull can pin a version npm does not have for a minute or so.
    // Only that failure — npm saying the version does not exist — retries with
    // `latest`; a server that started and then failed is not restarted.
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const serve = (spec, retry) => {
      const child = spawn(npx, ['--yes', `eklavya@${spec}`, 'serve'], {
        stdio: ['inherit', 'inherit', 'pipe'],
        shell: process.platform === 'win32',
      });
      let errText = '';
      // Kept draining past the cap, or a chatty server would block on stderr.
      child.stderr.on('data', (chunk) => {
        if (errText.length < 64 * 1024) errText += chunk;
      });
      child.on('error', () => process.exit(0));
      child.on('exit', (code) => {
        if (code && retry && /E404|ETARGET|No matching version/i.test(errText)) serve('latest', false);
        else process.exit(code ?? 0);
      });
    };
    serve(version, true);
    return;
  }

  // A hook with no runtime has nothing to say. Start the heal and get out of
  // the way — the next session will have it.
  healInBackground();
  process.exit(0);
}

main().catch(() => process.exit(0));
