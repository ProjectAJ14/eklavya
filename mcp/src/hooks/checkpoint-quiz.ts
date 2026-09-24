/**
 * PostToolUse(log_session_concepts): ask ONE question, here, now, mid-task.
 *
 * This is the hook that makes the pitch literal. Everything else in Eklavya
 * quizzes at Stop, which means the developer is asked four questions at the exact
 * moment they wanted to be finished -- learning bolted onto the end of the work
 * rather than happening during it. The seam this fires on is the best one
 * available: the model has just told the server "this task exercises
 * jwt-verification, and here is the line where", so the code that teaches the
 * concept is still on screen and still in context. A question asked there costs
 * seconds. The same question asked twenty minutes later costs a re-read.
 *
 * THE BURST GUARD IS THE POINT OF THIS FILE, exactly as the loop guard is the
 * point of stop-quiz-check.ts -- but it guards a different failure. That one
 * stops an end-of-turn loop; this one stops a mid-turn pile-up. The model logs
 * concepts in batches of 3-8 and may call the tool several times in one task, so
 * the naive version asks eight questions in a row and gets uninstalled. Three
 * rules keep it to a trickle:
 *
 *   1. one question per checkpoint, never a batch -- we ask for `max: 1`, and
 *      the planner caps an interleaved plan at one anyway, so a model that drops
 *      the argument still cannot be handed four;
 *   2. min_minutes_between_checkpoints since the last one, wall clock;
 *   3. the session budget is max_questions_per_task, shared with the Stop hook.
 *
 * Rule 3 is why this does not add questions, it moves them. Every answer here is
 * an `attempts` row, and stop-quiz-check.ts subtracts those from its own budget.
 * Answer the lot while the agent works and the Stop hook says nothing at all.
 *
 * It fires on the work tools too (Bash, Edit, Write, MultiEdit, NotebookEdit),
 * not only on the logging call. The model logs its whole batch in one call at the
 * start of a task, so a checkpoint that re-armed only on logging asked once per
 * task however long the task ran: two real 25-minute Flutter sessions each got
 * one mid-work question out of seven and five logged concepts. The work tools
 * are the "still working" signal, and the clock in rule 2 does the pacing.
 * That is also why the config is read before the database: this now runs on
 * most tool calls, and a session with quizzing off should not pay for SQLite.
 *
 * Failure is always silent: exit 0, no output. A missed question is nothing; a
 * hook that errors on every tool call is a plugin nobody keeps.
 */
import { attributionRule } from '../surface.js';
import { run, openExisting, config, cwdOf, sessionId, minutesSince, framingFor } from './lib.js';
import { isSessionOff } from '../session.js';
import { countUse } from '../telemetry.js';

