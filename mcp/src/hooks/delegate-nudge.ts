/**
 * PostToolUse (edit tools, Bash and Agent): the moment a change turns out to
 * span files, say "delegate the rest" -- once, and never after the parent has
 * already delegated.
 *
 * The session-start `DELEGATE` block asks for the same thing, and in eleven live
 * sessions on 1.40 it was followed zero times: changes of 8, 10 and 12 edits all
 * ran in the main conversation. It arrives before the task exists, and by the
 * time the model decides how to build, it is far back in context. So this is the
 * same instruction, moved to where it applies: the main thread has just changed
 * a second distinct file, which is what "a change across several files" looks
 * like from the outside. The prompt hook says it first, next to the task
 * (`prompt-submit-nudge.ts`); this is the recovery for a session that started
 * building inline anyway.
 *
 * Two ways a file counts as changed:
 * - an edit tool wrote it (its path, from the tool input);
 * - after a Bash call, git lists it with an mtime inside that command's own
 *   window: from `duration_ms` (plus a margin for the hook starting) before now.
 *   Agents edit through heredocs and `sed -i` as often as through Edit -- a
 *   39-call session made no Edit at all. Reading the window rather than diffing
 *   snapshots means the first command in a tree counts, and a file someone else
 *   changed between this session's commands -- a background builder, another
 *   chat in the same worktree, an editor -- does not. A host that sends no
 *   `duration_ms` gets the window since this session's previous Bash call.
 *   The trees read are the session's own, the one a leading `cd <dir> &&`
 *   names, and the last tree such a `cd` named: a session started in the main
 *   checkout that works in a sibling worktree edits only there, its cwd never
 *   moves, and after one `cd` it reaches the same tree by `git -C` and
 *   absolute paths too.
 *
 * And one way to stand down for good: the parent starts an agent that is not a
 * read-only researcher. From then on its edits are reviews and fixes around a
 * delegation that already happened, and git in the worktree is moving because
 * the builder is working -- the nudge firing there would ask for a second
 * builder on top of the first.
 *
 * PostToolUse rather than PreToolUse: a failed edit never gets here, so only an
 * edit that happened counts, and the nudge lands after the tool result the model
 * reads next either way.
 *
 * Small and silent, like every hook:
 * - Parent only. A delegate's edits are the delegation working, and a subagent
 *   cannot start the background agents or ask the questions this asks for.
 * - Only while questions are on and `delegate_work` is true -- the same switch
 *   session-start reads for `DELEGATE`.
 * - Once per session, keyed by the session id, so a resume or a compaction keeps
 *   it and another chat in the same project has its own. The state is read
 *   first, so after the nudge or a delegation a Bash call costs no git. No
 *   inference; fails open.
 */
import fs from 'node:fs';
import path from 'node:path';
import { run, openExisting, config, cwdOf, sessionId } from './lib.js';
import { git, leadingCd, noteBuilder } from './changes-lib.js';
import { DELEGATE_KEY_PREFIX, nudge as nudgeText } from './delegation-lib.js';

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const AGENT_TOOLS = /^(Agent|Task)$/;
/** Agents that only read: starting one is research, not handing off the build. */
const READ_ONLY_AGENTS = /^(Explore|Plan|claude-code-guide)$|eklavya-(tutor|explainer)/;
/** More dirty entries than this and the Bash read is skipped: the signal is noise. */
const MAX_ENTRIES = 2000;
/** From the command finishing to this hook reading the clock: a node start, under load. */
const WINDOW_MARGIN_MS = 3000;


interface State {
  /** The first changed file, once one is known. */
  first?: string;
  /** The tree the last leading `cd` named. */
  tree?: string;
  /** Epoch ms of the previous Bash call: the window when the host sends no duration. */
  bashAt?: number;
  /** The nudge was emitted. */
  done?: boolean;
  /** When the parent started a building agent, and whether in the background. */
  delegated?: string;
  background?: boolean;
}

