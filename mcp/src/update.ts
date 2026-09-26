/**
 * The auto-updater: Eklavya keeps itself current the way Claude Code does —
 * a background check at session start, an install nobody waits on, one line
 * when it worked, and one line naming the fix when it did not.
 *
 * What moves, and how:
 *
 *   - The runtime (`~/.eklavya/runtime`) is the only thing npm installs. It is
 *     under the user's home, so an update never needs sudo — which is why the
 *     global `eklavya` command is not updated at all: `cli.ts` hands off to the
 *     runtime whenever the runtime is newer, so a stale global binary runs new
 *     code without anyone touching npm.
 *   - Everything else `eklavya install` sets up — the plugin files, the chat
 *     skill, the registration, the status line — is refreshed by running the
 *     NEW runtime's own `install --auto`. One code path for a manual install and
 *     an automatic one, so an update can never do less than an install would.
 *     `--auto` never asks a question and never changes a setting.
 *
 * `update.json` beside the database is the whole state: when it last checked,
 * which version `install` last finished for, and the last failure. The
 * SessionStart hook reads it to decide whether to start a run and what to say;
 * `eklavya doctor` reads it to report.
 *
 * Deliberately light on imports: the SessionStart hook loads this module on
 * every session, and only `runUpdate` (in its own background process) spawns
 * anything slow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { spawnDashboard, stopDashboard } from './dashboard-daemon.js';
import { eklavyaHome } from './paths.js';
import { loadGlobalConfig } from './config.js';
import { claimInstall, releaseInstall } from './install-lock.js';

/** How often the background check runs, at most. Every session would ask npm otherwise. */
export const CHECK_EVERY_MS = 60 * 60 * 1000;
/** Offline is not a failure worth a line — until it has lasted this long. */
export const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface UpdateState {
  /** Last attempt, successful or not. The throttle. */
  checked_at?: string;
  /** Last time the whole run succeeded. */
  ok_at?: string;
  /** The newest version npm reported. */
  latest?: string;
  /** The runtime version `eklavya install` last finished for. */
  applied?: string;
  /** The version the "updated" line has been shown for. */
  announced?: string;
  /** One line, for the developer; null once a run succeeds. */
  error?: string | null;
  /** `network` is the one class that is not reported straight away. */
  error_class?: 'network' | 'npm' | 'install' | null;
}

export function statePath(): string {
  return path.join(eklavyaHome(), 'update.json');
}

export function logPath(): string {
  return path.join(eklavyaHome(), 'update.log');
}

/** The runtime this updater owns. Never an `EKLAVYA_RUNTIME` build: that one is pinned on purpose. */
function runtimeDir(): string {
  return path.join(eklavyaHome(), 'runtime');
}

export function runtimeCli(): string {
  return path.join(runtimeDir(), 'node_modules', 'eklavya', 'dist', 'cli.js');
}

export function runtimeVersion(): string | null {
  try {
    const pkg = path.join(runtimeDir(), 'node_modules', 'eklavya', 'package.json');
    return (JSON.parse(fs.readFileSync(pkg, 'utf8')).version as string) ?? null;
  } catch {
    return null;
  }
}

export function readState(): UpdateState {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return value && typeof value === 'object' ? (value as UpdateState) : {};
  } catch {
    return {};
  }
}

/** Merges `patch` in. Never throws: losing a state write costs one extra check, not a session. */
export function writeState(patch: UpdateState): void {
  try {
    fs.mkdirSync(eklavyaHome(), { recursive: true });
    const tmp = `${statePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ ...readState(), ...patch }, null, 2)}\n`);
    fs.renameSync(tmp, statePath());
  } catch {
    /* see above */
  }
}

/** `auto_update`, from the global file only: a project cannot opt the machine out. */
export function autoUpdateEnabled(): boolean {
  return loadGlobalConfig().auto_update;
}

