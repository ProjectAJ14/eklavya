#!/bin/sh
# Stop: turn a finished task into a quiz, at most once per batch of work.
#
# Blocking is exit 2 with the reason on stderr (deviation D1) — the current hooks
# reference documents no Stop-specific JSON envelope, but does document that
# exit 2 prevents stopping and uses stderr as the message.
#
# THE LOOP GUARD IS THE POINT OF THIS FILE.
# `stop_hook_active` is no longer a documented input (deviation D2), so nothing
# here may depend on the harness noticing we already blocked. The rule that keeps
# this finite:
#
#   block only when the number of concepts logged for this session has GROWN
#   since the last block.
#
# Blocking stamps the current count. A Stop that follows with the same count does
# not block, whatever happened in between — quiz answered, quiz skipped, model
# ignored us entirely. Only genuinely new logged work re-arms it, and
# `block_count` caps even that.

. "$(dirname "$0")/lib.sh"

MAX_BLOCKS_DEFAULT=3

INPUT=$(cat 2>/dev/null) || exit 0
eklavya_have_deps || exit 0

# Belt and braces: honor it if the harness still sends it, depend on it never.
if [ "$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)" = "true" ]; then
  exit 0
fi

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$CWD" ] && CWD=$PWD

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

MODE=$(eklavya_config mode ambient "$CWD")
[ "$MODE" = "off" ] && exit 0

SID=$(printf '%s' "$SESSION_ID" | sed "s/'/''/g")

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
    -- 'work' only, and the loop guard depends on it: record_attempt inserts a
    -- session_concepts row for anything it is quizzed on, so counting review
    -- rows here would let answering a question re-arm the block that asked it.
    (SELECT count(*) FROM session_concepts
      WHERE session_id = '$SID' AND COALESCE(origin,'work') = 'work')
    || '|' ||
    COALESCE((SELECT last_logged_count FROM stop_markers WHERE session_id = '$SID'), -1)
    || '|' ||
    COALESCE((SELECT block_count FROM stop_markers WHERE session_id = '$SID'), 0)
    || '|' ||
    COALESCE((SELECT CAST((julianday('now') - julianday(last_blocked_at)) * 1440 AS INTEGER)
                FROM stop_markers WHERE session_id = '$SID'), 999999)
    || '|' ||
    COALESCE((SELECT CAST((julianday('now') - julianday(ts)) * 1440 AS INTEGER)
                FROM attempts WHERE session_id = '$SID' ORDER BY id DESC LIMIT 1), 999999);")

[ -z "$STATS" ] && exit 0

UNMASTERED=$(printf '%s' "$STATS" | cut -d'|' -f1)
LOGGED=$(printf '%s' "$STATS" | cut -d'|' -f2)
LAST_LOGGED=$(printf '%s' "$STATS" | cut -d'|' -f3)
BLOCKS=$(printf '%s' "$STATS" | cut -d'|' -f4)
MINS_SINCE=$(printf '%s' "$STATS" | cut -d'|' -f5)
MINS_SINCE_ANSWER=$(printf '%s' "$STATS" | cut -d'|' -f6)

# Nothing worth asking about. Concepts already answered in this session are
# excluded above: they have had their turn, and re-offering them is exactly the
# "asked me the same thing twice" failure this tool exists to avoid.
[ "$UNMASTERED" -gt 0 ] 2>/dev/null || exit 0

# --- the loop guard ---------------------------------------------------------
[ "$LOGGED" -gt "$LAST_LOGGED" ] 2>/dev/null || exit 0

MAX_BLOCKS=$(eklavya_config max_stop_blocks_per_session "$MAX_BLOCKS_DEFAULT" "$CWD")
[ "$BLOCKS" -lt "$MAX_BLOCKS" ] 2>/dev/null || exit 0

