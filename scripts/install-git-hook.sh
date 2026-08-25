#!/bin/sh
# Installs (or removes) the git pre-commit hook that enforces Eklavya's gate
# outside Claude Code. Chains to any pre-commit hook already present rather than
# replacing it.
#
#   scripts/install-git-hook.sh [--uninstall] [repo-path]

set -eu

MARKER="# >>> eklavya gate >>>"
UNINSTALL=0
REPO_ARG=""

for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) REPO_ARG=$arg ;;
  esac
done

CLI_PATH=$(cd "$(dirname "$0")/../cli" && pwd)/eklavya-gate
REPO=${REPO_ARG:-$(git rev-parse --show-toplevel 2>/dev/null || true)}

if [ -z "$REPO" ]; then
  printf 'Not inside a git repository, and no path given.\n' >&2
  exit 1
fi

HOOK_DIR="$REPO/.git/hooks"
HOOK="$HOOK_DIR/pre-commit"
CHAINED="$HOOK_DIR/pre-commit.local"

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -f "$HOOK" ] && grep -q "$MARKER" "$HOOK" 2>/dev/null; then
    rm -f "$HOOK"
    if [ -f "$CHAINED" ]; then
      mv "$CHAINED" "$HOOK"
      printf 'Removed the Eklavya gate and restored your previous pre-commit hook.\n'
    else
      printf 'Removed the Eklavya gate.\n'
    fi
  else
    printf 'No Eklavya gate installed here.\n'
  fi
  exit 0
fi

mkdir -p "$HOOK_DIR"

if [ -f "$HOOK" ] && grep -q "$MARKER" "$HOOK" 2>/dev/null; then
  printf 'Eklavya gate already installed in %s\n' "$HOOK"
  exit 0
fi

# Preserve whatever was there. The existing hook keeps running, first.
if [ -f "$HOOK" ]; then
  if [ -f "$CHAINED" ]; then
    printf 'Refusing to overwrite: both %s and %s already exist.\n' "$HOOK" "$CHAINED" >&2
    exit 1
  fi
  mv "$HOOK" "$CHAINED"
  printf 'Moved your existing pre-commit hook to %s; it will still run first.\n' "$CHAINED"
fi

cat > "$HOOK" <<EOF
#!/bin/sh
$MARKER
# Installed by Eklavya. Remove with scripts/install-git-hook.sh --uninstall

if [ -x "\$(dirname "\$0")/pre-commit.local" ]; then
  "\$(dirname "\$0")/pre-commit.local" "\$@" || exit \$?
fi

exec "$CLI_PATH"
# <<< eklavya gate <<<
EOF

chmod +x "$HOOK"
printf 'Installed the Eklavya commit gate in %s\n' "$HOOK"
printf 'It only acts on repositories whose .eklavya.json sets "mode": "enforced".\n'
