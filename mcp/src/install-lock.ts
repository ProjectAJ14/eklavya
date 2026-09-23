/**
 * The one lock on the runtime directory: `<runtime>/.installing`.
 *
 * Three things run npm into `~/.eklavya/runtime` — `eklavya install`, the
 * auto-updater (`update.ts`) and the launcher's background heal
 * (`hooks/run.mjs`) — and two npm installs landing in one prefix at once leave
 * a half-written `node_modules`. They all take this stamp first. `run.mjs`
 * cannot import this file (it has to work before any runtime exists), so it
 * carries a copy of the same rules; keep the two in step.
 *
 * The stamp names its owner: `{"pid", "token", "at"}`. The pid is who is
 * working — this process for the installer and the updater, the detached npm
 * for the launcher — and the token is what makes a claim this run's own, so a
 * release never removes a claim somebody else took over. Two older formats are
 * still read, because a runtime from before this file may be the one holding
 * the lock: a bare pid (the old updater and installer) and a bare date (the old
 * launcher, whose npm is detached and never recorded).
 *
 *   - Taking it is an exclusive create (`wx`): only one process can win.
 *   - A claim is live while its pid is alive, and for no longer than
 *     `LOCK_TTL_MS` whatever the pid says — a pid is reused eventually. A
 *     date-only stamp is live for `LEGACY_DATE_MS`, about as long as its npm
 *     plausibly ran.
 *   - A claim that is not live is broken by renaming it away, which only one
 *     process can do to a given file, and only if what was renamed is the
 *     claim that was judged. A fresh claim that landed in between is put back
 *     with `link`, which never overwrites.
 *   - Release removes the stamp only when it still carries this run's token.
 *
 * ponytail: the lock is advisory and file-based, not an OS lock. Two gaps
 * remain, both needing a claim to go stale while its owner is still working:
 * an owner running past `LOCK_TTL_MS` can be broken and overlapped, and a
 * three-way race inside one rename-and-link window can lose the put-back.
 * `flock`-style locking would close both; Node has no portable one.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Past this, no claim is live, whatever its pid says. Shared with `hooks/run.mjs`. */
export const LOCK_TTL_MS = 60 * 60 * 1000;
/** A date-only stamp (the old launcher's) is live this long. */
export const LEGACY_DATE_MS = 10 * 60 * 1000;

export interface InstallClaim {
  stamp: string;
  token: string;
}

interface Owner {
  pid: number | null;
  token: string | null;
}

export function lockPath(dir: string): string {
  return path.join(dir, '.installing');
}

function parse(text: string): Owner {
  const body = text.trim();
  if (/^\d+$/.test(body)) return { pid: Number(body), token: null };
  try {
    const value = JSON.parse(body) as { pid?: unknown; token?: unknown };
    return {
      pid: typeof value.pid === 'number' ? value.pid : null,
      token: typeof value.token === 'string' ? value.token : null,
    };
  } catch {
    return { pid: null, token: null };
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Is the stamp at `file`, whose contents are `text`, somebody's live claim? Throws if it is gone. */
function live(file: string, text: string): boolean {
  const age = Date.now() - fs.statSync(file).mtimeMs;
  if (age >= LOCK_TTL_MS) return false;
  const { pid } = parse(text);
  return pid !== null ? alive(pid) : age < LEGACY_DATE_MS;
}

/** The pid holding a live claim on `dir`, for a message; null when nobody provably does. */
export function installHolder(dir: string): number | null {
  try {
    const text = fs.readFileSync(lockPath(dir), 'utf8');
    return live(lockPath(dir), text) ? parse(text).pid : null;
  } catch {
    return null;
  }
}

/**
 * Takes the lock on `dir`, or returns null when someone holds it (or when the
 * stamp cannot even be read, since then it cannot be judged). `beforeTake` is
 * for tests: it runs between judging a claim stale and taking it.
 */
export function claimInstall(dir: string, opts: { beforeTake?: () => void } = {}): InstallClaim | null {
  const stamp = lockPath(dir);
  const token = crypto.randomUUID();
  const create = (): InstallClaim | null => {
    try {
      fs.writeFileSync(stamp, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), { flag: 'wx' });
      return { stamp, token };
    } catch {
      return null;
    }
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const first = create();
  if (first) return first;

  const taken = `${stamp}.${process.pid}.${token}`;
  try {
    const judged = fs.readFileSync(stamp, 'utf8');
    if (live(stamp, judged)) return null;
    opts.beforeTake?.();
    fs.renameSync(stamp, taken);
    if (fs.readFileSync(taken, 'utf8') !== judged) {
      // Not the claim that was judged: somebody's fresh one. Put it back
      // without overwriting whatever may have been created since.
      try {
        fs.linkSync(taken, stamp);
      } catch {
        /* see the ponytail note above */
      }
      fs.rmSync(taken, { force: true });
      return null;
    }
    fs.rmSync(taken, { force: true });
  } catch (err) {
    // Gone between the create and the read: free now, so try once more.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(taken)) return create();
    fs.rmSync(taken, { force: true });
    return null;
  }
  return create();
}

/** Gives the lock back — only if the stamp is still this claim's. Never throws. */
export function releaseInstall(claim: InstallClaim): void {
  try {
    if (parse(fs.readFileSync(claim.stamp, 'utf8')).token === claim.token) fs.rmSync(claim.stamp, { force: true });
  } catch {
    /* already gone, or unreadable: either way not ours to remove */
  }
}
