/**
 * Shared helpers for the Eklavya hooks.
 *
 * These used to be `hooks/lib.sh`, and the port was not cosmetic. Hook commands
 * run through `sh -c` on macOS and Linux but through Git Bash — or PowerShell,
 * or WSL's bash, depending on what is installed — on Windows, where `.sh` hooks
 * are a documented minefield (claude-code#18610, #21847, #23556, #73971). The
 * hooks reference names the way out: `node` plus a script path is the one form
 * that works everywhere, because `node.exe` is a real executable.
 *
 * Porting also deletes the dependency list. The shell version needed `jq`,
 * the `sqlite3` CLI and a POSIX shell on PATH before it could do anything;
 * this version needs the Node that Eklavya already requires.
 *
 * The hard rule survives the port unchanged: a hook must never break
 * a session. `run()` is the only entry point, and it swallows everything.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { dbPath } from '../paths.js';
import { loadConfig, type ResolvedConfig } from '../config.js';
import { readStdinBounded, stripBom, HOOK_STDIN } from '../stdin.js';
import { withSurfaceNote } from '../surface.js';
import { getCurrentSession } from '../session.js';
import { minutesSince, NEVER, nowIso } from '../time.js';
import { isInternalObserver } from '../memory/reservation.js';

// The clock policy moved to `time.ts` so the memory half shares it; hooks and
// tests still import these three from here.
export { minutesSince, NEVER, nowIso };

export type DB = Database.Database;

/** The JSON Claude Code writes to a hook's stdin. Fields we actually read. */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  agent_id?: string;
  agent_type?: string;
  /** `PreToolUse`/`PostToolUse`. Widened past `command` for memory capture. */
  tool_input?: { command?: string } & Record<string, unknown>;
  /** The rest are memory capture's: the host sends them, nothing read them before. */
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_response?: unknown;
  source?: string;
}

/**
 * The JSON the host piped in, or `{}`.
 *
 * Hooks are always given JSON, but "always" is doing a lot of work on a
 * critical path -- a hook invoked by hand, or by a harness version that changes
 * its mind, gets an empty object rather than an exception.
 *
 * The read is bounded (`readStdinBounded`). It used to be `for await (const
 * chunk of process.stdin)`, which waits for EOF and has no other exit: on
 * Windows the host may run a hook through a PowerShell block that swallows the
 * pipe, so `end` never fires and the hook blocks the session on every tool call
 * that triggers it. A hook that throws is survivable; a hook that waits is not.
 */
export async function readInput(): Promise<HookInput> {
  try {
    const raw = stripBom(await readStdinBounded(HOOK_STDIN));
    if (!raw.trim()) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as HookInput) : {};
  } catch {
    return {};
  }
}

/**
 * Opens the knowledge DB read-write, WITHOUT migrating or seeding it.
 *
 * `openDb()` is the server's entry point and does both, which is right for a
 * server and wrong here: a hook is not the thing that should be migrating a
 * schema, and several hooks racing a migration on session start is a corruption
 * story rather than a feature. A hook that finds no database has nothing to say,
 * which is the same answer `eklavya_have_deps` gave.
 */
export function openExisting(): DB | null {
  const file = dbPath();
  if (!fs.existsSync(file)) return null;
  try {
    const db = new Database(file);
    db.pragma('busy_timeout = 2000');
    db.pragma('foreign_keys = ON');
    return db;
  } catch {
    return null;
  }
}

/**
 * `meta` key holding the UserPromptSubmit nudge's per-session bookkeeping.
 * Shared here rather than exported from the hook, because `session-start`
 * clears it and two hooks spelling the same key differently would be a bug that
 * only shows up as a nudge that never stops.
 */
export const NUDGE_KEY_PREFIX = 'prompt_nudge:';

/**
 * Forget what the nudge knows about this session.
 *
 * Called by `session-start`, which fires on resume and after a compaction as
 * well as at startup, and reprints the standing directive every time. Without
 * this the nudge's row survives with its original first-seen stamp, the grace
 * window is already spent, and the first prompt of a resumed session restates a
 * directive printed seconds earlier.
 */
