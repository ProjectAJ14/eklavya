#!/bin/sh
# PreToolUse(Bash): hold commits until the session quiz is passed.
#
# This runs on EVERY Bash call, so the first thing it does is decide the command
# is none of its business and get out of the way.

. "$(dirname "$0")/lib.sh"

INPUT=$(cat 2>/dev/null) || exit 0

# --- fast path: shell builtin, no forks -------------------------------------
case "$INPUT" in
  *commit*) ;;
  *) exit 0 ;;
esac
# ---------------------------------------------------------------------------

command -v jq >/dev/null 2>&1 || exit 0

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0

# `git commit` only counts at a command position: after the start of the line or
# a shell separator. This is what keeps `echo "git commit"` from being blocked,
# while `npm test && git commit -m x` is still caught.
# The option group allows a value after a flag, so `git -C . commit` and
# `git -c user.name=x commit` are caught alongside plain `git commit`.
printf '%s' "$CMD" | grep -Eq '(^|[;&|]|&&|\|\|)[[:space:]]*(sudo[[:space:]]+)?git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+commit([[:space:]]|$)' || exit 0

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$CWD" ] && CWD=$PWD

[ "$(eklavya_config mode ambient "$CWD")" = "enforced" ] || exit 0

eklavya_have_deps || exit 0

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
GATE=$(eklavya_sql "SELECT passed || '|' || required || '|' || answered FROM gates WHERE session_id = '$SID';")

# No gate row means nothing was taught this session, so there is nothing to
# prove. Blocking here would be unpassable, not strict.
[ -z "$GATE" ] && exit 0

PASSED=$(printf '%s' "$GATE" | cut -d'|' -f1)
REQUIRED=$(printf '%s' "$GATE" | cut -d'|' -f2)
ANSWERED=$(printf '%s' "$GATE" | cut -d'|' -f3)
[ "$PASSED" = "1" ] && exit 0

REASON="Eklavya gate: this session's quiz has not been passed yet ($ANSWERED of $REQUIRED concepts answered). Run the quiz first — get_session_quiz_plan, ask one question at a time, grade each answer with record_attempt — then retry the commit. Nothing else is blocked."

jq -n --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
