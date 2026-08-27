#!/bin/sh
# PostToolUse(log_session_concepts): ask ONE question, here, now, mid-task.
#
# This is the hook that makes the pitch literal. Everything else in Eklavya
# quizzes at Stop, which means the developer is asked four questions at the exact
# moment they wanted to be finished -- learning bolted onto the end of the work
# rather than happening during it. The seam this fires on is the best one
# available: the model has just told the server "this task exercises
# jwt-verification, and here is the line where", so the code that teaches the
# concept is still on screen and still in context. A question asked there costs
# seconds. The same question asked twenty minutes later costs a re-read.
#
# THE BURST GUARD IS THE POINT OF THIS FILE, exactly as the loop guard is the
# point of stop-quiz-check.sh -- but it guards a different failure. That one
# stops an end-of-turn loop; this one stops a mid-turn pile-up. The model logs
# concepts in batches of 3-8 and may call the tool several times in one task, so
# the naive version asks eight questions in a row and gets uninstalled. Three
# rules keep it to a trickle:
#
#   1. one question per checkpoint, never a batch (max: 1, and we say so);
#   2. min_minutes_between_checkpoints since the last one, wall clock;
#   3. the session budget is max_questions_per_task, shared with the Stop hook.
#
# Rule 3 is why this does not add questions, it moves them. Every answer here is
# an `attempts` row, and stop-quiz-check.sh subtracts those from its own budget.
# Answer the lot while the agent works and the Stop hook says nothing at all.
#
# Failure is always silent: exit 0, no output. A missed question is nothing; a
# hook that errors on every tool call is a plugin nobody keeps.

. "$(dirname "$0")/lib.sh"

INPUT=$(cat 2>/dev/null) || exit 0

# --- fast path ---------------------------------------------------------------
# PostToolUse fires on every matching call, so the cheap disqualifiers come
# first, before jq or sqlite3 is worth spawning.
#
# `agent_id` is present only inside a subagent, and a subagent cannot ask the
# developer anything -- AskUserQuestion is not in its toolset, and the human is
# not watching that transcript. Checkpointing there would burn a question from
# the budget on a prompt nobody ever sees.
case "$INPUT" in
  *'"agent_id"'*) exit 0 ;;
esac
# -----------------------------------------------------------------------------

eklavya_have_deps || exit 0

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$CWD" ] && CWD=$PWD

MODE=$(eklavya_config mode ambient "$CWD")
[ "$MODE" = "off" ] && exit 0

# The whole feature behind one switch. `end` is the pre-1.4 behaviour: silence
# until Stop.
[ "$(eklavya_config cadence interleaved "$CWD")" = "interleaved" ] || exit 0

# EKLAVYA_SESSION_ID wins when set, so two panes sharing one task (see
# docs/parallel-tutoring.md) agree on a session id even though Claude Code gives
# each pane its own. Unset in normal use, where the harness id is authoritative.
SESSION_ID=${EKLAVYA_SESSION_ID:-}
if [ -z "$SESSION_ID" ]; then
  SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
fi
if [ -z "$SESSION_ID" ]; then
  SESSION_ID=$(eklavya_sql "SELECT value FROM meta WHERE key = 'current_session';")
fi
[ -z "$SESSION_ID" ] && exit 0

SID=$(printf '%s' "$SESSION_ID" | sed "s/'/''/g")