await run(async (input) => {
  // Fast path. `agent_id` is present only inside a subagent, and a subagent
  // cannot ask the developer anything -- AskUserQuestion is not in its toolset,
  // and the human is not watching that transcript. Checkpointing there would
  // burn a question from the budget on a prompt nobody ever sees.
  if (input.agent_id) return 0;

  const cwd = cwdOf(input);
  const { quiz, cadence, focus, focus_topic, max_questions_per_task, min_minutes_between_checkpoints } =
    config(cwd).config;

  if (!quiz.enabled) return 0;
  // The whole feature behind one switch. `end` is the pre-1.4 behaviour: silence
  // until Stop.
  if (cadence !== 'interleaved') return 0;

  const db = openExisting();
  if (!db) return 0;

  const sid = sessionId(input, db);
  if (!sid) return 0;
  if (isSessionOff(db, sid)) return 0;

  // One query for every number this decision needs.
  //
  // The candidate count and the concept line below share their WHERE clause with
  // stop-quiz-check.ts, and must: a concept this hook considers unaskable is one
  // the Stop hook has to catch, and the two disagreeing is how a learner gets
  // asked about something twice or never.
  const stats = db
    .prepare(
      `SELECT
         (SELECT count(*) FROM session_concepts sc
            JOIN concepts c ON c.id = sc.concept_id
            LEFT JOIN mastery m ON m.concept_id = c.id
           WHERE sc.session_id = @sid
             AND COALESCE(sc.origin,'work') = 'work'
             AND NOT (COALESCE(m.score,0) >= 0.7 AND COALESCE(m.reps,0) >= 2)
             AND sc.concept_id NOT IN
                 (SELECT concept_id FROM attempts WHERE session_id = @sid)) AS candidates,
         -- Spent budget. Every attempt counts, wherever it was asked: a question
         -- the Stop hook already got answered is one this hook must not re-spend.
         (SELECT count(*) FROM attempts WHERE session_id = @sid) AS spent,
         -- Both clocks, for the same reason stop-quiz-check.ts checks both: a
         -- checkpoint stamped without a question ever being asked (the model
         -- ignored us) should still pace the next one, and an answer given
         -- without a checkpoint (the Stop hook ran, or the developer asked for a
         -- quiz) should too.
         (SELECT last_checkpoint_at FROM checkpoints WHERE session_id = @sid) AS last_checkpoint,
         (SELECT ts FROM attempts WHERE session_id = @sid ORDER BY id DESC LIMIT 1) AS last_answer`,
    )
    .get({ sid }) as
    | { candidates: number; spent: number; last_checkpoint: string | null; last_answer: string | null }
    | undefined;

  if (!stats) return 0;

  // Nothing unmastered and unasked. Concepts already attempted this session are
  // excluded above -- they have had their turn.
  if (stats.candidates <= 0) return 0;

  // --- the burst guard -------------------------------------------------------
  if (stats.spent >= max_questions_per_task) return 0;
  if (minutesSince(stats.last_checkpoint) < min_minutes_between_checkpoints) return 0;
  if (minutesSince(stats.last_answer) < min_minutes_between_checkpoints) return 0;
  // ---------------------------------------------------------------------------

  // The concept most recently logged, not the oldest. The Stop hook orders ASC
  // because it is sweeping up a whole session; this hook is asking about the code
  // that was just written, and the last row is the one the call that triggered us
  // put there.
  const row = db
    .prepare(
      `SELECT c.slug || COALESCE(' (' || sc.context || ')', '') AS concept
         FROM session_concepts sc
         JOIN concepts c ON c.id = sc.concept_id
         LEFT JOIN mastery m ON m.concept_id = c.id
        WHERE sc.session_id = @sid
          AND COALESCE(sc.origin,'work') = 'work'
          AND NOT (COALESCE(m.score,0) >= 0.7 AND COALESCE(m.reps,0) >= 2)
          AND sc.concept_id NOT IN
              (SELECT concept_id FROM attempts WHERE session_id = @sid)
        ORDER BY sc.ts DESC, sc.rowid DESC
        LIMIT 1`,
    )
    .get({ sid }) as { concept: string } | undefined;

  if (!row?.concept) return 0;

  // Stamp BEFORE emitting. If anything below fails the worst case is a missed
  // question; stamping after would let a crash between the two re-fire on the very
  // next tool call, which is the burst this file exists to prevent.
  db.prepare(
    `INSERT INTO checkpoints (session_id, last_checkpoint_at, count)
     VALUES (@sid, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)
     ON CONFLICT(session_id) DO UPDATE SET
       last_checkpoint_at = excluded.last_checkpoint_at,
       count              = checkpoints.count + 1`,
  ).run({ sid });

  const remaining = max_questions_per_task - stats.spent;
  const framing = framingFor(focus, focus_topic, 'checkpoint');

  // Which seam this is. Right after logging, the concept is the one just named;
  // on a work tool it was named earlier in the task, and "you just logged" would
  // be a false statement the model then repeats to the developer.
  const justLogged = /log_session_concepts$/.test(input.tool_name ?? '');
  const lead = justLogged
    ? 'You just logged a concept. Before writing another line, ask'
    : 'The work has moved on since the last question. Before the next step, ask';

  const context = `[Eklavya checkpoint] ${lead} the developer ONE question about it -- this is the whole point of the tool: they learn while you work, not in a pile at the end.

Concept: ${row.concept}

Do exactly this, then get straight back to the task:
  1. get_session_quiz_plan with max: 1 and ignore_cooldown: true (the pacing is already decided -- this hook is the cooldown).
  2. Ask that ONE question with AskUserQuestion: four options, one correct, three plausible, and put the correct one in the slot answer_position names.
     ${attributionRule()}
  3. Grade it with record_attempt: format "mcq", the labels in "options", the stem alone in "question".
  4. Tell them the verdict: right, or wrong and what the right answer is, with one line of why. Never skip this -- an answer with no verdict teaches nothing.
  5. Resume the task exactly where you left off. Do not summarise, do not re-plan, do not ask a second question.

ONE question. Not two, not the whole plan. ${remaining} left in this session's budget, and the Stop hook spends whatever you do not.
${framing}
If they pick Other or say skip, record it as grade 0, teach the answer in two lines, and carry on. Do not ask again.`;

  // exit 0 + JSON, not exit 2 + stderr: exit 2 renders to the developer as a hook
  // warning -- an error face on a feature that is working. The Stop sweep reached
  // the same conclusion later and by the same route. So: additionalContext
  // carries the instruction to the model, systemMessage tells the human why their
  // agent just stopped to ask them something. `systemMessage` is a top-level
  // field: it sat inside `hookSpecificOutput` for months, where the harness drops
  // it, so the developer never saw that line at all.
  countUse(db, 'quiz:checkpoint');
  process.stdout.write(
    `${JSON.stringify({
      systemMessage: 'Eklavya: quick question on what you just built',
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: context,
      },
    })}\n`,
  );
  return 0;
});
