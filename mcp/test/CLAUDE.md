# Adding or changing tests in `mcp/test/`

Read the root `CLAUDE.md` and `mcp/CLAUDE.md` first.

CI splits these files across five shards. `.github/scripts/test-shards.json`
lists every `*.test.ts` with its shard and an estimated cost in seconds. Vitest
refuses to run a file the manifest does not list, so a new test is never
skipped, but CI fails until you list it.

## When you add a test file

1. Name it for the area it covers (`memory-*`, `dashboard-*`, `feedback-*`,
   `hooks*`, `cli*`, `config*`). Browser suites end in `-browser.test.ts`.
2. From the repository root run
   `node .github/scripts/shard-plan.mjs add test/<name>.test.ts <seconds>`.
   It puts the file on the lightest shard and prints the new loads.
3. Estimate seconds honestly: a unit file is 5 to 30, a CLI or hook file that
   spawns processes 30 to 70, a Playwright file 60 to 120. Compare with a
   sibling file's entry. Do not under-state a browser suite to fit a shard.
4. Commit the manifest with the test.

## When you rename, split or delete one

Edit the manifest entry in the same change. Splitting a slow file into two
lets the planner spread it, so prefer that over a longer file.

## If the shards drift

`test-ci.test.mjs` fails when the heaviest shard exceeds 125% of the mean. Fix
it with `node .github/scripts/shard-plan.mjs rebalance <test-timings.json>`,
using the `test-timings.json` from the latest successful `coverage` artifact
(`gh run download <run-id> -n coverage`). Rebalancing moves files between
shards, so mention it in the PR.

Never hand-pick a shard that is already the heaviest, and never exclude a file
from the manifest to silence the check.
