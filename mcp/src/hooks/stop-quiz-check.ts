/**
 * Stop: turn a finished task into a quiz, at most once per batch of work.
 *
 * How much of a quiz is the cadence's call, not this file's. Under `interleaved`
 * this sweep asks exactly one question: that setting promises a question at the
 * seam where the work happened, and a sweep that ends the task with three in a
 * row is precisely the pile-up it was sold as replacing. Under `end`, or in
 * enforced mode where the gate needs a quiz it can actually pass, it asks for
 * whatever is left of the budget.
 *
 * Continuing the turn is `hookSpecificOutput.additionalContext` on stdout, at
 * exit 0 (deviation D1). Exit 2 does the same job, but the harness renders it as
 * a hook *error*: a wall of red naming run.mjs and a stack of instructions
 * addressed to the model, for a feature that is working exactly as designed.
 * `additionalContext` runs through the same loop protections — `stop_hook_active`
 * and the harness's 8-continuation cap — and the transcript labels it
 * "Stop hook feedback" with no error notification.
 *
 * THE LOOP GUARD IS THE POINT OF THIS FILE.
 * `stop_hook_active` is no longer a documented input (deviation D2), so nothing
 * here may depend on the harness noticing we already blocked. What keeps this
 * finite depends on the cadence, because the two cadences block for different
 * reasons:
 *
 *   `end`      block only when the number of concepts logged for this session
 *              has GROWN since the last block. Blocking stamps the current
 *              count, so a Stop that follows with the same count does not
 *              block, whatever happened in between — quiz answered, quiz
 *              skipped, model ignored us entirely.
 *
 *   `interleaved`  block whenever the pacing clock has elapsed. This cadence
 *              asks one question per block and means to ask several across a
 *              task, and the `end` rule cannot deliver that: the model logs its
 *              whole batch in one call, so "new work since the last block" is
 *              false for the rest of the session and the sweep fired once, ever.
 *
 * Neither can run away. Three caps bound every block: the pacing clock
 * (`min_minutes_between_checkpoints` here, `min_minutes_between_quizzes` under
 * `end`), `max_stop_blocks_per_session`, and the remaining session budget.
 */
import { attributionRule, isCowork } from '../surface.js';
import { run, openExisting, config, cwdOf, sessionId, minutesSince, framingFor } from './lib.js';
import { isSessionOff } from '../session.js';
import { flushAtSeam, identityOf } from './memory-lib.js';

