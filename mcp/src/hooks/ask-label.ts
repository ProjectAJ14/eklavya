/**
 * PreToolUse(`AskUserQuestion`): an Eklavya question on a card host must carry
 * its `[Eklavya]` line, and on any host its options must not give the answer
 * away (`visibleOptionProblem`, sent back once per stem).
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
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needsInlineAttribution } from '../surface.js';
import { visibleOptionProblem } from '../eval/question-checks.js';

const PREFIX = /^\s*\[eklavya\]/i;

function deny(reason: string): void {
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`,
  );
}

/**
 * True the first time a stem is seen, false after: the rewrite is asked for
 * once, and a question that comes back with the same stem is shown as written.
 * A marker file in the temp directory is the whole state; losing it only means
 * one more request for a rewrite.
 */
function firstSight(sessionId: unknown, stem: string): boolean {
  const key = createHash('sha1').update(`${String(sessionId)}\n${stem}`).digest('hex').slice(0, 16);
  const marker = path.join(os.tmpdir(), `eklavya-ask-${key}`);
  if (fs.existsSync(marker)) return false;
  fs.writeFileSync(marker, '');
  return true;
}

await run(async (input) => {
  if (input.tool_name !== 'AskUserQuestion' || input.agent_id) return 0;
  const questions = input.tool_input?.questions;
  if (!Array.isArray(questions)) return 0;
  const ours = questions.filter(
    (q) => typeof q?.header === 'string' && q.header.trim().toLowerCase() === 'eklavya' && typeof q.question === 'string',
  );
  if (needsInlineAttribution() && ours.some((q) => !PREFIX.test(q.question))) {
    deny(
      'This host draws no header chip, so an Eklavya question must open with "[Eklavya]" on its own line, then the stem. Ask the same question again with that line added; change nothing else.',
    );
    return 0;
  }
  for (const q of ours) {
    const options = Array.isArray(q.options) ? q.options.filter((o: any) => typeof o?.label === 'string') : [];
    const problem = visibleOptionProblem(options);
    if (problem && firstSight(input.session_id, q.question)) {
      deny(`Rewrite the options and ask again with the same question: ${problem}.`);
      return 0;
    }
  }
  return 0;
});
