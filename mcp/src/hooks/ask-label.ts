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
import { run, openExisting, sessionId, type HookInput } from './lib.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needsInlineAttribution } from '../surface.js';
import { visibleOptionProblem } from '../eval/question-checks.js';
import { recordOptionCheck, type OptionCheckOutcome } from '../option-checks.js';

const PREFIX = /^\s*\[eklavya\]/i;

function deny(reason: string): void {
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`,
  );
}

/**
 * Where a stem stands: 'new' the first time it is seen, 'open' after it was sent
 * back, 'done' once its rewrite has been counted. The rewrite is asked for once;
 * a question that comes back with the same stem is shown as written. A marker
 * file in the temp directory is the whole state; losing it only means one more
 * request for a rewrite and one uncounted outcome.
 */
function sight(sessionId: unknown, stem: string): { state: 'new' | 'open' | 'done'; set: (s: 'open' | 'done') => void } {
  const key = createHash('sha1').update(`${String(sessionId)}\n${stem}`).digest('hex').slice(0, 16);
  const marker = path.join(os.tmpdir(), `eklavya-ask-${key}`);
  const state = fs.existsSync(marker) ? (fs.readFileSync(marker, 'utf8') === 'done' ? 'done' : 'open') : 'new';
  return { state, set: (s) => fs.writeFileSync(marker, s) };
}

/** Counts one outcome of the check. `run` fails open on anything this throws. */
function count(input: HookInput, outcome: OptionCheckOutcome): void {
  const db = openExisting();
  if (!db) return;
  try {
    recordOptionCheck(db, { sessionId: sessionId(input, db) ?? 'unknown', surface: 'card', outcome });
  } finally {
    db.close();
  }
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
    const seen = sight(input.session_id, q.question);
    if (problem && seen.state === 'new') {
      seen.set('open');
      deny(`Rewrite the options and ask again with the same question: ${problem}.`);
      count(input, 'sent_back');
      return 0;
    }
    if (seen.state === 'open') {
      seen.set('done');
      count(input, problem ? 'unchanged' : 'rewritten');
    }
  }
  return 0;
});
