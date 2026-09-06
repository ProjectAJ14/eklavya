/**
 * Reading stdin without ever waiting forever.
 *
 * A hook that throws exits, and the session carries on. A hook that *waits*
 * blocks the session on every tool call that triggers it, with no error and
 * nothing to report -- which is far worse.
 *
 * The mechanism is reported rather than reproduced here: ponytail's issue #443
 * describes Claude Code on Windows running a hook through a PowerShell `if {}`
 * wrapper that swallows the piped JSON, so `end` never fires. Nothing in this
 * repo verifies that wrapper -- there is no Windows machine in the loop -- so
 * what is defended against is the consequence, a stdin that never ends, which
 * the tests reproduce directly.
 *
 * `run.mjs` is careful about everything else -- Node version, four resolution
 * candidates, exit 0 on every throw -- and this was the one gap.
 *
 * Shared between the hooks and `eklavya statusline` deliberately. Both read a
 * JSON blob the host pipes in, both must degrade rather than hang, and two
 * copies of this is one copy getting the fix.
 *
 * **The primary bound is on silence, not on total time**, which is where this
 * differs from the version it is modelled on. A flat cap truncates a payload
 * still arriving when it fires, and truncated JSON does not fail loudly -- it
 * fails as `{}`, so the caller runs to completion having quietly decided the
 * session has no cwd and no id. Resetting the timer on every chunk buys a slow
 * payload as long as it keeps making progress.
 *
 * The total cap behind it can still truncate, and saying otherwise would be the
 * same overclaim: a stream that dribbles forever is cut at `totalMs` and hits
 * exactly the failure above. That is a deliberate trade rather than an absence
 * of one -- an unbounded read is worse -- and it is why `totalMs` is generous
 * against how long any real payload takes to arrive.
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
 *
 * The cost is worth stating plainly rather than selling this as pure upside. On
 * a host that swallows the pipe it turns an infinite hang into `idleMs` per
 * invocation -- and PreToolUse matches every `Bash` call, so that is +2s per
 * command until the host is fixed. Two seconds a command is bad; a frozen
 * session is worse.
 */
export const HOOK_STDIN: StdinBounds = { idleMs: 2000, totalMs: 5000 };

/**
 * The status bar refreshes on the host's cadence, so its budget is a fraction
 * of a hook's -- a bar that blocks is a bar the developer feels on every
 * refresh, and printing the dials from `process.cwd()` is a fine fallback.
 *
 * `totalMs` is tight rather than a multiple of `idleMs`. The blob a status bar
 * receives is a few hundred bytes, so it never needs the room a hook's payload
 * might -- and the inline reader this replaced was a flat 250ms cap, which a
 * 1000ms total quietly made four times worse for the one caller whose latency a
 * human actually sees.
 */
export const STATUSLINE_STDIN: StdinBounds = { idleMs: 150, totalMs: 250 };

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
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', done);
      process.stdin.removeListener('error', done);

      // Removing the listeners is not enough, and this is the line that makes
      // the rest of the file true. `setEncoding` put the stream in flowing
      // mode, and a flowing stdin holds an active libuv handle -- so the read
      // resolves, the caller prints its answer, and the process then sits there
      // waiting for an EOF that is never coming.
      //
      // The hooks hid it, because `run()` ends in `process.exit`. `eklavya
      // statusline` does not, so under exactly the condition this file exists
      // for it printed the dials at 300ms and then left an orphaned node
      // process behind on every status-bar refresh.
      process.stdin.pause();
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
