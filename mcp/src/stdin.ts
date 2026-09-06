/**
 * Reading stdin without ever waiting forever.
 *
 * A hook that throws exits, and the session carries on. A hook that *waits*
 * blocks the session on every tool call that triggers it, with no error and
 * nothing to report -- which is far worse, and it is reachable: ponytail hit it
 * on Windows, where Claude Code may run a hook through a PowerShell `if {}`
 * wrapper that swallows the piped JSON, so `end` never fires (ponytail #443).
 * `run.mjs` is careful about everything else -- Node version, four resolution
 * candidates, exit 0 on every throw -- and this was the one gap.
 *
 * Shared between the hooks and `eklavya statusline` deliberately. Both read a
 * JSON blob the host pipes in, both must degrade rather than hang, and two
 * copies of this is one copy getting the fix.
 *
 * **The bound is on silence, not on total time**, which is where this differs
 * from the version it is modelled on. A flat one-second cap truncates a payload
 * still arriving at one second, and truncated JSON does not fail loudly -- it
 * fails as `{}`, so the hook runs to completion having quietly decided the
 * session has no cwd and no id. Resetting the timer on every chunk means a slow
 * or large payload is never cut off, while a stream that stalls still resolves.
 * A total cap sits behind it for the case where data keeps arriving forever.
 */

export interface StdinBounds {
  /** Give up after this long with no data arriving at all. */
  idleMs: number;
  /** And give up regardless after this long, however chatty the stream is. */
  totalMs: number;
}

/**
 * Hooks are given 10 seconds by `hooks.json` (15 for Stop), so these sit well
 * under the smallest of them: a hook that hits its host timeout is a hook the
 * developer waits on.
 */
export const HOOK_STDIN: StdinBounds = { idleMs: 2000, totalMs: 5000 };

/**
 * The status bar refreshes on the host's cadence, so its budget is a fraction
 * of a hook's -- a bar that blocks is a bar the developer feels on every
 * refresh, and printing the dials from `process.cwd()` is a fine fallback.
 */
export const STATUSLINE_STDIN: StdinBounds = { idleMs: 250, totalMs: 1000 };

/**
 * Everything the host wrote, or as much as arrived before it went quiet.
 *
 * Never rejects. A caller that cannot read its input has a fallback -- an empty
 * object, or the working directory -- and an exception here would defeat the
 * point of bounding the read in the first place.
 */
export function readStdinBounded(bounds: StdinBounds = HOOK_STDIN): Promise<string> {
  return new Promise((resolve) => {
    // No pipe attached: a hook invoked by hand from a terminal. Waiting for a
    // human to type JSON and press ctrl-D is the hang this file is about.
    if (process.stdin.isTTY) return resolve('');

    let buffer = '';
    let settled = false;
    let idle: NodeJS.Timeout | undefined;

    const done = (): void => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      clearTimeout(total);
      // Listeners removed so a late chunk cannot resolve a promise twice or
      // hold the process open after the caller has moved on.
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', done);
      process.stdin.removeListener('error', done);
      resolve(buffer);
    };

    const bumpIdle = (): void => {
      if (idle) clearTimeout(idle);
      // `unref` keeps every timer off the normal path: when `end` arrives first
      // -- which is almost always -- a pending timer must not hold the process
      // open or add latency to a hook that has already finished its work.
      idle = setTimeout(done, bounds.idleMs);
      idle.unref();
    };

    const onData = (chunk: string): void => {
      buffer += chunk;
      bumpIdle();
    };

    const total = setTimeout(done, bounds.totalMs);
    total.unref();

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', done);
    // The handler ponytail's comment is about. Without it a stream that errors
    // never emits `end`, and the read waits on something that will not arrive.
    process.stdin.on('error', done);
    bumpIdle();
  });
}

/**
 * Strip a byte-order mark before `JSON.parse`.
 *
 * Some Windows shells prepend one, and `JSON.parse` throws on input that looks
 * perfectly well-formed in a terminal and in any editor.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
