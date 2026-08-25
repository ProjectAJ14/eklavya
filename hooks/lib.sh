#!/bin/sh
# Shared helpers for Eklavya hook scripts.
#
# Hooks run on the critical path of a user action, so these read SQLite and JSON
# directly rather than paying for an MCP round trip. Business rules stay in the
# server (PRD §12); what lives here is lookup and orchestration only.

eklavya_home() { printf '%s' "${EKLAVYA_HOME:-$HOME/.eklavya}"; }
eklavya_db()   { printf '%s' "${EKLAVYA_DB:-$(eklavya_home)/knowledge.db}"; }

eklavya_have_deps() {
  command -v jq >/dev/null 2>&1 || return 1
  command -v sqlite3 >/dev/null 2>&1 || return 1
  [ -f "$(eklavya_db)" ] || return 1
  return 0
}

# Nearest .eklavya.json at or above $1, stopping at the git root so a config
# above the repo does not leak into it.
eklavya_repo_config() {
  dir=${1:-$PWD}
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -f "$dir/.eklavya.json" ]; then
      printf '%s' "$dir/.eklavya.json"
      return 0
    fi
    [ -d "$dir/.git" ] && return 1
    dir=$(dirname "$dir")
  done
  return 1
}

# eklavya_config KEY DEFAULT [CWD] — repo config wins over global (PRD §11).
eklavya_config() {
  _key=$1
  _default=$2
  _cwd=${3:-$PWD}
  _val=""

  if _repo=$(eklavya_repo_config "$_cwd"); then
    _val=$(jq -r --arg k "$_key" '.[$k] // empty' "$_repo" 2>/dev/null)
  fi

  if [ -z "$_val" ]; then
    _global="$(eklavya_home)/config.json"
    if [ -f "$_global" ]; then
      _val=$(jq -r --arg k "$_key" '.[$k] // empty' "$_global" 2>/dev/null)
    fi
  fi

  [ -z "$_val" ] && _val=$_default
  printf '%s' "$_val"
}

# `.timeout` rather than `PRAGMA busy_timeout` — the pragma emits a result row,
# which would prepend "2000" to the output of every query that uses it.
eklavya_sql() {
  sqlite3 -noheader -batch -cmd ".timeout 2000" "$(eklavya_db)" "$1" 2>/dev/null
}
