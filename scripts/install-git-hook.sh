#!/bin/sh
# Installs (or removes) the git pre-commit hook that enforces Eklavya's gate
# outside Claude Code. Chains to any pre-commit hook already present rather than
# replacing it.
#
#   scripts/install-git-hook.sh [--uninstall] [repo-path]
#
# Exit status: 0 installed, updated, already there, or uninstalled; 1 an error
# (not a repository, or two existing hooks it will not choose between); 2 not
# installed because core.hooksPath hands hooks to a hook manager -- the message
# says how to call the gate from there instead.

set -eu

MARKER="# >>> eklavya gate >>>"
UNINSTALL=0
REPO_ARG=""

for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) REPO_ARG=$arg ;;
  esac
done

# Not `cd ../cli`: under `set -e` a missing cli/ would abort even --uninstall.
CLI_PATH=$(cd "$(dirname "$0")/.." && pwd -P)/cli/eklavya-gate

# A path argument may be anywhere inside the checkout; git names the top.
REPO=$(cd "${REPO_ARG:-.}" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) || REPO=''
if [ -z "$REPO" ]; then
  if [ -n "$REPO_ARG" ]; then
    printf '%s is not inside a git repository.\n' "$REPO_ARG" >&2
  else
    printf 'Not inside a git repository, and no path given.\n' >&2
  fi
  exit 1
fi

# Hooks live in the *common* git directory. In a linked worktree `.git` is a
# file, not a directory, and every worktree runs the main checkout's hooks, so
# `$REPO/.git/hooks` is wrong there. `--git-common-dir` may answer relative to
# the checkout, hence the `cd` before resolving it.
COMMON=$(cd "$REPO" && git rev-parse --git-common-dir 2>/dev/null) || COMMON=''
COMMON=$(cd "$REPO" && cd "$COMMON" 2>/dev/null && pwd -P) || COMMON=''
if [ -z "$COMMON" ]; then
  printf 'Could not find the git directory for %s.\n' "$REPO" >&2
  exit 1
fi
HOOK_DIR="$COMMON/hooks"
HOOK="$HOOK_DIR/pre-commit"
CHAINED="$HOOK_DIR/pre-commit.local"

# "Is something there", counting a symlink whose target is gone: `[ -f ]` says
# no to that, and writing the hook would then write through the dangling link.
exists() { [ -e "$1" ] || [ -L "$1" ]; }
ours() { [ -f "$1" ] && grep -q "$MARKER" "$1" 2>/dev/null; }

if [ "$UNINSTALL" -eq 1 ]; then
  if ours "$HOOK"; then
    rm -f "$HOOK"
    if exists "$CHAINED"; then
      mv "$CHAINED" "$HOOK"
      printf 'Removed the Eklavya gate and restored your previous pre-commit hook.\n'
    else
      printf 'Removed the Eklavya gate.\n'
    fi
  else
    printf 'No Eklavya gate installed in %s.\n' "$HOOK_DIR"
  fi
  exit 0
fi

# A hook manager (husky, lefthook, pre-commit) sets core.hooksPath, and git
# then never runs $HOOK. Installing there anyway would report a gate that never
# fires; writing into the manager's directory would put Eklavya into a folder
# that is usually committed. So neither: say how to call the gate from the
# manager, and exit non-zero so nobody mistakes this for an installed gate.
# The printed line must fail open too, and must not be the `[ -f X ] && sh X`
# shape: pasted last in a hook, a missing file makes that line -- and so the
# hook -- exit 1, blocking every commit. `if` exits 0 when its test fails.
HOOKS_PATH=$(cd "$REPO" && git config --get core.hooksPath 2>/dev/null) || HOOKS_PATH=''
if [ -n "$HOOKS_PATH" ]; then
  cat >&2 <<EOF
Not installed: this repository sets core.hooksPath to "$HOOKS_PATH" (a hook
manager such as husky or lefthook), so git never runs $HOOK.

