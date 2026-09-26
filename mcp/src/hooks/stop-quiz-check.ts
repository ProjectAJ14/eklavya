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
import { isCowork } from '../surface.js';
import { run, openExisting, config, cwdOf, sessionId, minutesSince } from './lib.js';
import { isSessionOff } from '../session.js';
import { flushAtSeam, identityOf, record, wrapUpAtSeam } from './memory-lib.js';
import { fillOmissions } from '../memory/learning.js';
import { dueInProject, sessionConcepts } from '../store.js';
import { countUse } from '../telemetry.js';
import { sessionChangedCode } from './changes-lib.js';
import { recentWorkSql } from '../time.js';

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
    const identity = identityOf(input, cwd, sid);
    // The turn's conclusion, before the batch closes so it is summarised with
    // the work it concludes. Tool events say what was done; this is where the
    // agent says what it found and decided — "the root cause is X" lives here
    // and nowhere else. Parent only: a subagent's report reaches the parent as
    // a tool result, which capture already keeps.
    const said = typeof input.last_assistant_message === 'string' ? input.last_assistant_message.trim() : '';
    if (said && !input.agent_id) record(db, stopConfig, identity, { kind: 'assistant', title: 'assistant', body: said });
    await flushAtSeam(db, stopConfig, identity);
    // Only for a session that logged nothing at all. A session that logged
    // properly is left alone: the model's own account of what it wrote beats
    // anything derived from tool arguments, and adding guesses to it would
    // quiz the developer on the shape of the evidence rather than on the work.
    try {
      fillOmissions(db, stopConfig.config, sid, identity.project);
    } catch {
      /* A session with nothing to ask about is the status quo, not a failure. */
    }
    // Writes the session's summary entry, then announces the wrap-up if a sink
    // is configured -- which is not the default, and the summary must not wait
    // on it. Gating memory on an announcement channel means nobody ever gets one.
    await wrapUpAtSeam(db, stopConfig, identity);
  }
  // Silenced sessions are never blocked, enforced quizzing included: the commit
  // gate is what `quiz.enforced` is for, and it reads the project config rather
  // than this.
  if (isSessionOff(db, sid)) return 0;

  const {
    quiz,
    cadence,
    focus,
    max_questions_per_task,
    max_stop_blocks_per_session,
    min_minutes_between_quizzes,
    min_minutes_between_checkpoints,
  } = stopConfig.config;
  const { repoRoot } = stopConfig;

  if (!quiz.enabled) return 0;

  // The same recent-work window as checkpoint-quiz.ts, for the same reason,
  // and the same exemption for an enforced gate.
  const recent = quiz.enforced ? '' : `AND ${recentWorkSql('sc.ts')}`;

  const stats = db
    .prepare(
      `SELECT
         (SELECT count(*) FROM session_concepts sc
            JOIN concepts c ON c.id = sc.concept_id
            LEFT JOIN mastery m ON m.concept_id = c.id
           WHERE sc.session_id = @sid
             AND COALESCE(sc.origin,'work') = 'work'
             ${recent}
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

  // Nothing of this session's own worth asking about. Concepts already answered
  // in this session are excluded above: they have had their turn, and
  // re-offering them is exactly the "asked me the same thing twice" failure this
  // tool exists to avoid.
  //
  // Then fall back to what this project already asked that is due again --
  // the questions the learner declined, blanked on or missed come back here.
  // Same helper and scope as the plan, so a block here is a plan there. Never
  // under `quiz.enforced`, where an open gate asks only this session's work,
  // nor under `learn` focus, where the plan asks from the topic instead.
  let due: string[] = [];
  if (stats.unmastered <= 0) {
    if (quiz.enforced || focus === 'learn') return 0;
    const domains = [...new Set(sessionConcepts(db, sid).map((c) => c.domain))];
    due = dueInProject(db, repoRoot, new Date(), domains, max_questions_per_task).map((c) => c.slug);
    if (due.length === 0) return 0;
  }

  // Under `interleaved` this sweep asks exactly ONE question (see `take` below),
  // so it is paced by the single-question clock rather than the whole-quiz one.
  // Enforced quizzing is exempt from both, as it always was (decision G5).
  const interleaved = cadence === 'interleaved' && !quiz.enforced;

  // --- the pacing clock ------------------------------------------------------
  // Unenforced quizzing respects the cadence. Enforced must not, or a cooldown
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
  if (!quiz.enforced) {
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
  // thing it was sold as replacing. What the sweep leaves unasked is dropped
  // when the session ends (`pruneUnasked`): it was never shown, so nobody owes
  // an answer to it.
  // Under `end`, a batch is the setting. Enforced mode is exempt, as it is from
  // the cooldown (decision G5): the gate needs several passing answers, so pacing
  // it to one would leave a commit that cannot be made.
  const take = interleaved ? 1 : remaining;

  // A session that only read and searched has nothing new to ask about, and
  // that includes review: research is not the moment to be quizzed on an
  // earlier session's work. Enforced quizzing is exempt -- the gate exists for
  // commits, and a commit is a change. Last among the guards because it spawns
  // git, and before the stamp so a skipped sweep spends no block.
  if (quiz.only_on_changes && !quiz.enforced && !sessionChangedCode(db, sid, cwd)) return 0;

  const rows = db
    .prepare(
      `SELECT c.slug || COALESCE(' (' || sc.context || ')', '') AS line
         FROM session_concepts sc
         JOIN concepts c ON c.id = sc.concept_id
         LEFT JOIN mastery m ON m.concept_id = c.id
        WHERE sc.session_id = @sid
          AND COALESCE(sc.origin,'work') = 'work'
          ${recent}
          AND NOT (COALESCE(m.score,0) >= 0.7 AND COALESCE(m.reps,0) >= 2)
          AND sc.concept_id NOT IN
              (SELECT concept_id FROM attempts WHERE session_id = @sid)
        ORDER BY sc.ts DESC, sc.rowid DESC
        LIMIT @take`,
    )
    .all({ sid, take }) as Array<{ line: string }>;

  const concepts = (due.length ? due.slice(0, take) : rows.map((r) => r.line)).join('; ');

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

  // What the model is being asked for, in the words of the cadence it is running
  // under. `interleaved` gets a hard singular -- the plan will hand back exactly
  // one item, and prose that still says "each question" reads as licence to go
  // looking for more.
  const ask =
    take === 1
      ? 'One question, then let them finish -- there is no second one to come back for.'
      : `Ask ONE question at a time, up to ${take}.`;
  // The enforced line names the commit gate as the reason to press, which is
  // true everywhere the gate can fire. On Cowork it cannot — it matches `git
  // commit`, and Cowork does not commit — and session-start has already told
  // this session that nothing is blocked. Saying both things in one session
  // teaches the learner that Eklavya's warnings need not be read carefully, so
  // the enforced framing drops to why the quiz still matters there.
  const tone =
    quiz.enforced
      ? isCowork()
        ? 'Quizzing is enforced here. Nothing is blocked — Cowork does not commit — but the gate still records what was answered.'
        : 'Quizzing is enforced in this session: the commit gate needs this quiz.'
      : 'If they say skip, record grade 0 and let them go — do not ask twice.';

  // EVERY LINE BELOW IS PRINTED TO THE DEVELOPER, VERBATIM.
  // The harness renders a Stop hook's `additionalContext` under "Ran N stop
  // hooks" in gold, wrapped and effectively untruncated (`stop_hook_summary` in
  // the 2.1.278 bundle), and there is no field that hides it — `suppressOutput`
  // does not reach this path. So length is the only lever there is, and the page
  // of model-facing instructions this used to be was Eklavya reciting its own
  // prompt at the person it is meant to be teaching, every single task.
  //
  // Say only what this hook alone knows -- which concepts, how big the sweep,
  // whether the gate is pressing -- and let `get_session_quiz_plan` carry the
  // rest. It already returns `framing`, `ask_attribution`, `answer_position` and
  // `tier_to_ask` with every plan, and the next thing the model does is call it,
  // so repeating any of that here buys nothing and costs the developer a screen.
  // Review has no code on screen, and the plan's `framing` still says to ground
  // the question in the diff -- so say which one this is.
  const what = due.length
    ? `Eklavya: quiz the developer on an earlier question from this project that is due again -- ask about the idea itself, the code is not on screen. ${ask}`
    : `Eklavya: quiz the developer on what this task taught. ${ask}`;
  const context = `${what}
Concepts: ${concepts}
get_session_quiz_plan, then AskUserQuestion, then record_attempt (format "mcq", labels in "options", stem alone in "question"), then tell them whether they were right before anything else. The plan's framing, ask_attribution, answer_position and tier_to_ask are the rules — follow them. ${tone}`;

  // exit 0 + JSON, not exit 2 + stderr. Both continue the turn and both pass
  // through the same loop protections; only one of them tells the developer
  // their session just hit an error. No `systemMessage` -- that field is a
  // warning banner too, and the hook already has a `statusMessage`.
  countUse(db, 'quiz:stop');
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: context },
    })}\n`,
  );
  return 0;
});
