#!/bin/sh
# SessionStart: stamp the session id and print a one-line learner profile.
#
# Hard rule (PRD §9.1): this must never break a session. Every failure path
# exits 0 with no output.

. "$(dirname "$0")/lib.sh"

INPUT=$(cat 2>/dev/null) || exit 0
eklavya_have_deps || exit 0

SESSION_ID=${EKLAVYA_SESSION_ID:-}
if [ -z "$SESSION_ID" ]; then
  SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || exit 0
fi
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

FOCUS=$(eklavya_config focus project "$CWD")
TOPIC=$(eklavya_config focus_topic "" "$CWD")
FOCUS_LABEL=$FOCUS
[ "$FOCUS" = "learn" ] && [ -n "$TOPIC" ] && FOCUS_LABEL="learn ($TOPIC)"

# Repo config beats global, which is right -- it is how a lead pins a setting on
# one codebase. Silence about it is not: a repo pinning focus switches off a
# learn topic someone set for themselves, and without this line they have no way
# to tell why their own setting stopped applying.
OVERRIDE=""
if _repo=$(eklavya_repo_config "$CWD"); then
  _global="$(eklavya_home)/config.json"
  if [ -f "$_global" ]; then
    for _key in mode focus focus_topic; do
      _r=$(jq -r --arg k "$_key" '.[$k] // empty' "$_repo" 2>/dev/null)
      _g=$(jq -r --arg k "$_key" '.[$k] // empty' "$_global" 2>/dev/null)
      if [ -n "$_r" ] && [ -n "$_g" ] && [ "$_r" != "$_g" ]; then
        OVERRIDE="$OVERRIDE $_key"
      fi
    done
  fi
fi
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

# The whole tutoring loop starts at log_session_concepts: it is the only writer
# of session_concepts, and the Stop hook quizzes from nothing else. An unlogged
# session is a silent no-op no matter how much was taught in it, and the Stop
# hook exits 0 without a word, so the failure looks like "Eklavya is broken".
#
# The tutor skill already says to log, but it is model-invoked — it competes with
# every other skill on the machine and may never load. So the instruction is
# stated here, where every session sees it before any skill is chosen.
eklavya_directive() {
  cat <<'DIRECTIVE'
[Eklavya] Standing instruction for this session, on every task — not only when asked to teach:
  - Once you know what a task involves, call log_session_concepts with the 3-8 concepts it
    genuinely exercises. Omit session_id. Log while implementing, not at the end.
  - Log what the code is *about* (jwt-verification, react-effect-cleanup, sql-index-selectivity),
    not what you did. Give each one a context line naming the real code you wrote.
  - Guessed slugs are fine: unknown ones are fuzzy-matched or created.
  - Skip this and there is nothing to quiz on, so nothing is ever learned. Load the tutor skill
    for how to ask and grade.
DIRECTIVE
}

# Nothing learned yet — say the useful thing instead of an empty scoreboard.
emit_override() {
  [ -n "$OVERRIDE" ] || return 0
  printf '[Eklavya] This repo overrides your global setting for:%s (.eklavya.json wins).\n' "$OVERRIDE"
}

if [ -z "$DOMAINS" ]; then
  printf '[Eklavya] No learning history yet. Mode: %s. Focus: %s.\n' "$MODE" "$FOCUS_LABEL"
  emit_override
  eklavya_directive
  exit 0
fi

LINE="[Eklavya] Learner profile: $DOMAINS."
[ -n "$WEAK" ] && LINE="$LINE Weak: $WEAK."
[ -n "$DUE" ] && [ "$DUE" != "0" ] && LINE="$LINE $DUE concept(s) due for review."

printf '%s Mode: %s. Focus: %s.\n' "$LINE" "$MODE" "$FOCUS_LABEL"
emit_override
eklavya_directive
exit 0
