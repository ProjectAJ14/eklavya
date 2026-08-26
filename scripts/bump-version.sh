#!/bin/sh
# Bump the version everywhere it is recorded, in one step.
#
# Three files have to agree or the release is broken in a way that is invisible
# until someone installs it: the plugin manifest, the npm package, and the
# launcher's pinned version (which decides what an installed plugin actually
# downloads). `npm test` asserts all three match.
#
#   scripts/bump-version.sh 0.2.0

set -eu

VERSION=${1:-}
if [ -z "$VERSION" ]; then
  printf 'Usage: scripts/bump-version.sh <version>\n' >&2
  exit 1
fi

case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) printf 'Version must look like 1.2.3 (got "%s")\n' "$VERSION" >&2; exit 1 ;;
esac

ROOT=$(cd "$(dirname "$0")/.." && pwd)

node -e "
  const fs = require('fs');
  const file = '$ROOT/.claude-plugin/plugin.json';
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.version = '$VERSION';
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
"

(cd "$ROOT/mcp" && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null)

LAUNCHER="$ROOT/mcp/bin/eklavya-mcp.sh"
TMP="$LAUNCHER.tmp$$"
sed "s/^PINNED_VERSION=\".*\"$/PINNED_VERSION=\"$VERSION\"/" "$LAUNCHER" > "$TMP"
chmod +x "$TMP"
mv "$TMP" "$LAUNCHER"

printf 'Bumped to %s:\n' "$VERSION"
printf '  .claude-plugin/plugin.json\n  mcp/package.json\n  mcp/bin/eklavya-mcp.sh\n'
printf '\nNext:\n'
printf '  1. Add a CHANGELOG.md entry for %s\n' "$VERSION"
printf '  2. cd mcp && npm test\n'
printf '  3. git commit -am "chore(release): %s" && git tag v%s && git push --follow-tags\n' "$VERSION" "$VERSION"
printf '  4. gh release create v%s --notes-from-tag   (this triggers the npm publish)\n' "$VERSION"