To gate commits, add this line to the pre-commit hook your manager runs:

  g="\${EKLAVYA_RUNTIME:-\${EKLAVYA_HOME:-\$HOME/.eklavya}/runtime}/node_modules/eklavya/dist/plugin/cli/eklavya-gate"; if [ -f "\$g" ]; then sh "\$g" || exit \$?; fi

It holds a commit only when this project sets quiz.enforced and the session
quiz has not passed. It names the installed runtime copy, which plugin updates
keep at the same path, and if that file is ever missing the line does nothing,
so your commits keep working.
EOF
  exit 2
fi

mkdir -p "$HOOK_DIR"

if ours "$HOOK"; then
  UPGRADE=1
else
  UPGRADE=0
  # Preserve whatever was there. The existing hook keeps running, first.
  if exists "$HOOK"; then
    if exists "$CHAINED"; then
      # Two hooks and one slot: moving either would lose one, so neither moves.
      printf 'Not installed: %s and %s both exist, and neither is the Eklavya gate.\n' "$HOOK" "$CHAINED" >&2
      printf 'Merge them into one pre-commit hook, then run this again.\n' >&2
      exit 1
    fi
    mv "$HOOK" "$CHAINED"
    printf 'Moved your existing pre-commit hook to %s; it will still run first.\n' "$CHAINED"
  fi
fi

# Where the hook looks for the gate at commit time, in order:
#
#   1. the installed runtime, ~/.eklavya/runtime/.../dist/plugin/cli/. It is
#      the copy `eklavya install` and the plugin keep current, at a path that
#      does not change between versions;
#   2. the path this installer ran from, which a plugin update may delete.
#
# If neither is there the commit goes through with one line on stderr. The hook
# used to `exec` path 2 unconditionally, so the next plugin update made every
# commit in the repository fail -- the one failure this gate must never have.
# Run with `sh` rather than exec'd, so a lost executable bit cannot block either.
# Escaped for the double-quoted string it lands in, so a checkout path holding
# a quote, backslash, backtick or dollar sign cannot break (or run code in) it.
CLI_QUOTED=$(printf '%s' "$CLI_PATH" | sed 's/[\\"$`]/\\&/g')
TMP="$HOOK_DIR/.pre-commit.eklavya-tmp.$$"
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<EOF
#!/bin/sh
$MARKER
# Installed by Eklavya. Remove with "install-git-hook.sh --uninstall" from the
# plugin's scripts/ directory, or delete this file.

if [ -x "\$(dirname "\$0")/pre-commit.local" ]; then
  "\$(dirname "\$0")/pre-commit.local" "\$@" || exit \$?
fi

for gate in \\
  "\${EKLAVYA_RUNTIME:-\${EKLAVYA_HOME:-\${HOME:-}/.eklavya}/runtime}/node_modules/eklavya/dist/plugin/cli/eklavya-gate" \\
  "$CLI_QUOTED"
do
  [ -f "\$gate" ] && exec sh "\$gate"
done

printf 'eklavya: commit gate not found, so this commit is not gated. Run "npx eklavya install" to restore it, or delete %s to stop this message.\\n' "\$0" >&2
exit 0
# <<< eklavya gate <<<
EOF
chmod 755 "$TMP"

if [ "$UPGRADE" -eq 1 ] && cmp -s "$TMP" "$HOOK"; then
  printf 'Eklavya gate already installed in %s\n' "$HOOK"
  exit 0
fi
mv -f "$TMP" "$HOOK"
trap - EXIT

if [ "$UPGRADE" -eq 1 ]; then
  printf 'Updated the Eklavya commit gate in %s\n' "$HOOK"
else
  printf 'Installed the Eklavya commit gate in %s\n' "$HOOK"
fi
printf 'It only acts on projects whose config sets quiz.enforced. That config lives at\n'
printf '~/.eklavya/projects/<checkout>/config.json, never inside the repository.\n'
