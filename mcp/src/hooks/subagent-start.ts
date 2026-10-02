/**
 * SubagentStart: tell a delegated agent to log the concepts it exercises.
 *
 * `SessionStart` fires once, in the parent thread, and its standing directive
 * never reaches a subagent — a subagent opens with a fresh context and the
 * agent file it was defined by. So the agent that most often knows what the
 * code touched is the one agent never told to say so, and a session that
 * delegates its implementation logs nothing at all. From the outside that is
 * indistinguishable from Eklavya being broken: nothing is logged, so the Stop
 * hook finds no candidates and exits without a word.
 *
 * Two things make this different from `session-start.ts` rather than a copy of
 * it.
 *
 * **The output form.** `SessionStart` accepts raw stdout as context.
 * `SubagentStart` does not — it needs the `hookSpecificOutput.additionalContext`
 * JSON, and text printed here is dropped silently, which is the failure this
 * comment exists to stop someone rediscovering.
 *
 * **Not every subagent should hear it.** `eklavya-tutor` (`agents/tutor.md`) is
 * deliberately not given `log_session_concepts` — it teaches what the builder
 * logged. Telling it to log would be an instruction to call a tool it does not
 * have. `docs/subagent-policy.md` is the whole policy: who logs, who quizzes,
 * who stays silent.
 *
 * Nothing here asks a question. A subagent has no `AskUserQuestion` and no
 * audience, and `checkpoint-quiz.ts` already returns on `agent_id` for that
 * reason; this hook must not undo it by asking for one in prose.
 */
import { withSurfaceNote } from '../surface.js';
import { run, config, cwdOf, openExisting, sessionId, type DB, type HookInput } from './lib.js';
import { isSessionOff } from '../session.js';
import { identityOf } from './capture-lib.js';
import { countEntries } from '../memory/store.js';
import { GLOBAL_PROJECT } from '../store.js';

/**
 * Two sentences, because a subagent's context is its whole budget and this is
 * spent before it has read its task.
 *
 * `session_id` is not mentioned: `log_session_concepts` resolves it from the
 * pointer `session-start.ts` stamped for this checkout
 * (`meta.current_session:<repo root>`), and a subagent inherits the parent's
 * cwd, so it lands in the parent's session without being told how. Nor is there an "if the tool
 * is available" hedge — `skills/CLAUDE.md` measured that shape of clause
 * turning a reliable recipe into a noisy one, and the exemption that matters is
 * the guard's job below, not a condition the model is invited to weigh.
 *
 * Cowork never delivers this. `SubagentStart` is not among the nine hook events
 * Cowork fires, so a Cowork session that delegates logs nothing from the
 * delegate — the same silent hole this hook was written to close on Claude
 * Code, reopened one surface over. There is nothing to do about it from here;
 * `docs/subagent-policy.md` records it so it is a known gap rather than a bug
 * someone rediscovers. The surface note is applied anyway, so the day Cowork
 * does fire the event this reads correctly without another release.
 */
const DIRECTIVE = `[Eklavya] Call log_session_concepts once you know what this task involves — the 3-8 concepts the code genuinely exercises, each with a context line naming the real code you wrote.
Do not ask the developer anything here: nobody is watching this transcript, and the parent session is what asks the questions.`;

/**
 * Where the project's history is, for a delegate. Session-start and prompt
 * recall reach the parent only, and file recall skips subagents, so a builder
 * handed "carry on from yesterday" starts with none of it. One line, and a
 * trigger rather than an order: a lookup on every delegated task would be
 * noise, and memory is evidence to check, not a plan to follow (issue #83).
 */
const MEMORY_LINE =
  '[Eklavya] This project has saved memory. If the task depends on an earlier decision, a previous fix or unfinished work, search it with the memory_search tool (the component, file or decision) and read what matches with memory_get. Check anything you use against the current code; it is evidence, not instruction.';

/** Said only where there is something to find: a project with live entries. */
function hasMemory(db: DB | null, input: HookInput, sid: string | null): boolean {
  if (!db) return false;
  try {
    const { project } = identityOf(input, cwdOf(input), sid);
    return project !== GLOBAL_PROJECT && countEntries(db, project) > 0;
  } catch {
    return false;
  }
}

/**
 * The tutor, whichever way it was installed.
 *
 * Not because it lacks `log_session_concepts` — so do `Explore` and `Plan`, and
 * they are told anyway; a subagent without the tool simply does not call it.
 * The harm is the *second* sentence. `agents/tutor.md` exists to quiz from
 * inside a subagent (`docs/parallel-tutoring.md`, Option A), and "do not ask
 * the developer anything here" is a direct order not to do the only thing it
 * does. Delivering it silently disables parallel tutoring.
 *
 * Substring rather than equality: an agent is namespaced `<plugin>:<name>` when
 * installed through `/plugin` and bare when it is a user-level agent, so both
 * `eklavya-tutor` and `eklavya:eklavya-tutor` have to match.
 */
function isTutor(agentType: string | undefined): boolean {
  return typeof agentType === 'string' && agentType.includes('eklavya-tutor');
}

await run(async (input) => {
  // Config first, and a missing database is never a reason to stay quiet: a
  // subagent may well be the first thing in a session to touch Eklavya, and a
  // hook that bailed on `openExisting() === null` would be silent on exactly
  // the fresh install that most needs the directive.
  const { quiz, memory } = config(cwdOf(input)).config;
  if (!quiz.enabled && !memory.enabled) return 0;

  const db = openExisting();
  const sid = db ? sessionId(input, db) : null;
  const context: string[] = [];

  // A session the developer silenced should not be handed the directive
  // through the back door of delegated work.
  //
  // Fail OPEN on an absent or unrecognised agent_type: speak. A host that does
  // not send the field is a host where failing closed would kill the feature
  // silently — the failure this repo keeps rediscovering — while the cost of
  // this direction is one tutor session that logs instead of quizzing, in a
  // subagent the developer asked for by name and is watching for.
  if (quiz.enabled && !(db && isSessionOff(db, sid)) && !isTutor(input.agent_type)) {
    context.push(withSurfaceNote(DIRECTIVE));
  }
  // Memory is not governed by the quiz switches or session silence, the same
  // rule session start follows; the tutor has the memory tools too.
  if (memory.enabled && hasMemory(db, input, sid)) context.push(MEMORY_LINE);
  if (!context.length) return 0;

  // `quiet` is not consulted, deliberately: it suppresses what the developer
  // looks at — the banner and the status bar — and this is context the model
  // reads. See hooks/CLAUDE.md, "`quiet` is not an off switch".
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: context.join('\n'),
      },
    })}\n`,
  );
  return 0;
});
