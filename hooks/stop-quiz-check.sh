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

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
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
        AND NOT (COALESCE(m.score,0) >= 0.7 AND COALESCE(m.reps,0) >= 2))
    || '|' ||
    (SELECT count(*) FROM session_concepts WHERE session_id = '$SID')
    || '|' ||
    COALESCE((SELECT last_logged_count FROM stop_markers WHERE session_id = '$SID'), -1)
    || '|' ||
    COALESCE((SELECT block_count FROM stop_markers WHERE session_id = '$SID'), 0)
    || '|' ||
    COALESCE((SELECT CAST((julianday('now') - julianday(last_blocked_at)) * 1440 AS INTEGER)
                FROM stop_markers WHERE session_id = '$SID'), 999999);")

[ -z "$STATS" ] && exit 0

UNMASTERED=$(printf '%s' "$STATS" | cut -d'|' -f1)
LOGGED=$(printf '%s' "$STATS" | cut -d'|' -f2)
LAST_LOGGED=$(printf '%s' "$STATS" | cut -d'|' -f3)
BLOCKS=$(printf '%s' "$STATS" | cut -d'|' -f4)
MINS_SINCE=$(printf '%s' "$STATS" | cut -d'|' -f5)

# Nothing worth asking about.
[ "$UNMASTERED" -gt 0 ] 2>/dev/null || exit 0

# --- the loop guard ---------------------------------------------------------
[ "$LOGGED" -gt "$LAST_LOGGED" ] 2>/dev/null || exit 0

MAX_BLOCKS=$(eklavya_config max_stop_blocks_per_session "$MAX_BLOCKS_DEFAULT" "$CWD")
[ "$BLOCKS" -lt "$MAX_BLOCKS" ] 2>/dev/null || exit 0

# Ambient mode respects the quiz cadence. Enforced mode must not, or a cooldown
# could make a commit gate unpassable (decision G5).
if [ "$MODE" = "ambient" ]; then
  COOLDOWN=$(eklavya_config min_minutes_between_quizzes 20 "$CWD")
  [ "$MINS_SINCE" -ge "$COOLDOWN" ] 2>/dev/null || exit 0
fi
# ---------------------------------------------------------------------------

MAX_Q=$(eklavya_config max_questions_per_task 4 "$CWD")
CONCEPTS=$(eklavya_sql "
  SELECT group_concat(line, '; ') FROM (
    SELECT c.slug || COALESCE(' (' || sc.context || ')', '') AS line
      FROM session_concepts sc
      JOIN concepts c ON c.id = sc.concept_id
      LEFT JOIN mastery m ON m.concept_id = c.id
     WHERE sc.session_id = '$SID'
       AND NOT (COALESCE(m.score,0) >= 0.7 AND COALESCE(m.reps,0) >= 2)
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
ONE question at a time at each concept's tier_to_ask, ground every question in
the code you just wrote, and grade each answer with record_attempt.
$TONE
EOF
exit 2