export function clearNudgeState(db: DB, sessionId: string): void {
  try {
    db.prepare('DELETE FROM meta WHERE key = ?').run(`${NUDGE_KEY_PREFIX}${sessionId}`);
  } catch {
    /* Bookkeeping. A session that keeps its old row gets one extra nudge. */
  }
}

export function config(cwd: string): ResolvedConfig {
  return loadConfig(cwd);
}

/** The cwd the hook should reason about: what the harness said, else ours. */
export function cwdOf(input: HookInput): string {
  return input.cwd && input.cwd.length > 0 ? input.cwd : process.cwd();
}

/**
 * The session id every hook and MCP tool must agree on.
 *
 * `EKLAVYA_SESSION_ID` wins when set, so two panes sharing one task (see
 * docs/parallel-tutoring.md) agree on an id even though Claude Code gives each
 * pane its own. Unset in normal use, where the harness id is authoritative. The
 * `meta` fallback is for hooks the harness did not hand an id to.
 */
export function sessionId(input: HookInput, db: DB | null): string | null {
  const fromEnv = process.env.EKLAVYA_SESSION_ID;
  if (fromEnv) return fromEnv;
  if (input.session_id) return input.session_id;
  if (!db) return null;
  try {
    // This checkout's pointer, not the global one: another repo's live session
    // is the wrong answer here for the same reason it is wrong in the tools.
    return getCurrentSession(db, cwdOf(input));
  } catch {
    return null;
  }
}

/**
 * The focus framing, stated by the hooks rather than left to the tutor skill.
 *
 * The skill is model-invoked: it competes with every other skill on the machine
 * and may never load. Without this line an ambient session teaches whatever the
 * default is rather than what the developer configured.
 *
 * Every branch below is written in code — "the diff", "a different codebase" —
 * because on the two Claude Code surfaces that is what there is. On Cowork
 * there is not, so the surface note is appended rather than the strings being
 * restated; `surface.ts` says why.
 */
export function framingFor(
  focus: string,
  topic: string | null | undefined,
  where: 'checkpoint' | 'stop',
): string {
  return withSurfaceNote(focusFraming(focus, topic, where), ' ');
}

function focusFraming(
  focus: string,
  topic: string | null | undefined,
  where: 'checkpoint' | 'stop',
): string {
  if (focus === 'concept') {
    return where === 'checkpoint'
      ? "Focus is 'concept': open from the code you just wrote, then ask for the general rule -- the answer must be usable on a different codebase."
      : "Focus is 'concept': ask the transferable version. Open from the code just written, then ask for the general rule or the class of problem — the answer must be usable on a different codebase.";
  }
  if (focus === 'learn') {
    if (!topic) {
      return where === 'checkpoint'
        ? "Focus is 'learn' but no focus_topic is set. Skip the question and say so."
        : "Focus is 'learn' but no focus_topic is set. Ask what they want to learn and set it before quizzing.";
    }
    return where === 'checkpoint'
      ? `Focus is 'learn' on "${topic}": ask the next thing in that topic. Use the code you just wrote as the worked example only where it genuinely overlaps.`
      : `Focus is 'learn' on "${topic}": teach that topic in prerequisite order. Where the plan marks bridge_context, this session's code is your worked example; otherwise teach it on its own terms.`;
  }
  return where === 'checkpoint'
    ? "Focus is 'project': ground the question in the code you just wrote -- the file, the line, the decision."
    : "Focus is 'project': ground every question in the diff just written — the file, the line, the decision.";
}

/**
 * Runs a hook body and guarantees the session survives it.
 *
 * Every failure path exits 0 with no output — a missed question is nothing, a
 * hook that errors on every tool call is a plugin nobody keeps. Every hook here
 * exits 0 and speaks through JSON on stdout, the Stop sweep included; anything
 * thrown still lands here and still exits 0.
 */
export async function run(body: (input: HookInput) => Promise<number | void>): Promise<void> {
  // Inside Eklavya's own `claude -p` summariser, every hook is inert: no
  // capture, no database, no worker, no context. `run.mjs` checks too; this is
  // the copy a directly invoked `dist/hooks/*.js` cannot skip.
  if (isInternalObserver()) process.exit(0);
  let code = 0;
  try {
    const input = await readInput();
    code = (await body(input)) ?? 0;
  } catch {
    code = 0;
  }
  process.exit(code);
}
