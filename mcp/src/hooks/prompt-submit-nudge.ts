/**
 * UserPromptSubmit: say the standing instruction again, once, when a session
 * has plainly stopped hearing it.
 *
 * `session-start.ts` injects the directive that starts the whole loop -- call
 * `log_session_concepts` with what this task exercises -- and its own comment
 * explains why it lives in a hook rather than only in the tutor skill: the skill
 * is model-invocable, it competes with every other skill on the machine, and it
 * may never load. The same argument applies one level up. A directive injected
 * once is the oldest thing in the context window by turn forty, competing with
 * everything that arrived after it.
 *
 * That failure is the worst-shaped one Eklavya has, because nothing errors.
 * Nothing gets logged, so `session_concepts` stays empty, so the Stop hook finds
 * no candidates and exits silently. From the outside it reads as *Eklavya is
 * broken* -- which is unreportable, and the reason both comparable plugins
 * (ponytail, claude-mem) re-inject on every prompt rather than once per session.
 *
 * Where this deliberately differs from them: they re-emit their whole ruleset
 * every turn. This emits ONE line, and only when it has been earned. A hook that
 * spends tokens on every prompt to repeat something the model is already doing
 * is a hook that makes every session more expensive to no end -- and a nudge
 * that arrives while logging is working teaches the model to ignore nudges.
 *
 * So the predicate is narrow, and it is the one case worth catching: this
 * session has logged **nothing at all**, and it has been going long enough that
 * the session-start directive can no longer be blamed on not having had a chance.
 * A session that logged once and then went quiet for a while is *not* nudged --
 * concepts are logged per task and a task can legitimately run long, so that
 * signal is noise.
 *
 * State lives in `meta` rather than a table of its own: one row per session,
 * `prompt_nudge:<sid>` -> `<first-seen>|<last-nudge>|<count>`, pipe-delimited so
 * the prune below is one statement and needs no JSON parsing in SQL. A
 * migration for a rate limiter would be a schema change for a comment.
 * `session-start` deletes the row when it reprints the directive, which is what
 * re-arms the grace window on a resume or after a compaction.
 *
 * Failure is silent, as everywhere here: exit 0, no output. This runs on every
 * prompt the developer types, so it is also the hook with the least right to be
 * slow -- the common case (a session that is logging) is one COUNT and out.
 */
import {
  run,
  openExisting,
  config,
  cwdOf,
  sessionId,
  minutesSince,
  NUDGE_KEY_PREFIX,
  type DB,
} from './lib.js';
import { withSurfaceNote } from '../surface.js';
import { isSessionOff, setCurrentSession } from '../session.js';
// `capture-lib`, not `memory-lib`: this runs on every prompt, and `memory-lib`
// loads the worker, provider, zod and notify for the seams (see capture-lib.ts).
import { batchIfFull, identityOf, record } from './capture-lib.js';
import type { ResolvedConfig } from '../config.js';
import type { EvidenceIdentity } from '../memory/identity.js';
import { recallForPrompt } from '../memory/recall.js';

/**
 * Recall for one prompt, mid-session, or null.
 *
 * Silent far more often than not: too short a prompt, nothing relevant, or
 * nothing this session has not already been handed. That is the design — a
 * recall on every turn is a tax on every turn.
 */
function promptRecall(
  db: DB,
  resolved: ResolvedConfig,
  identity: EvidenceIdentity,
  prompt: string,
): string | null {
  try {
    if (!resolved.config.memory.enabled) return null;
    const result = recallForPrompt(db, resolved.config, {
      project: identity.project,
      sessionId: identity.sessionId,
      prompt,
    });
    return result?.block ?? null;
  } catch {
    return null;
  }
}

/**
 * Long enough that the session-start directive has had a fair chance, short
 * enough to still be the same piece of work. Not configurable on purpose: a
 * knob for this would be a config key, a schema entry, a CLI line and four doc
 * updates to tune something nobody can feel.
 */
const GRACE_MINUTES = 12;

/** And having said it once, do not say it again this soon. */
const COOLDOWN_MINUTES = 25;

/**
 * And having said it three times, stop.
 *
 * The cooldown alone is not a bound. "This session has logged nothing at all"
 * is not only the signature of a model that forgot the directive -- it is also
 * exactly what a dead MCP server looks like from here, and that state never
 * resolves. Without a cap an eight-hour session against an unreachable server
 * gets nineteen injections telling the model to call a tool that is not
 * registered, each one likely drawing a visible failure in the transcript.
 *
 * `max_stop_blocks_per_session` is the same kind of backstop for the Stop hook,
 * for the same reason. A constant rather than a config key: the difference
 * between three nudges and four is not something anyone needs to tune.
 */
const MAX_NUDGES = 3;

/**
 * `<first-seen ISO>|<last-nudge ISO or empty>|<nudges so far>`
 *
 * The count was appended rather than inserted, so a row written by the previous
 * shape reads back as count 0 instead of throwing. It buys such a row at most
 * MAX_NUDGES extra nudges, once, which is cheaper than a migration.
 */
function readState(db: DB, key: string): { first: string; nudged: string | null; count: number } | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;
  const [first, nudged, count] = row.value.split('|');
  if (!first) return null;
  return { first, nudged: nudged || null, count: Number(count) || 0 };
}

function writeState(db: DB, key: string, first: string, nudged: string | null, count: number): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    `${first}|${nudged ?? ''}|${count}`,
  );
}

/**
 * One row per session would otherwise be one row per session forever. The value
 * starts with an ISO date, which compares lexicographically, so a week's cutoff
 * is a substring comparison rather than a parse.
 */
