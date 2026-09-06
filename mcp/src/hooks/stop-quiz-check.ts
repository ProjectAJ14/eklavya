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
 * Blocking is exit 2 with the reason on stderr (deviation D1) — the current hooks
 * reference documents no Stop-specific JSON envelope, but does document that
 * exit 2 prevents stopping and uses stderr as the message.
 *
 * THE LOOP GUARD IS THE POINT OF THIS FILE.
 * `stop_hook_active` is no longer a documented input (deviation D2), so nothing
 * here may depend on the harness noticing we already blocked. The rule that keeps
 * this finite:
 *
 *   block only when the number of concepts logged for this session has GROWN
 *   since the last block.
 *
 * Blocking stamps the current count. A Stop that follows with the same count does
 * not block, whatever happened in between — quiz answered, quiz skipped, model
 * ignored us entirely. Only genuinely new logged work re-arms it, and
 * `block_count` caps even that.
 */
import { run, openExisting, config, cwdOf, sessionId, minutesSince, framingFor } from './lib.js';

await run(async (input) => {
  // Same fast path as checkpoint-quiz.ts, and for a stronger reason: this hook
  // blocks with exit 2. `Stop` is believed to be parent-only -- `SubagentStop`
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

  const {
    mode,
    cadence,
    focus,
    focus_topic,
    max_questions_per_task,
    max_stop_blocks_per_session,
    min_minutes_between_quizzes,
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

  // --- the loop guard --------------------------------------------------------
  if (!(stats.logged > stats.last_logged)) return 0;
  if (stats.blocks >= max_stop_blocks_per_session) return 0;

  // Ambient mode respects the quiz cadence. Enforced mode must not, or a cooldown
  // could make a commit gate unpassable (decision G5).
  //
  // Both clocks matter, and for the same reason. get_session_quiz_plan applies its
  // cooldown from the last *answer*; this hook stamps the last *block*. Checking
  // only the block would let us block a turn that the quiz plan then refuses as
  // too soon, which reads to the model as being told to teach and given nothing to
  // teach. Whichever happened more recently wins.
  if (mode === 'ambient') {
    if (minutesSince(stats.last_blocked) < min_minutes_between_quizzes) return 0;
    if (minutesSince(stats.last_answer) < min_minutes_between_quizzes) return 0;
  }
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
  // the concept stays unmastered and comes back as review in a later session,
  // which is what spaced repetition is for. Under `end`, a batch is the setting.
  // Enforced mode is exempt, as it is from the cooldown (decision G5): the gate
  // needs several passing answers and this hook only re-arms when new work is
  // logged, so pacing it to one would leave a commit that cannot be made.
  const take = cadence === 'interleaved' && mode !== 'enforced' ? 1 : remaining;

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
  const tone =
    mode === 'enforced'
      ? 'This session is in enforced mode: the commit gate needs this quiz.'
      : 'If they say skip, record it as grade 0 and let them go — do not ask twice.';

  process.stderr.write(`Eklavya: before finishing, quiz the developer on what this task just taught.

Concepts: ${concepts}

${ask}

Ask each question as MULTIPLE CHOICE via the AskUserQuestion tool: four options,
one correct and three plausible, the correct one in the slot answer_position
names, header "Eklavya" so it is clear who is asking.
The tool's own "Other" choice is the escape hatch for "I don't know". They are
mid-task -- a blank prompt gets skipped whether or not they knew the answer.
Ask the stem on its own. The dials that pitched it -- mode, focus, cadence,
level -- are in the status bar, so what you ask is the question and nothing
else.
Record with format "mcq", the labels in "options", and only the stem in
"question".
${framing}
${tone}
`);

  return 2;
});
