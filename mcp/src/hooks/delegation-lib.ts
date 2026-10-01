/**
 * The delegation contract, in one place, for the three hooks that say it.
 *
 * `session-start` states it once, `prompt-submit-nudge` repeats its core next to
 * each task-sized prompt, and `delegate-nudge` repeats it as a recovery at the
 * second file the parent changes itself. They used to be three paraphrases, and
 * a paraphrase drifts: the staged case and the working directory were in none of
 * them, and the one escape clause that let a session stay inline silently was
 * in all three. Built from the same sentences, they cannot disagree.
 *
 * Strings only: the prompt hook runs on every prompt, and `hook-isolation.test`
 * pins what it may load.
 */

/** `meta` key prefix for a session's delegation state (`delegate-nudge.ts` writes it). */
export const DELEGATE_KEY_PREFIX = 'delegate_nudge:';

const BRIEF =
  "a self-contained brief: the absolute directory to work in (the task worktree, if there is one), the goal, the files, the user's constraints and the checks to run";

const STAGED =
  "A staged plan goes one stage per agent, in order: review its result, run the stage's checks and commit before starting the next, and do not edit its files meanwhile.";

const INLINE =
  'Do it yourself when it is a question, a lookup, docs or design only, a line or two, or the user said to work inline. If agents cannot run in the background here, say so in one line and work inline.';

/** The question loop while a builder works, or what replaces it under `cadence: end`. */
function asking(cadence: string): string {
  return cadence === 'end'
    ? 'Questions wait for the end of the task (cadence: end).'
    : 'While it builds: get_session_quiz_plan with while_waiting: true, then AskUserQuestion, record_attempt and the verdict, one at a time, until it reports or questions_needed is 0.';
}

/** SessionStart, after the standing directive. */
export function sessionBlock(cadence: string): string {
  return [
    '[Eklavya] Delegation is on for this session (delegate_work). For a code change across several files:',
    `  - An agent run in the background builds it, with ${BRIEF}. A worktree you create or were given is setup, not delegation: the agent works in it.`,
    '  - You stay the lead: plan, answer the developer, review what comes back, run the checks the user asked for and commit.',
    `  - ${STAGED}`,
    `  - ${asking(cadence)} Write the task answer last.`,
    `  - ${INLINE}`,
  ].join('\n');
}

/** UserPromptSubmit, next to a task-sized prompt: the moment the model decides how to build. */
export function promptLine(cadence: string): string {
  return `[Eklavya] If this asks for a code change across several files, do not build it inline: start an agent in the background with ${BRIEF}. ${STAGED} ${asking(cadence)} ${INLINE}`;
}

/** PostToolUse, at the parent's second changed file: the recovery for a session building inline anyway. */
export function nudge(cadence: string): string {
  return `[Eklavya] This change now spans files. Unless the user said to work inline, hand the rest to an agent run in the background, with ${BRIEF}. ${STAGED} ${asking(cadence)} Staying inline (a line or two left, docs or design only, or no background agents here)? Say why in one line.`;
}