await run(async (input) => {
  // Same fast path as checkpoint-quiz.ts, and for a stronger reason: this hook
  // continues the turn. `Stop` is believed to be parent-only -- `SubagentStop`
  // is a separate event -- but nothing in this repo has verified that, and the
  // cost of being wrong is a subagent told to run a quiz it has no
  // AskUserQuestion to ask, in a transcript nobody reads, up to
  // max_stop_blocks_per_session times. subagent-start.ts is what made that
  // reachable: before it, a subagent logged nothing, so the `logged > last_logged`
  // predicate below could never arm.
  if (input.agent_id) return 0;

  const db = openExisting();
  if (!db) return 0;

  // Belt and braces: honor it if the harness still sends it, depend on it never.
  if (input.stop_hook_active === true) return 0;

  const cwd = cwdOf(input);
  const sid = sessionId(input, db);
  if (!sid) return 0;

  // The end of a turn is the natural seam: close the open batch and summarise
  // it. Before every learning gate below, because memory is not governed by
  // them, and before the block decision, because whether a question is asked
  // must not change what gets remembered. With a provider configured this only
  // queues -- a Stop hook does not wait on an API call (PRD LRN-04).
  const stopConfig = config(cwd);
  if (stopConfig.config.memory.enabled) {
    await flushAtSeam(db, stopConfig, identityOf(input, cwd, sid));
  }
  // Silenced sessions are never blocked, enforced mode included: the commit gate
  // is what enforced mode is for, and it reads .eklavya.json rather than this.
  if (isSessionOff(db, sid)) return 0;

  const {
    mode,
    cadence,
    focus,
    focus_topic,
    max_questions_per_task,
    max_stop_blocks_per_session,
    min_minutes_between_quizzes,
    min_minutes_between_checkpoints,
  } = config(cwd).config;

  if (mode === 'off') return 0;

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
                 (SELECT concept_id FROM attempts WHERE session_id = @sid)) AS unmastered,
         -- 'work' only, and the loop guard depends on it: record_attempt inserts a
         -- session_concepts row for anything it is quizzed on, so counting review
         -- rows here would let answering a question re-arm the block that asked it.
         (SELECT count(*) FROM session_concepts
           WHERE session_id = @sid AND COALESCE(origin,'work') = 'work') AS logged,
         COALESCE((SELECT last_logged_count FROM stop_markers WHERE session_id = @sid), -1) AS last_logged,
         COALESCE((SELECT block_count FROM stop_markers WHERE session_id = @sid), 0) AS blocks,
         (SELECT last_blocked_at FROM stop_markers WHERE session_id = @sid) AS last_blocked,
         (SELECT ts FROM attempts WHERE session_id = @sid ORDER BY id DESC LIMIT 1) AS last_answer,
         -- Budget already spent, wherever it was spent. Since 1.4 the mid-work
         -- checkpoint hook asks from the same allowance, so this is what turns the
         -- Stop quiz from a fixed batch of four into a sweep of whatever is left.
         (SELECT count(*) FROM attempts WHERE session_id = @sid) AS spent`,
    )
    .get({ sid }) as
    | {
        unmastered: number;
        logged: number;
        last_logged: number;
        blocks: number;
        last_blocked: string | null;
        last_answer: string | null;
        spent: number;
      }
    | undefined;

  if (!stats) return 0;

  // Nothing worth asking about. Concepts already answered in this session are
  // excluded above: they have had their turn, and re-offering them is exactly the
  // "asked me the same thing twice" failure this tool exists to avoid.
  if (stats.unmastered <= 0) return 0;

  // Under `interleaved` this sweep asks exactly ONE question (see `take` below),
  // so it is paced by the single-question clock rather than the whole-quiz one.
  // Enforced mode is exempt from both, as it always was (decision G5).
  const interleaved = cadence === 'interleaved' && mode !== 'enforced';

  // --- the pacing clock ------------------------------------------------------
  // Ambient mode respects the quiz cadence. Enforced mode must not, or a cooldown
  // could make a commit gate unpassable (decision G5).
  //
  // Which clock depends on what is being paced. `min_minutes_between_quizzes` is
  // the anti-nagging floor between whole quizzes, and under `end` that is exactly
  // what a sweep is. Under `interleaved` a sweep is one question, so gating it on
  // the quiz clock is a category error -- and it was the bug: a 20-minute floor
  // measured from the last *answer* meant the checkpoint question the learner had
  // just answered silenced the sweep for the rest of a typical task, so a session
  // that logged eight concepts was asked one.
  //
  // Both clocks matter, and for the same reason. get_session_quiz_plan applies its
  // cooldown from the last *answer*; this hook stamps the last *block*. Checking
  // only the block would let us block a turn that the quiz plan then refuses as
  // too soon, which reads to the model as being told to teach and given nothing to
  // teach. Whichever happened more recently wins. The plan reads whichever of the
  // two keys this line does, keyed on the same cadence, so the pair cannot desync.
  //
  // Floored at one minute under `interleaved`, because there the clock is the only
  // loop guard left (see below) and `min_minutes_between_checkpoints: 0` is a
  // supported value -- it means "ask at every seam" for the PostToolUse checkpoint,
  // which has a logged concept behind each firing. A Stop sweep has no such event:
  // at a gap of 0 a model that ignores the instruction and stops again immediately
  // gets blocked again immediately, three times in a row with no pause.
  if (mode === 'ambient') {
    const gap = interleaved
      ? Math.max(1, min_minutes_between_checkpoints)
      : min_minutes_between_quizzes;
    if (minutesSince(stats.last_blocked) < gap) return 0;
    if (minutesSince(stats.last_answer) < gap) return 0;
  }
  // ---------------------------------------------------------------------------

  // --- the loop guard --------------------------------------------------------
  // Under `interleaved` the clock above IS this guard, and it has to be: the
  // `logged > last_logged` rule re-arms only on newly logged work, and the model
  // logs its whole batch in one call at the start of a task. That made the sweep
  // a once-per-session event no matter how long the session ran -- a ceiling of
  // two questions against a budget of four. Time re-arms it instead, and three
  // existing caps keep it finite: `gap` minutes between blocks,
  // `max_stop_blocks_per_session`, and `remaining` below.
  //
  // Under `end` the original rule stands. That cadence delivers the whole budget
  // in one sweep, so a second sweep genuinely does need new work behind it.
  if (!interleaved && !(stats.logged > stats.last_logged)) return 0;
  if (stats.blocks >= max_stop_blocks_per_session) return 0;
  // ---------------------------------------------------------------------------

  // --- what is left of the session budget ------------------------------------
  // `max_questions_per_task` is a SESSION allowance, not an end-of-session batch
  // size. Every question answered while the agent was working is one this hook
  // must not ask again -- that is the whole trade the interleaved cadence makes,
  // and without this subtraction it would be a lie: four questions mid-task and
  // then four more at the end is worse than what it replaced.
  //
  // Answer the whole budget during the work and the Stop hook says nothing at all.
  const remaining = max_questions_per_task - stats.spent;
  if (remaining <= 0) return 0;
  // ---------------------------------------------------------------------------

  // How many of those to ask here. Under `interleaved` the answer is always one:
  // that cadence promises a question at a time, at the seam where the concept was
  // logged, and a sweep that ends the task with three questions in a row is the
  // thing it was sold as replacing. What the sweep leaves unasked is not lost --
  // the plan's `backlog` source offers it again in a later session. Note that
  // spaced repetition does NOT cover it: `mastery` rows are written only by
  // record_attempt, so a concept never asked has no next_review to come due on.
  // Under `end`, a batch is the setting. Enforced mode is exempt, as it is from
  // the cooldown (decision G5): the gate needs several passing answers, so pacing
  // it to one would leave a commit that cannot be made.
  const take = interleaved ? 1 : remaining;

  const rows = db
    .prepare(
      `SELECT c.slug || COALESCE(' (' || sc.context || ')', '') AS line
         FROM session_concepts sc
         JOIN concepts c ON c.id = sc.concept_id
         LEFT JOIN mastery m ON m.concept_id = c.id
        WHERE sc.session_id = @sid
          AND COALESCE(sc.origin,'work') = 'work'
          AND NOT (COALESCE(m.score,0) >= 0.7 AND COALESCE(m.reps,0) >= 2)
          AND sc.concept_id NOT IN
              (SELECT concept_id FROM attempts WHERE session_id = @sid)
        ORDER BY sc.ts ASC
        LIMIT @take`,
    )
    .all({ sid, take }) as Array<{ line: string }>;

  const concepts = rows.map((r) => r.line).join('; ');

  // Stamp the guard BEFORE blocking. If anything below fails, the worst case is a
  // missed quiz — never a loop.
  db.prepare(
    `INSERT INTO stop_markers (session_id, last_blocked_at, last_logged_count, block_count)
     VALUES (@sid, strftime('%Y-%m-%dT%H:%M:%fZ','now'), @logged, 1)
     ON CONFLICT(session_id) DO UPDATE SET
       last_blocked_at   = excluded.last_blocked_at,
       last_logged_count = excluded.last_logged_count,
       block_count       = stop_markers.block_count + 1`,
  ).run({ sid, logged: stats.logged });

  const framing = framingFor(focus, focus_topic, 'stop');
  // What the model is being asked for, in the words of the cadence it is running
  // under. `interleaved` gets a hard singular -- the plan will hand back exactly
  // one item, and prose that still says "each question" reads as licence to go
  // looking for more.
  const ask =
    take === 1
      ? `Use the eklavya MCP server and the tutor skill: call get_session_quiz_plan,
ask the ONE question it returns at that concept's tier_to_ask, and grade it with
record_attempt. One question, then let them finish -- there is no second one to
come back for. The plan returns a "framing" field. Follow it.`
      : `Use the eklavya MCP server and the tutor skill: call get_session_quiz_plan, ask
ONE question at a time at each concept's tier_to_ask, and grade each answer with
record_attempt. The plan returns a "framing" field. Follow it.`;
  // The enforced line names the commit gate as the reason to press, which is
  // true everywhere the gate can fire. On Cowork it cannot — it matches `git
  // commit`, and Cowork does not commit — and session-start has already told
  // this session that nothing is blocked. Saying both things in one session
  // teaches the learner that Eklavya's warnings need not be read carefully, so
  // the enforced framing drops to why the quiz still matters there.
  const tone =
    mode === 'enforced'
      ? isCowork()
        ? 'This session is in enforced mode. Nothing is blocked here — Cowork does not commit — but the gate still records what was answered, so ask properly.'
        : 'This session is in enforced mode: the commit gate needs this quiz.'
      : 'If they say skip, record it as grade 0 and let them go — do not ask twice.';

  const context = `Eklavya: before finishing, quiz the developer on what this task just taught.

Concepts: ${concepts}

${ask}

Ask each question as MULTIPLE CHOICE via the AskUserQuestion tool: four options,
one correct and three plausible, the correct one in the slot answer_position
names.
${attributionRule()}
The tool's own "Other" choice is the escape hatch for "I don't know". They are
mid-task -- a blank prompt gets skipped whether or not they knew the answer.
Record with format "mcq", the labels in "options", and only the stem in
"question".
${framing}
${tone}
`;

  // exit 0 + JSON, not exit 2 + stderr. Both continue the turn and both pass
  // through the same loop protections; only one of them tells the developer
  // their session just hit an error. No `systemMessage` -- that field is a
  // warning banner too, and the hook already has a `statusMessage`.
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: context },
    })}\n`,
  );
  return 0;
});
