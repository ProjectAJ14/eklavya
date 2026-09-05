/**
 * PreToolUse(Bash): hold commits until the session quiz is passed.
 *
 * This runs on EVERY Bash call, so the first thing it does is decide the command
 * is none of its business and get out of the way.
 */
import { run, openExisting, config, cwdOf, sessionId } from './lib.js';

/**
 * `git commit` only counts at a command position: after the start of the line or
 * a shell separator. This is what keeps `echo "git commit"` from being blocked,
 * while `npm test && git commit -m x` is still caught. The option group allows a
 * value after a flag, so `git -C . commit` and `git -c user.name=x commit` are
 * caught alongside plain `git commit`.
 */
const COMMIT = /(^|[;&|])\s*(sudo\s+)?git(\s+-\S+(\s+[^-\s]\S*)?)*\s+commit(\s|$)/;

await run(async (input) => {
  // Fast path: no string match, no work. PreToolUse fires on every Bash call.
  const command = input.tool_input?.command;
  if (!command || !command.includes('commit')) return 0;
  if (!COMMIT.test(command)) return 0;

  const cwd = cwdOf(input);
  if (config(cwd).config.mode !== 'enforced') return 0;

  const db = openExisting();
  if (!db) return 0;

  const sid = sessionId(input, db);
  if (!sid) return 0;

  const gate = db
    .prepare('SELECT passed, required, answered FROM gates WHERE session_id = ?')
    .get(sid) as { passed: number; required: number; answered: number } | undefined;

  // No gate row means nothing was taught this session, so there is nothing to
  // prove. Blocking here would be unpassable, not strict.
  if (!gate) return 0;
  if (gate.passed === 1) return 0;

  const reason =
    `Eklavya gate: this session's quiz has not been passed yet (${gate.answered} of ${gate.required} concepts answered). ` +
    'Run the quiz first — get_session_quiz_plan, ask one question at a time, grade each answer with record_attempt — ' +
    'then retry the commit. Nothing else is blocked.';

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
  return 0;
});