/** -1, 0 or 1 over the numeric parts of two versions; a prerelease tag is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0]!.split('.').map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/**
 * Should a session start a background run? Only for an installed runtime (a
 * missing one is `run.mjs`'s heal), never under `EKLAVYA_RUNTIME`, and only
 * when the last check is an hour old — or when the runtime moved without
 * `install` following it, which is what the pinned heal in `run.mjs` does.
 */
export function updateDue(now = Date.now()): boolean {
  if (process.env.EKLAVYA_RUNTIME || !autoUpdateEnabled()) return false;
  const installed = runtimeVersion();
  if (!installed) return false;
  const state = readState();
  const recent = now - (state.checked_at ? Date.parse(state.checked_at) : NaN) < CHECK_EVERY_MS;
  // A failure waits out the hour too: a broken npm retried every session is
  // a spawn per session for nothing.
  return !recent || (state.applied !== installed && !state.error);
}

/**
 * Starts `eklavya update --background` from the runtime, detached, when one is
 * due. Returns at once; every failure is swallowed — the caller is a hook.
 */
export function startBackgroundUpdate(): void {
  try {
    if (!updateDue()) return;
    fs.mkdirSync(eklavyaHome(), { recursive: true });
    // stdio ignored: the run writes its own log, and only once it holds the
    // claim, so a run that finds another in progress cannot wipe that log.
    const child = spawn(process.execPath, [runtimeCli(), 'update', '--background'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // An async spawn failure lands here, after this hook has moved on. Without
    // a listener it is an uncaught error and the hook exits 1.
    child.on('error', () => {});
    child.unref();
  } catch {
    /* an update that cannot start is retried next session */
  }
}

/**
 * The one line a session shows about updates, or null. "Updated" once per
 * version; a failure every session until it clears, like Claude Code's own —
 * except being offline, which says nothing until it has lasted a week.
 *
 * `announces` is set on the "updated" line: the caller passes it to
 * `markAnnounced` once the line has actually gone out, so a session that
 * returns early does not swallow it.
 */
export function updateNotice(now = Date.now()): { text: string; announces?: string } | null {
  const state = readState();
  if (state.error) {
    const lastOk = state.ok_at ? Date.parse(state.ok_at) : NaN;
    const longOffline = !(now - lastOk < OFFLINE_GRACE_MS);
    if (state.error_class !== 'network' || longOffline) {
      return { text: `Eklavya can't update itself · ${state.error} · run: eklavya update` };
    }
  }
  const version = state.applied;
  if (version && version !== state.announced && version === runtimeVersion()) {
    return { text: `Eklavya updated to ${version}`, announces: version };
  }
  return null;
}

export function markAnnounced(version: string): void {
  writeState({ announced: version });
}

// --- the run ----------------------------------------------------------------

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd: string, args: string[], timeout: number) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    shell: process.platform === 'win32',
    windowsHide: true,
  });
}

/**
 * The line of a failed command that says why: a Node `…Error:` line, else an
 * npm error code (`EACCES`, `ENOTFOUND`), else the last line that is not Node's
 * `Node.js v…` trailer.
 */
function lastLine(text: string | undefined): string {
  const lines = (text ?? '').split('\n').map((l) => l.replace(/^npm (ERR!|error)\s*/, '').trim()).filter(Boolean);
  const why =
    lines.find((l) => /^[A-Za-z]*Error:/.test(l)) ??
    lines.find((l) => /\bE[A-Z]{3,}\b/.test(l)) ??
    lines.filter((l) => !/^Node\.js v/.test(l)).at(-1);
  return (why ?? 'unknown error').slice(0, 160);
}

const NETWORK = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|network|socket hang up/i;

class UpdateError extends Error {
  constructor(
    message: string,
    readonly cls: 'network' | 'npm' | 'install',
  ) {
    super(message);
  }
}

export type UpdateResult =
  | { status: 'updated'; from: string | null; to: string }
  | { status: 'current'; version: string }
  | { status: 'busy' }
  | { status: 'skipped' }
  | { status: 'failed'; error: string };

