---
paths:
  - "mcp/test/**"
  - ".github/scripts/**"
  - ".github/workflows/test.yml"
---

# CI test shards

- `.github/scripts/test-shards.json` assigns every `mcp/test/**/*.test.ts` to
  one of five shards. Creating, renaming or deleting a test file means editing
  that manifest in the same change. Do not finish the task until it matches.
- Add a file with `node .github/scripts/shard-plan.mjs add test/<name>.test.ts <seconds>`
  from the repository root. It picks the lightest shard. Give a real estimate:
  unit 5-30s, process-spawning CLI or hook 30-70s, Playwright `-browser` 60-120s.
- Never put a file on a shard by hand, leave it unlisted, or remove it from the
  manifest to make a check pass. An unlisted file fails the sequencer, and
  `.github/scripts/test-ci.test.mjs` fails on missing or stale entries and on a
  shard above 125% of the mean.
- Changing the shard count means changing three things together: `count` in the
  manifest (use `shard-plan.mjs rebalance <timings.json> <count>`), the
  `shard:` matrix and the `/N` argument in `.github/workflows/test.yml`, and the
  `merge-coverage.mjs N` argument. `test-ci.test.mjs` checks they agree.
- Verify with `node --test .github/scripts/test-ci.test.mjs`. Two "merge real V8
  coverage" tests fail on some local Node versions with or without your change;
  compare against a clean checkout before blaming the manifest.
- Details: `mcp/test/CLAUDE.md` and the CI section of `CONTRIBUTING.md`.
