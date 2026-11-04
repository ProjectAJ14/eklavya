#!/bin/sh
# Fail when a file under mcp/src/economy/ lacks the Apache-2.0 attribution
# header. That folder holds code translated from microsoft/TokenEconomizer
# (Apache-2.0); THIRD_PARTY_NOTICES.md names the upstream commit. Every source
# file there starts by naming its upstream file and commit, saying it was
# translated and adapted, and pointing at the licence. Run from the repository
# root:
#
#   .github/scripts/check-economy-headers.sh
set -eu

dir=mcp/src/economy
missing=
for f in "$dir"/*; do
  case "$f" in
    */LICENSE) continue ;;
  esac
  head=$(head -n 6 "$f")
  printf '%s' "$head" | grep -q 'microsoft/TokenEconomizer' || missing="$missing $f"
  printf '%s' "$head" | grep -q 'Translated and adapted' || missing="$missing $f"
  printf '%s' "$head" | grep -q 'Apache License, Version 2.0' || missing="$missing $f"
done
[ -f "$dir/LICENSE" ] || missing="$missing $dir/LICENSE"
grep -q 'microsoft/TokenEconomizer' THIRD_PARTY_NOTICES.md || missing="$missing THIRD_PARTY_NOTICES.md"

if [ -n "$missing" ]; then
  echo "economy-headers: missing attribution in:"
  printf '%s\n' $missing | sort -u | sed 's/^/  /'
  echo
  echo "Every file under $dir starts with the upstream file and commit, a"
  echo "'Translated and adapted' line and 'Licensed under the Apache License, Version 2.0'."
  exit 1
fi
echo "economy-headers: every file under $dir carries its attribution."
