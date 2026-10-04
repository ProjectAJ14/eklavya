#!/bin/sh
# Fail when a change touches product code without also touching the manual,
# the landing page and a README. Run from the repository root:
#
#   .github/scripts/check-docs-sync.sh [base-ref [head-ref]]   # default: origin/main HEAD
#
# Product code is what users run or what the manual describes. Contributor
# tooling (.github/, eval/, docs/), the runtime's tests (mcp/test/) and the
# documentation surfaces themselves are not product code, so a docs-only or
# test-only change never trips this check.
set -eu

base=${1:-origin/main}
head=${2:-HEAD}
changed=$(git diff --name-only "$base"..."$head")

# ponytail: path lists, not a parser. Add a directory here when one ships code.
code=$(printf '%s\n' "$changed" | grep -E \
  '^(mcp/|hooks/|cli/|scripts/|skills/|agents/|user-skill/|\.claude-plugin/|\.mcp\.json$)' \
  | grep -vE '(^|/)(README|CLAUDE)\.md$|^mcp/test/' || true)

if [ -z "$code" ]; then
  echo "docs-sync: no product code changed."
  exit 0
fi

missing=
has() { printf '%s\n' "$changed" | grep -qE "$1"; }
has '^web/src/content/docs/'                    || missing="$missing
  manual         web/src/content/docs/docs/*.mdx"
has '^web/public/(index\.html|app\.js)$'        || missing="$missing
  landing page   web/public/index.html (or app.js for the hero terminal)"
has '^(README\.md|mcp/README\.md)$'             || missing="$missing
  README         README.md or mcp/README.md"

if [ -z "$missing" ]; then
  echo "docs-sync: code, manual, landing page and README all changed."
  exit 0
fi

echo "docs-sync: product code changed without every documentation surface."
echo
echo "Code changed:"
printf '%s\n' "$code" | sed 's/^/  /'
echo
echo "Not changed:$missing"
echo
echo "Every code change updates the manual, the landing page and a README in"
echo "the same PR (CLAUDE.md, 'Documentation is part of every feature')."
echo "Run /verify-docs --since $base --fix to find what each surface must say."
exit 1