/** The same file under every spelling: a symlinked temp dir, `./a.ts`, `a.ts`. */
function canonical(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** The repository root `dir` sits in, or null. */
function rootOf(dir: string): string | null {
  return git(dir, ['rev-parse', '--show-toplevel'])?.trim() || null;
}

/** Every file `git status` reports under `root` whose mtime is at or after `since`; null on failure. */
function changedSince(root: string, since: number): string[] | null {
  const status = git(root, ['status', '--porcelain=v1', '-z', '-uall']);
  if (status === null) return null;
  const entries = status.split('\0');
  if (entries.length > MAX_ENTRIES) return null;
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    // `R` and `C` entries carry the source path as the next NUL field.
    if (entry[0] === 'R' || entry[0] === 'C') i++;
    const file = canonical(path.join(root, entry.slice(3)));
    try {
      if (fs.statSync(file).mtimeMs >= since) out.push(file);
    } catch {
      /* Deleted: no mtime to say when. */
    }
  }
  return out;
}

await run(async (input) => {
  const tool = input.tool_name ?? '';
  const isBash = tool === 'Bash';
  const isAgent = AGENT_TOOLS.test(tool);
  if (input.agent_id || !(isBash || isAgent || EDIT_TOOLS.test(tool))) return 0;
  const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (EDIT_TOOLS.test(tool) && (typeof raw !== 'string' || !raw)) return 0;
  if (isAgent && READ_ONLY_AGENTS.test(String(input.tool_input?.subagent_type ?? ''))) return 0;

  const cwd = cwdOf(input);
  const { quiz, delegate_work, cadence } = config(cwd).config;
  if (!quiz.enabled || !delegate_work) return 0;

  const db = openExisting();
  if (!db) return 0;
  const sid = sessionId(input, db);
  if (!sid) return 0;

  const key = `${DELEGATE_KEY_PREFIX}${sid}`;
  // Value: `<iso date>|<json State>`. The date prefix is what the prune reads,
  // the same way `noteEdit` ages its marks.
  const read = (): State => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return {};
    try {
      return JSON.parse(row.value.slice(row.value.indexOf('|') + 1)) as State;
    } catch {
      return {};
    }
  };
  const before = read();
  // After the nudge an edit or a Bash call has nothing left to do, but an agent
  // starting is the nudge being followed, and is recorded.
  if (before.delegated || (before.done && !isAgent)) return 0;

  // Outside the lock: git can take a moment, and nothing here needs the row.
  const now = Date.now();
  let changed: string[] = [];
  let tree: string | undefined;
  if (isBash) {
    const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
    const target = leadingCd(command, cwd);
    tree = (target && rootOf(target)) || before.tree;
    const duration = input.duration_ms;
    const since = typeof duration === 'number' && duration >= 0 ? now - duration - WINDOW_MARGIN_MS : before.bashAt;
    if (since !== undefined) {
      const roots = new Set([rootOf(cwd), tree].filter((r): r is string => Boolean(r)));
      for (const root of roots) changed.push(...(changedSince(root, since) ?? []));
    }
  } else if (!isAgent) {
    changed = [canonical(path.resolve(cwd, raw as string))];
  }

  const nudge = db
    .transaction(() => {
      db.prepare(`DELETE FROM meta WHERE key LIKE ? AND substr(value, 1, 10) < date('now', '-7 day')`).run(
        `${DELEGATE_KEY_PREFIX}%`,
      );
      const state = read();
      /* c8 ignore next -- another hook finished while this one ran git */
      if (state.delegated || (state.done && !isAgent)) return false;
      if (isAgent) {
        state.delegated = new Date(now).toISOString();
        // The host can run an agent in the background without being asked to:
        // its launch result says so (2.1.286 sessions omitted the flag).
        const response = input.tool_response as { status?: unknown } | undefined;
        state.background = input.tool_input?.run_in_background === true || response?.status === 'async_launched';
      }
      if (isBash) {
        state.bashAt = now;
        if (tree) state.tree = tree;
      }
      const others = [...new Set(changed)].filter((f) => f !== state.first);
      if (!state.first && others.length) state.first = others.shift();
      const emit = !state.done && others.length > 0;
      if (emit) state.done = true;
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key,
        `${new Date(now).toISOString()}|${JSON.stringify(state)}`,
      );
      return emit;
    })
    .immediate();
  if (isAgent) noteBuilder(db, sid);
  if (!nudge) return 0;

  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudgeText(cadence) } })}\n`,
  );
  return 0;
});
