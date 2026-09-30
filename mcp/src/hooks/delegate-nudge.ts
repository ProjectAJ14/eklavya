/**
 * PostToolUse (edit tools): the moment a change turns out to span files, say
 * "delegate the rest" -- once.
 *
 * The session-start `DELEGATE` block asks for the same thing, and in eleven live
 * sessions on 1.40 it was followed zero times: changes of 8, 10 and 12 edits all
 * ran in the main conversation. It arrives before the task exists, and by the
 * time the model decides how to build, it is far back in context. The Stop
 * sweep, which arrives exactly when it applies, was followed every time. So this
 * is the same instruction, moved to where it applies: the main thread has just
 * edited a second distinct file, which is what "a change across several files"
 * looks like from the outside.
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
 * - Once per session, stamped under one lock so two edits at once cannot both
 *   nudge. No git, no inference; fails open.
 */
import path from 'node:path';
import { run, openExisting, config, cwdOf, sessionId } from './lib.js';

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const KEY_PREFIX = 'delegate_nudge:';
/** The value once the nudge has been given: no file path is this. */
const DONE = '*';

const NUDGE = `[Eklavya] This task now edits more than one file. Hand the remaining work to one or more agents run in the background, each with a self-contained brief (goal, files, constraints, how to verify), and take back a short report. While they build, ask questions: get_session_quiz_plan with while_waiting: true, then AskUserQuestion, record_attempt and the verdict, one at a time, until an agent reports or questions_needed is 0. If the rest is a line or two, or agents cannot run in the background here, carry on inline.`;

await run(async (input) => {
  if (input.agent_id || !EDIT_TOOLS.test(input.tool_name ?? '')) return 0;
  const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof raw !== 'string' || !raw) return 0;

  const cwd = cwdOf(input);
  const { quiz, delegate_work } = config(cwd).config;
  if (!quiz.enabled || !delegate_work) return 0;

  const db = openExisting();
  if (!db) return 0;
  const sid = sessionId(input, db);
  if (!sid) return 0;

  const file = path.resolve(cwd, raw);
  const key = `${KEY_PREFIX}${sid}`;
  // Value: `<iso date>|<first file>`, then `<iso date>|*` once nudged. The date
  // prefix is what the prune reads, the same way `noteEdit` ages its marks.
  const nudge = db
    .transaction(() => {
      db.prepare(`DELETE FROM meta WHERE key LIKE ? AND substr(value, 1, 10) < date('now', '-7 day')`).run(
        `${KEY_PREFIX}%`,
      );
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
      const seen = row?.value.slice(row.value.indexOf('|') + 1);
      if (seen === DONE || seen === file) return false;
      const value = `${new Date().toISOString()}|${seen === undefined ? file : DONE}`;
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key,
        value,
      );
      return seen !== undefined;
    })
    .immediate();
  if (!nudge) return 0;

  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: NUDGE } })}\n`,
  );
  return 0;
});