function prune(db: DB): void {
  db.prepare(
    `DELETE FROM meta
      WHERE key LIKE ?
        AND substr(value, 1, 10) < date('now', '-7 day')`,
  ).run(`${NUDGE_KEY_PREFIX}%`);
}

await run(async (input) => {
  // A subagent's prompts are not the developer's, and the parent is the thread
  // that logs. Nudging here would spend context inside a transcript nobody is
  // reading. Same reasoning as checkpoint-quiz.ts.
  if (input.agent_id) return 0;

  // Config before the database, unlike the other hooks: this one runs on every
  // prompt the developer types, so a dormant or quiet session should not pay to
  // open SQLite before finding out it had nothing to do. Reading one or two
  // small JSON files is the cheaper question, so it is asked first.
  const cwd = cwdOf(input);
  const resolved = config(cwd);
  const { quiz } = resolved.config;
  // `quiz.enabled: false` silences the learning half. It does not stop memory
  // capture -- someone who asked for no quizzes did not ask for their project
  // history to stop being recorded (PRD CFG-01) -- so the early return needs
  // both switches off, which is exactly the pair of names the config now uses.
  if (!quiz.enabled && !resolved.config.memory.enabled) return 0;
  // `quiet` is deliberately NOT consulted. It suppresses the banner and the
  // status bar -- things the developer looks at -- and this is an
  // additionalContext line the model reads, exactly like the session-start
  // directive it restates. Honouring it here used to be defended as consistency
  // with that directive, which was itself being dropped under `quiet`: between
  // them they turned a preference about greetings into a silent off switch.
  // `mode: off` is the off switch.

  const db = openExisting();
  if (!db) return 0;

  const sid = sessionId(input, db);
  if (!sid) return 0;

  // Re-stamp the session pointer the MCP tools resolve against (decision G1).
  // `session-start` sets it once, so within one checkout it names whichever
  // session started last — and the model, which cannot see its own session id,
  // would then silence, un-silence or log to the wrong one. Restamping here
  // makes it "the session whose developer most recently typed", which is the
  // session whose model is about to call a tool. One indexed upsert, on a hook
  // that has already opened the database.
  //
  // Across checkouts that reasoning fails, which is why the pointer is keyed by
  // one: a model churning for ten minutes while its developer works in another
  // repo calls its tools long after that other window typed. `cwd` is what keeps
  // the two apart — see `sessionKeyFor`.
  setCurrentSession(db, sid, cwd);

  // The prompt is the single most useful thing a session produces for recall:
  // it is the only place the developer says what they were trying to do. It is
  // captured before every learning gate below, for the reason above.
  // Anything the model should be handed this turn. At most one JSON envelope
  // leaves this hook, so the recall block and the nudge line share it.
  const context: string[] = [];

  if (resolved.config.memory.enabled && typeof input.prompt === 'string' && input.prompt.trim()) {
    const identity = identityOf(input, cwd, sid);
    record(db, resolved, identity, { kind: 'prompt', title: 'prompt', body: input.prompt });
    batchIfFull(db, resolved, identity);
    // The session seam answers "what is this project". This answers "what do
    // we already know about the thing they just asked for", which is the one
    // that catches a change of subject halfway through a session. It returns
    // nothing far more often than not, on purpose.
    const recalled = promptRecall(db, resolved, identity, input.prompt);
    if (recalled) context.push(recalled);
  }

  if (!quiz.enabled) return emit(context);

  if (isSessionOff(db, sid)) return emit(context);

  // The fast path, and the one that runs on almost every prompt: a session that
  // is logging needs nothing said to it.
  const logged = db
    .prepare('SELECT count(*) AS n FROM session_concepts WHERE session_id = ?')
    .get(sid) as { n: number } | undefined;
  if ((logged?.n ?? 0) > 0) return emit(context);

  const key = `${NUDGE_KEY_PREFIX}${sid}`;
  const now = new Date().toISOString();
  const state = readState(db, key);

  // First prompt we have seen for this session. The directive was injected
  // seconds ago; repeating it now would be noise. Start the clock instead.
  if (!state) {
    prune(db);
    writeState(db, key, now, null, 0);
    return emit(context);
  }

  if (state.count >= MAX_NUDGES) return emit(context);
  if (minutesSince(state.first) < GRACE_MINUTES) return emit(context);
  if (state.nudged && minutesSince(state.nudged) < COOLDOWN_MINUTES) return emit(context);

  writeState(db, key, state.first, now, state.count + 1);

  // Surface-noted like the two directives this restates. Cowork *does* fire
  // `UserPromptSubmit`, and a session that has logged nothing is exactly the
  // state this hook exists to catch — so without the note this is the one
  // string still telling the model to name "the real code" in work that has
  // none, on the only path that reaches a session already going wrong.
  context.push(
    withSurfaceNote(
      '[Eklavya] Nothing logged this session. Once you know what the current task involves, call log_session_concepts with the 3-8 concepts it genuinely exercises, each with a context line naming the real code — without it there is nothing to quiz on.',
      ' ',
    ),
  );
  return emit(context);
});

/**
 * One envelope or silence.
 *
 * A hook may write a single JSON object, so every exit from the body above
 * goes through here rather than printing its own — two writes would be one
 * malformed document, and a malformed document is a hook that runs, exits 0
 * and is ignored.
 */
function emit(context: string[]): number {
  if (!context.length) return 0;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context.join('\n') },
    })}\n`,
  );
  return 0;
}
