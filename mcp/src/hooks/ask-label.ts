/**
 * PreToolUse(`AskUserQuestion`): an Eklavya question on a card host must carry
 * its `[Eklavya]` line.
 *
 * The plan's `ask_attribution` asks for it, and a model can read past an
 * instruction. This is the check behind the instruction: a question headed
 * "Eklavya" on a host that paints no header chip (`needsInlineAttribution`) and
 * whose stem does not open with `[Eklavya]` is refused once, with the fix in the
 * reason. Anything else -- another header, a terminal, no questions -- passes
 * untouched, so Claude's own questions are never relabelled.
 *
 * Fails open like every hook, and stays on the lightest imports.
 */
import { run } from './lib.js';
import { needsInlineAttribution } from '../surface.js';

const PREFIX = /^\s*\[eklavya\]/i;

await run(async (input) => {
  if (input.tool_name !== 'AskUserQuestion' || input.agent_id || !needsInlineAttribution()) return 0;
  const questions = input.tool_input?.questions;
  if (!Array.isArray(questions)) return 0;
  const unsigned = questions.some(
    (q) =>
      typeof q?.header === 'string' &&
      q.header.trim().toLowerCase() === 'eklavya' &&
      typeof q.question === 'string' &&
      !PREFIX.test(q.question),
  );
  if (!unsigned) return 0;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'This host draws no header chip, so an Eklavya question must open with "[Eklavya]" on its own line, then the stem. Ask the same question again with that line added; change nothing else.',
      },
    })}\n`,
  );
  return 0;
});
