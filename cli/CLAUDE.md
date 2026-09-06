# Working in `cli/`

**This directory is not the `eklavya` binary.** That is `mcp/src/cli.ts`,
published as `dist/cli.js` and the package's only `bin`. `cli/` holds exactly one
file: `eklavya-gate`, the POSIX commit-gate script. The name invites the
confusion, so check which one a request means before you edit anything —
`eklavya config`, `eklavya doctor`, `eklavya dashboard` and `eklavya install` all
live in `mcp/src/cli.ts`.

It is a shell script and not Node on purpose: it runs as a git `pre-commit` hook
on every commit, and a git hook must not pay Node's startup cost. Keep it POSIX
`sh` — the installed hook execs it with `#!/bin/sh`, and `mcp/test/gate.test.ts`
drives it through `/bin/sh`.

## It is opt-in, twice over

Nothing in `eklavya install` puts this on a repo. `scripts/install-git-hook.sh`
does, as a separate step the user runs per repo; it writes `.git/hooks/pre-commit`
between the `# >>> eklavya gate >>>` markers, and if a `pre-commit` already
existed it moves it to `pre-commit.local` and chains it first. `--uninstall`
restores it.

Then the script itself only acts on a repo whose `.eklavya.json` sets
`"mode": "enforced"`. Note that it reads **only** the repo file — not
`~/.eklavya/config.json` — so a globally enforced mode does not gate a bare
terminal. Any doc claiming a terminal commit is gated has to attach the installer
step and the repo config; `web/src/content/docs/docs/commit-gate.mdx` and
`skills/setup/SKILL.md` are where that lives.

## It fails open, always

A learning tool that bricks commits gets uninstalled, and an unpassable gate
teaches nothing. Every one of these exits 0:

- not inside a git repo, or `git rev-parse` fails;
- no `.eklavya.json` in the repo root;
- `jq` not on PATH (warns on stderr) — **or** `sqlite3` not on PATH (warns too).
  It needs both, not just `jq`;
- `mode` is anything but `enforced`;
- the database file does not exist;
- the `sqlite3` query errors, or returns no gate row for this repo.

Exit 1 happens on exactly one condition: a gate row for this repo whose `passed`
is not `1`. Adding a new failure mode means adding a new `exit 0` path.

## It reads the database directly

There is no server in a git hook, so the script talks to `knowledge.db` in raw
SQL and duplicates things it cannot import. Keep it in step with:

- the `gates` table shape — it selects `passed, required, answered` and picks the
  repo's most recent row by `updated_at`. `syncGate` in `mcp/src/store.ts` is the
  only writer; a renamed or added column lands here in the same commit.
- `DEFAULT_CONFIG.mode` in `mcp/src/config.ts` — the script hardcodes `"ambient"`
  as jq's fallback for a `.eklavya.json` with no `mode`.

The pass/fail arithmetic itself (`PASSING_GRADE`, `pass_threshold`,
`ceil(required * pass_threshold)`) is **not** duplicated here — the script trusts
the persisted `passed` column. Keep it that way: a change to the gate's rule
belongs in `syncGate` alone. What is duplicated is the lookup key, and it differs
from the in-session hook on purpose: `mcp/src/hooks/pre-tool-gate.ts` looks the
gate up by `session_id`, this script by `repo`, because a terminal commit has no
session.

## Tests

`mcp/test/gate.test.ts` runs the real script and the real installer against a
temp repo, and ends with an actual `git commit`. From `mcp/`:

```sh
npm test -- gate
```

`pretest` builds `dist/`, which `pre-tool-gate.js` in the same file needs.