# Ambient mode respects the quiz cadence. Enforced mode must not, or a cooldown
# could make a commit gate unpassable (decision G5).
#
# Both clocks matter, and for the same reason. get_session_quiz_plan applies its
# cooldown from the last *answer*; this hook stamps the last *block*. Checking
# only the block would let us block a turn that the quiz plan then refuses as
# too soon, which reads to the model as being told to teach and given nothing to
# teach. Whichever happened more recently wins.
if [ "$MODE" = "ambient" ]; then
  COOLDOWN=$(eklavya_config min_minutes_between_quizzes 20 "$CWD")
  [ "$MINS_SINCE" -ge "$COOLDOWN" ] 2>/dev/null || exit 0
  [ "$MINS_SINCE_ANSWER" -ge "$COOLDOWN" ] 2>/dev/null || exit 0
fi
# ---------------------------------------------------------------------------

FOCUS=$(eklavya_config focus project "$CWD")
TOPIC=$(eklavya_config focus_topic "" "$CWD")

# The stderr message below is what actually drives most quizzes -- the tutor
# skill is model-invoked and may not have loaded. If the focus is not stated
# here, an ambient session teaches the project-mode default whatever the
# developer configured.
case "$FOCUS" in
  concept)
    FRAMING="Focus is 'concept': ask the transferable version. Open from the code just written, then ask for the general rule or the class of problem — the answer must be usable on a different codebase."
    ;;
  learn)
    if [ -n "$TOPIC" ]; then
      FRAMING="Focus is 'learn' on \"$TOPIC\": teach that topic in prerequisite order. Where the plan marks bridge_context, this session's code is your worked example; otherwise teach it on its own terms."
    else
      FRAMING="Focus is 'learn' but no focus_topic is set. Ask what they want to learn and set it before quizzing."
    fi
    ;;
  *)
    FRAMING="Focus is 'project': ground every question in the diff just written — the file, the line, the decision."
    ;;
esac

MAX_Q=$(eklavya_config max_questions_per_task 4 "$CWD")
CONCEPTS=$(eklavya_sql "
  SELECT group_concat(line, '; ') FROM (
    SELECT c.slug || COALESCE(' (' || sc.context || ')', '') AS line
      FROM session_concepts sc
      JOIN concepts c ON c.id = sc.concept_id
      LEFT JOIN mastery m ON m.concept_id = c.id
     WHERE sc.session_id = '$SID'
       AND COALESCE(sc.origin,'work') = 'work'
       AND NOT (COALESCE(m.score,0) >= 0.7 AND COALESCE(m.reps,0) >= 2)
       AND sc.concept_id NOT IN
           (SELECT concept_id FROM attempts WHERE session_id = '$SID')
     ORDER BY sc.ts ASC
     LIMIT $MAX_Q
  );")

# Stamp the guard BEFORE blocking. If anything below fails, the worst case is a
# missed quiz — never a loop.
eklavya_sql "
  INSERT INTO stop_markers (session_id, last_blocked_at, last_logged_count, block_count)
  VALUES ('$SID', strftime('%Y-%m-%dT%H:%M:%fZ','now'), $LOGGED, 1)
  ON CONFLICT(session_id) DO UPDATE SET
    last_blocked_at   = excluded.last_blocked_at,
    last_logged_count = excluded.last_logged_count,
    block_count       = stop_markers.block_count + 1;" >/dev/null

if [ "$MODE" = "enforced" ]; then
  TONE="This session is in enforced mode: the commit gate needs this quiz."
else
  TONE="If they say skip, record it as grade 0 and let them go — do not ask twice."
fi

cat >&2 <<EOF
Eklavya: before finishing, quiz the developer on what this task just taught.

Concepts: $CONCEPTS

Use the eklavya MCP server and the tutor skill: call get_session_quiz_plan, ask
ONE question at a time at each concept's tier_to_ask, and grade each answer with
record_attempt. The plan returns a "framing" field. Follow it.
$FRAMING
$TONE
EOF
exit 2