/**
 * One update run: ask npm for the latest version, install it into the runtime
 * if it is newer, then let the runtime's own `install --auto` refresh
 * everything else. `say` is where progress goes — nowhere in the background.
 */
export async function runUpdate(opts: { background: boolean; say?: (line: string) => void }): Promise<UpdateResult> {
  if (opts.background && !updateDue()) return { status: 'skipped' };
  // The runtime lock `installRuntime` and the launcher's heal take too
  // (`install-lock.ts`). The new runtime's `install --auto` below skips the
  // runtime step, so it never asks for the lock this run is holding.
  const claim = claimInstall(runtimeDir());
  if (!claim) return { status: 'busy' };
  // The background run's log is this run's alone: truncated here, after the claim.
  const log = (text: string) => {
    if (!opts.background) return;
    try {
      fs.appendFileSync(logPath(), text);
    } catch {
      /* a log is a courtesy */
    }
  };
  if (opts.background) {
    try {
      fs.writeFileSync(logPath(), `${new Date().toISOString()} eklavya update\n`);
    } catch {
      /* see above */
    }
  }
  const say = (line: string) => {
    log(`${line}\n`);
    opts.say?.(line);
  };
  const now = new Date().toISOString();
  const from = runtimeVersion();
  try {
    const view = run(npm, ['view', 'eklavya@latest', 'version'], 60_000);
    if (view.error || view.status !== 0) {
      const why = view.error?.message ?? lastLine(view.stderr);
      throw new UpdateError(
        (view.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? 'npm not found on PATH' : `npm view failed: ${why}`,
        NETWORK.test(why) ? 'network' : 'npm',
      );
    }
    const latest = view.stdout.trim();
    // Anything else is npm talking (a warning on stdout, an .npmrc notice), and
    // installing `eklavya@<that>` would fail in a way that names the wrong thing.
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(latest)) {
      throw new UpdateError(`npm view returned no version: ${lastLine(latest || view.stderr)}`, 'npm');
    }
    say(`latest ${latest}, runtime ${from ?? 'not installed'}`);

    let restart = false;
    if (!from || compareVersions(latest, from) > 0) {
      // A running dashboard holds the SQLite driver open, and Windows will not
      // let npm replace a loaded file. Stopped first, restarted on the new code.
      restart = await stopDashboard();
      say(`installing eklavya@${latest}…`);
      const install = run(
        npm,
        ['install', `eklavya@${latest}`, '--prefix', runtimeDir(), '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
        10 * 60_000,
      );
      if (install.error || install.status !== 0) {
        const why = install.error?.message ?? lastLine(install.stderr);
        throw new UpdateError(`npm install failed: ${why}`, NETWORK.test(why) ? 'network' : 'npm');
      }
    }

    const version = runtimeVersion();
    if (!version) throw new UpdateError('the runtime is missing after npm install', 'npm');

    // The new runtime's install, so the plugin files, skill and registration
    // match the code that will run them. Skipped when it already finished for
    // this version: an hourly re-registration would rewrite Claude Code's files
    // for nothing.
    if (readState().applied !== version) {
      say(`refreshing the plugin, skill and registration for ${version}…`);
      const refresh = run(process.execPath, [runtimeCli(), 'install', '--auto'], 5 * 60_000);
      log(`${refresh.stdout ?? ''}${refresh.stderr ?? ''}`);
      if (refresh.error || refresh.status !== 0) {
        throw new UpdateError(`eklavya install failed: ${lastLine(refresh.stderr || refresh.stdout)}`, 'install');
      }
    }

    if (restart) spawnDashboard(runtimeCli());
    writeState({ checked_at: now, ok_at: now, latest, applied: version, error: null, error_class: null });
    return from === version ? { status: 'current', version } : { status: 'updated', from, to: version };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`failed: ${error}\n`);
    writeState({ checked_at: now, error, error_class: err instanceof UpdateError ? err.cls : 'install' });
    return { status: 'failed', error };
  } finally {
    releaseInstall(claim);
  }
}