# One query for every number this decision needs.
#
# The candidate count and the concept line below share their WHERE clause with
# stop-quiz-check.sh, and must: a concept this hook considers unaskable is one
# the Stop hook has to catch, and the two disagreeing is how a learner gets asked
# about something twice or never.
STATS=$(eklavya_sql "
  SELECT
    (SELECT count(*) FROM session_concepts sc
       JOIN concepts c ON c.id = sc.concept_id
       LEFT JOIN mastery m ON m.concept_id = c.id
      WHERE sc.session_id = '$SID'
        AND COALESCE(sc.origin,'work') = 'work'
        AND NOT (COALESCE(m.score,0) >= 0.7 AND COALESCE(m.reps,0) >= 2)
        AND sc.concept_id NOT IN
            (SELECT concept_id FROM attempts WHERE session_id = '$SID'))
    || '|' ||
    -- Spent budget. Every attempt counts, wherever it was asked: a question the
    -- Stop hook already got answered is one this hook must not re-spend.
    (SELECT count(*) FROM attempts WHERE session_id = '$SID')
    || '|' ||
    -- Minutes since the last checkpoint AND since the last answer. Both, for the
    -- same reason stop-quiz-check.sh checks both clocks: a checkpoint stamped
    -- without a question ever being asked (the model ignored us) should still
    -- pace the next one, and an answer given without a checkpoint (the Stop hook
    -- ran, or the developer asked for a quiz) should too.
    COALESCE((SELECT CAST((julianday('now') - julianday(last_checkpoint_at)) * 1440 AS INTEGER)
                FROM checkpoints WHERE session_id = '$SID'), 999999)
    || '|' ||
    COALESCE((SELECT CAST((julianday('now') - julianday(ts)) * 1440 AS INTEGER)
                FROM attempts WHERE session_id = '$SID' ORDER BY id DESC LIMIT 1), 999999);")

[ -z "$STATS" ] && exit 0

CANDIDATES=$(printf '%s' "$STATS" | cut -d'|' -f1)
SPENT=$(printf '%s' "$STATS" | cut -d'|' -f2)
MINS_SINCE_CHECKPOINT=$(printf '%s' "$STATS" | cut -d'|' -f3)
MINS_SINCE_ANSWER=$(printf '%s' "$STATS" | cut -d'|' -f4)

# Nothing unmastered and unasked. Concepts already attempted this session are
# excluded above -- they have had their turn.
[ "$CANDIDATES" -gt 0 ] 2>/dev/null || exit 0

# --- the burst guard ---------------------------------------------------------
BUDGET=$(eklavya_config max_questions_per_task 4 "$CWD")
[ "$SPENT" -lt "$BUDGET" ] 2>/dev/null || exit 0

GAP=$(eklavya_config min_minutes_between_checkpoints 4 "$CWD")
[ "$MINS_SINCE_CHECKPOINT" -ge "$GAP" ] 2>/dev/null || exit 0
[ "$MINS_SINCE_ANSWER" -ge "$GAP" ] 2>/dev/null || exit 0
# -----------------------------------------------------------------------------

# The concept most recently logged, not the oldest. The Stop hook orders ASC
# because it is sweeping up a whole session; this hook is asking about the code
# that was just written, and the last row is the one the call that triggered us
# put there.
CONCEPT=$(eklavya_sql "
  SELECT c.slug || COALESCE(' (' || sc.context || ')', '')
    FROM session_concepts sc
    JOIN concepts c ON c.id = sc.concept_id
    LEFT JOIN mastery m ON m.concept_id = c.id
   WHERE sc.session_id = '$SID'
     AND COALESCE(sc.origin,'work') = 'work'
     AND NOT (COALESCE(m.score,0) >= 0.7 AND COALESCE(m.reps,0) >= 2)
     AND sc.concept_id NOT IN
         (SELECT concept_id FROM attempts WHERE session_id = '$SID')
   ORDER BY sc.ts DESC, sc.rowid DESC
   LIMIT 1;")

[ -z "$CONCEPT" ] && exit 0

# Stamp BEFORE emitting. If anything below fails the worst case is a missed
# question; stamping after would let a crash between the two re-fire on the very
# next tool call, which is the burst this file exists to prevent.
eklavya_sql "
  INSERT INTO checkpoints (session_id, last_checkpoint_at, count)
  VALUES ('$SID', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)
  ON CONFLICT(session_id) DO UPDATE SET
    last_checkpoint_at = excluded.last_checkpoint_at,
    count              = checkpoints.count + 1;" >/dev/null

REMAINING=$((BUDGET - SPENT))

# Focus framing, stated here for the same reason stop-quiz-check.sh states it:
# the tutor skill is model-invoked and may never have loaded, and without this an
# ambient session teaches whatever the default is rather than what was configured.
FOCUS=$(eklavya_config focus concept "$CWD")
TOPIC=$(eklavya_config focus_topic "" "$CWD")
case "$FOCUS" in
  concept)
    FRAMING="Focus is 'concept': open from the code you just wrote, then ask for the general rule -- the answer must be usable on a different codebase."
    ;;
  learn)
    if [ -n "$TOPIC" ]; then
      FRAMING="Focus is 'learn' on \"$TOPIC\": ask the next thing in that topic. Use the code you just wrote as the worked example only where it genuinely overlaps."
    else
      FRAMING="Focus is 'learn' but no focus_topic is set. Skip the question and say so."
    fi
    ;;
  *)
    FRAMING="Focus is 'project': ground the question in the code you just wrote -- the file, the line, the decision."
    ;;
esac

# exit 0 + JSON, not exit 2 + stderr. The Stop hook uses exit 2 because it has to
# *prevent* something; this hook has nothing to prevent, and exit 2 renders to the
# developer as a hook warning -- an error face on a feature that is working. So:
# additionalContext carries the instruction to the model, systemMessage tells the
# human why their agent just stopped to ask them something.
CONTEXT="[Eklavya checkpoint] You just logged a concept. Before writing another line, ask the developer ONE question about it -- this is the whole point of the tool: they learn while you work, not in a pile at the end.

Concept: $CONCEPT

Do exactly this, then get straight back to the task:
  1. get_session_quiz_plan with max: 1 and ignore_cooldown: true (the pacing is already decided -- this hook is the cooldown).
  2. Ask that ONE question with AskUserQuestion: four options, one correct, three plausible, and put the correct one in the slot answer_position names. Header \"unsure->Other\".
  3. Grade it with record_attempt: format \"mcq\", the labels in \"options\", the stem alone in \"question\".
  4. Resume the task exactly where you left off. Do not summarise, do not re-plan, do not ask a second question.

ONE question. Not two, not the whole plan. $REMAINING left in this session's budget, and the Stop hook spends whatever you do not.
$FRAMING
If they pick Other or say skip, record it as grade 0, teach the answer in two lines, and carry on. Do not ask again."

jq -n --arg ctx "$CONTEXT" --arg msg "Eklavya: quick question on what you just built" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $ctx,
    systemMessage: $msg
  }
}'
exit 0
