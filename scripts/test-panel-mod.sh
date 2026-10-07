#!/bin/sh
# Validates and tests the quiz panel mod (hooks/panel/) with Claude Code's own tooling.
#
# The mod is part of the Eklavya plugin, but `claude plugin test` runs every
# *.test.ts under a plugin folder, and this repository's runtime tests (mcp/test)
# are not that kind. So the mod is staged as a plugin of its own, named
# `eklavya` because its `$.state` keys are, and tested there; the distributed
# plugin is then validated as a whole, hooks.json included.
#
# Needs a Claude Code build that has plugin-authoring (2.1.287+ was used).
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/.claude-plugin" "$stage/hooks"
cp -R "$root/hooks/panel/." "$stage/hooks/"
printf '%s\n' '{ "name": "eklavya", "version": "0.0.0", "description": "Eklavya quiz panel, staged for tests", "author": { "name": "Eklavya" }, "types": "./hooks/types/index.d.ts" }' > "$stage/.claude-plugin/plugin.json"
printf '%s\n' '{ "modules": ["./register.tsx"] }' > "$stage/hooks/hooks.json"

echo "== validate the staged mod"
claude plugin validate "$stage"
echo "== test the staged mod"
claude plugin test "$stage"
echo "== validate the distributed plugin"
claude plugin validate "$root"
