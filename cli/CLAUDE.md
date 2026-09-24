# Working in `cli/`

This directory contains the POSIX `eklavya-gate` script. The `eklavya` binary
(`config`, `doctor`, `install`, `dashboard`, etc.) lives in `mcp/src/cli.ts`.
Read the root `CLAUDE.md` for the repository contract.

## Installation and scope

The terminal gate requires both a per-repository installation and project
`quiz.enforced: true`. `eklavya install` does not install a git hook.

`scripts/install-git-hook.sh` writes into the common Git directory so linked
worktrees use the same hook. It preserves an existing hook as `pre-commit.local`
and runs that first; `--uninstall` restores it. With `core.hooksPath` configured,
it prints the integration line and exits 2 without installing anything.

The installed wrapper tries the managed runtime, then the original installation
path, and invokes the script with `sh`. Missing both paths warns and allows the
commit. Preserve this fallback: updates can move plugin directories.
`eklavya uninstall` warns about the hook and prints removal instructions; it
does not remove the hook itself.

Project config lives in `~/.eklavya/projects/<slug>/config.json`; worktrees fold
to their main checkout. The script reads the old `<repo>/.eklavya.json` only as
a fallback and never migrates it. Global enforcement alone does not activate
this gate, but a global `quiz.enabled: false` releases it unless overridden by
the project. Keep legacy `mode` compatibility and explicit `false` values.

## Fail-open contract

Use POSIX `sh`; the installed hook runs through `/bin/sh`. Missing repository,
config, `jq`, `sqlite3`, database or gate row allows the commit. Database query
errors also allow it. Missing dependencies warn on stderr.

Exit 1 only when a gate row exists for this repository and `passed` is not `1`.
Do not add an operational error that prevents a commit.

## Keep duplicated logic aligned

| Script responsibility | Source and verification |
|---|---|
| Config merge and legacy `mode` alias | `mcp/src/config.ts`; shared fixtures in `mcp/test/gate.test.ts` |
| Project slug and worktree folding | `mcp/src/paths.ts`; physical paths must also handle symlinks |
| Latest repository gate lookup | `gates` schema and `syncGate` in `mcp/src/store.ts` |
| In-session commit detection | `mcp/src/hooks/pre-tool-gate.ts` and `commit-lib.ts` |

The script trusts persisted `passed`; it must not duplicate passing-grade or
threshold arithmetic. It looks up the latest gate by repository, whereas the
in-session hook uses a session ID. In jq, use explicit `if`/`elif` for booleans:
`//` treats `false` as absent and can re-enable a disabled legacy gate.

## Documentation and verification

In the same PR, update the manual `commit-gate.mdx` for installer, prerequisite,
scope, bypass or failure behavior changes. Check `configuration.mdx`,
`skills/setup/SKILL.md` and the commit-gate acceptance check in `CONTRIBUTING.md`
when their claims change. Every claim about terminal enforcement must include
both installation and project enforcement.

From `mcp/`, run `npm test -- gate`. It builds the runtime and exercises the real
script and installer in temporary repositories, including an actual commit.
Build `web/` after documentation changes; report any live acceptance test not run.
