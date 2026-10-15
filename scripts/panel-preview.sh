#!/bin/sh
# Draws the quiz panel (hooks/panel/) as Claude Code Desktop would, into one HTML
# page, without installing or releasing anything: the real mod runs in Claude
# Code's test host (scenes in scripts/panel-preview/scenes.ts) and each drawn
# tree is turned into HTML by scripts/panel-preview/render.mjs.
#
# The HTML is an approximation calibrated from Desktop screenshots, not Desktop's
# own renderer; confirm a change on Desktop before calling it done.
#
# Usage: scripts/panel-preview.sh [output.html]   (default: eklavya-panel-preview.html in $TMPDIR)
# PANEL_REF=main draws that commit's panel instead of the working tree's, to compare.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
out=${1:-"${TMPDIR:-/tmp}/eklavya-panel-preview.html"}

mkdir -p "$stage/.claude-plugin" "$stage/hooks"
if [ -n "${PANEL_REF:-}" ]; then
  git -C "$root" archive "$PANEL_REF" hooks/panel | tar -x -C "$stage"
  cp -R "$stage/hooks/panel/." "$stage/hooks/" && rm -rf "$stage/hooks/panel"
else
  cp -R "$root/hooks/panel/." "$stage/hooks/"
fi
rm -f "$stage"/hooks/*.test.ts
cp "$root/scripts/panel-preview/scenes.ts" "$stage/hooks/scenes.test.ts"
printf '%s\n' '{ "name": "eklavya", "version": "0.0.0", "description": "Eklavya quiz panel, staged for a preview", "author": { "name": "Eklavya" }, "types": "./hooks/types/index.d.ts" }' > "$stage/.claude-plugin/plugin.json"
printf '%s\n' '{ "modules": ["./register.tsx"] }' > "$stage/hooks/hooks.json"

claude plugin test "$stage" > "$stage/out.txt" 2>&1 || { cat "$stage/out.txt"; exit 1; }
node "$root/scripts/panel-preview/render.mjs" "$stage/out.txt" "$out"
case "$(uname)" in Darwin) open "$out" ;; esac
