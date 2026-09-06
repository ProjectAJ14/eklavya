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
import { run, config, cwdOf } from './lib.js';

/**
 * Two sentences, because a subagent's context is its whole budget and this is
 * spent before it has read its task.
 *
 * `session_id` is not mentioned: `log_session_concepts` resolves it from
 * `meta.current_session`, which `session-start.ts` stamped, so a subagent lands
 * in the parent's session without being told how. Nor is there an "if the tool
 * is available" hedge — `skills/CLAUDE.md` measured that shape of clause
 * turning a reliable recipe into a noisy one, and the exemption that matters is
 * the guard's job below, not a condition the model is invited to weigh.
 */
const DIRECTIVE = `[Eklavya] Call log_session_concepts once you know what this task involves — the 3-8 concepts the code genuinely exercises, each with a context line naming the real code you wrote.
Do not ask the developer anything here: nobody is watching this transcript, and the parent session is what asks the questions.`;

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
  // No database read at all. Whether to speak depends only on `mode`, and a
  // subagent may well be the first thing in a session to touch Eklavya — a hook
  // that bailed on a missing database would stay silent on exactly the fresh
  // install that most needs the directive. (`lib.js` still pulls in the SQLite
  // driver at import, so this is one query fewer, not a free hook.)
  if (config(cwdOf(input)).config.mode === 'off') return 0;

  // Fail OPEN on an absent or unrecognised agent_type: speak. A host that does
  // not send the field is a host where failing closed would kill the feature
  // silently — the failure this repo keeps rediscovering — while the cost of
  // this direction is one tutor session that logs instead of quizzing, in a
  // subagent the developer asked for by name and is watching for.
  if (isTutor(input.agent_type)) return 0;

  // `quiet` is not consulted, deliberately: it suppresses what the developer
  // looks at — the banner and the status bar — and this is context the model
  // reads. See hooks/CLAUDE.md, "`quiet` is not an off switch".
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: DIRECTIVE,
      },
    })}\n`,
  );
  return 0;
});
