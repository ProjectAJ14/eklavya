/**
 * PostToolUse (edit tools and Bash): the moment a change turns out to span
 * files, say "delegate the rest" -- once.
 *
 * The session-start `DELEGATE` block asks for the same thing, and in eleven live
 * sessions on 1.40 it was followed zero times: changes of 8, 10 and 12 edits all
 * ran in the main conversation. It arrives before the task exists, and by the
 * time the model decides how to build, it is far back in context. The Stop
 * sweep, which arrives exactly when it applies, was followed every time. So this
 * is the same instruction, moved to where it applies: the main thread has just
 * changed a second distinct file, which is what "a change across several files"
 * looks like from the outside.
 *
 * Two ways a file counts as changed:
 * - an edit tool wrote it (its path, from the tool input);
 * - after a Bash call, git lists it with a size or mtime that differs from the
 *   snapshot the previous Bash call left. Agents edit through heredocs and
 *   `sed -i` as often as through Edit -- a 39-call session made no Edit at all.
 *   Files already dirty at the first snapshot count only if they move again.
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
 * - Once per session. The state is read first, so after the nudge a Bash call
 *   costs no git. No inference; fails open.
 */
import fs from 'node:fs';
import path from 'node:path';
import { run, openExisting, config, cwdOf, sessionId } from './lib.js';
import { git } from './changes-lib.js';

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const KEY_PREFIX = 'delegate_nudge:';
/** More dirty entries than this and the Bash snapshot is skipped: the row would be large and the signal is noise. */
const MAX_SNAPSHOT = 2000;

const NUDGE = `[Eklavya] This task now edits more than one file. Hand the remaining work to one or more agents run in the background, each with a self-contained brief (goal, files, constraints, how to verify), and take back a short report. While they build, ask questions: get_session_quiz_plan with while_waiting: true, then AskUserQuestion, record_attempt and the verdict, one at a time, until an agent reports or questions_needed is 0. If the rest is a line or two, or agents cannot run in the background here, carry on inline.`;

interface State {
  /** The first changed file, once one is known. */
  first?: string;
  /** Bash only: `git status` entries at the previous Bash call, path -> size:mtime. */
  snap?: Record<string, string>;
  done?: boolean;
}

/** The same file under every spelling: a symlinked temp dir, `./a.ts`, `a.ts`. */
function canonical(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** Every entry `git status` reports, by absolute path, with its size and mtime; null outside a repository. */
function dirtyStamps(cwd: string): Record<string, string> | null {
  const root = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (!root) return null;
  const status = git(root, ['status', '--porcelain=v1', '-z', '-uall']);
  if (status === null) return null;
  const entries = status.split('\0');
  if (entries.length > MAX_SNAPSHOT) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? '';
    if (entry.length < 4) continue;
    // `R` and `C` entries carry the source path as the next NUL field.
    if (entry[0] === 'R' || entry[0] === 'C') i++;
    const file = canonical(path.join(root, entry.slice(3)));
    try {
      const st = fs.statSync(file);
      out[file] = `${st.size}:${st.mtimeMs}`;
    } catch {
      out[file] = 'gone';
    }
  }
  return out;
}

await run(async (input) => {
  const tool = input.tool_name ?? '';
  const isBash = tool === 'Bash';
  if (input.agent_id || !(isBash || EDIT_TOOLS.test(tool))) return 0;
  const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!isBash && (typeof raw !== 'string' || !raw)) return 0;

  const cwd = cwdOf(input);
  const { quiz, delegate_work } = config(cwd).config;
  if (!quiz.enabled || !delegate_work) return 0;

  const db = openExisting();
  if (!db) return 0;
  const sid = sessionId(input, db);
  if (!sid) return 0;

  const key = `${KEY_PREFIX}${sid}`;
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
  if (read().done) return 0;

  // Outside the lock: git can take a moment, and nothing here needs the row.
  let changed: string[];
  let snap: Record<string, string> | undefined;
  if (isBash) {
    const now = dirtyStamps(cwd);
    if (!now) return 0;
    snap = now;
    changed = []; // filled against the stored snapshot below
  } else {
    changed = [canonical(path.resolve(cwd, raw as string))];
  }

  const nudge = db
    .transaction(() => {
      db.prepare(`DELETE FROM meta WHERE key LIKE ? AND substr(value, 1, 10) < date('now', '-7 day')`).run(
        `${KEY_PREFIX}%`,
      );
      const state = read();
      if (state.done) return false;
      if (snap) {
        // ponytail: the first snapshot is taken after the first Bash call, so a
        // first command that already changed two files is caught only when a
        // later call changes one more. A PreToolUse snapshot would close it at
        // the cost of a second process on every Bash call.
        if (state.snap) {
          const before = state.snap;
          changed = Object.keys(snap).filter((f) => before[f] !== snap![f]);
        }
        state.snap = snap;
      }
      const others = [...new Set(changed)].filter((f) => f !== state.first);
      if (!state.first && others.length) state.first = others.shift();
      if (others.length) {
        state.done = true;
        delete state.snap;
      }
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key,
        `${new Date().toISOString()}|${JSON.stringify(state)}`,
      );
      return Boolean(state.done);
    })
    .immediate();
  if (!nudge) return 0;

  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: NUDGE } })}\n`,
  );
  return 0;
});
