#!/bin/sh
# SessionStart: stamp the session id and print a one-line learner profile.
#
# Hard rule (PRD §9.1): this must never break a session. Every failure path
# exits 0 with no output.

. "$(dirname "$0")/lib.sh"

INPUT=$(cat 2>/dev/null) || exit 0
eklavya_have_deps || exit 0

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || exit 0
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$CWD" ] && CWD=$PWD

# Stamp the session so MCP tools resolve the same id the hooks will use later
# (decision G1). This happens even when the banner is suppressed.
if [ -n "$SESSION_ID" ]; then
  ESCAPED=$(printf '%s' "$SESSION_ID" | sed "s/'/''/g")
  eklavya_sql "INSERT INTO meta (key, value) VALUES ('current_session', '$ESCAPED')
               ON CONFLICT(key) DO UPDATE SET value = excluded.value;" >/dev/null
fi

MODE=$(eklavya_config mode ambient "$CWD")
[ "$MODE" = "off" ] && exit 0
[ "$(eklavya_config quiet false "$CWD")" = "true" ] && exit 0

# "seen" is a mastery row, which only exists once a concept has been attempted.
# Gate the summary on that rather than on anything being mastered yet, or a
# learner three attempts in is told they have no history.
DOMAINS=$(eklavya_sql "
  SELECT group_concat(line, ', ') FROM (
    SELECT c.domain || ' ' ||
           sum(CASE WHEN m.score >= 0.7 AND m.reps >= 2 THEN 1 ELSE 0 END) || '/' ||
           count(*) || ' known' AS line,
           sum(CASE WHEN m.score >= 0.7 AND m.reps >= 2 THEN 1 ELSE 0 END) AS known,
           sum(CASE WHEN m.concept_id IS NOT NULL THEN 1 ELSE 0 END) AS seen
    FROM concepts c LEFT JOIN mastery m ON m.concept_id = c.id
    GROUP BY c.domain
    HAVING seen > 0
    ORDER BY known DESC, seen DESC
    LIMIT 3
  );")

# Not "reps > 0": a failing grade resets reps to 0, so that filter would hide
# precisely the concepts the learner is struggling with. A mastery row at all
# means it has been attempted.
WEAK=$(eklavya_sql "
  SELECT group_concat(slug, ', ') FROM (
    SELECT c.slug FROM concepts c
    JOIN mastery m ON m.concept_id = c.id
    WHERE m.score < 0.5
    ORDER BY m.score ASC
    LIMIT 3
  );")

DUE=$(eklavya_sql "
  SELECT count(*) FROM mastery
  WHERE next_review IS NOT NULL AND next_review <= strftime('%Y-%m-%dT%H:%M:%fZ','now');")

# Nothing learned yet — say the useful thing instead of an empty scoreboard.
if [ -z "$DOMAINS" ]; then
  printf '[Eklavya] No learning history yet. Mode: %s. Log the concepts your work touches via the eklavya MCP server (log_session_concepts).\n' "$MODE"
  exit 0
fi

LINE="[Eklavya] Learner profile: $DOMAINS."
[ -n "$WEAK" ] && LINE="$LINE Weak: $WEAK."
[ -n "$DUE" ] && [ "$DUE" != "0" ] && LINE="$LINE $DUE concept(s) due for review."

printf '%s Mode: %s. Log task concepts via log_session_concepts; omit session_id.\n' "$LINE" "$MODE"
exit 0
