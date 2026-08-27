#!/bin/sh
# Launches the Eklavya MCP server, from wherever it actually exists.
#
# Two very different situations have to work:
#
#   1. Development from a checkout — use the local build, so edits take effect
#      without republishing anything.
#   2. Installed as a plugin from git — there is no local build, because dist/
#      and node_modules/ are not tracked. Fall back to the published package,
#      which npx fetches and whose native better-sqlite3 binding npm builds.
#
# Keep PINNED_VERSION in step with .claude-plugin/plugin.json and
# mcp/package.json. A test asserts all three match.

PINNED_VERSION="1.4.1"

MCP_DIR=$(cd "$(dirname "$0")/.." && pwd)
LOCAL_SERVER="$MCP_DIR/dist/server.js"

if [ -f "$LOCAL_SERVER" ] && [ -d "$MCP_DIR/node_modules/better-sqlite3" ]; then
  exec node "$LOCAL_SERVER" "$@"
fi

# stdout is the MCP transport, so npx's own chatter must not land there.
exec npx --yes "eklavya-mcp@$PINNED_VERSION" "$@" 2>/dev/null
