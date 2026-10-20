---
paths:
  - "mcp/src/**"
  - "mcp/test/**"
  - "hooks/**"
---

# 100% coverage

CI fails the `test` job unless the merged run covers 100% of lines, statements,
functions and branches in `mcp/`. The five test shards can all pass while
`test` fails on a single uncovered `catch`, `??` or early `return`.

- Do not call a change to `mcp/src/` or `hooks/` done until every line and branch
  you added is exercised. A new `if`, `??`, `?:`, `catch` or early return is a
  branch that needs a test that takes it, in both directions.
- A subset run cannot prove it: older `catch` blocks are reached by other test
  files, so a file looks uncovered until the whole suite runs. Measure with the
  whole suite, then read the lines of the files you changed:

  ```bash
  cd mcp && npm run build
  EKLAVYA_HOME=$(mktemp -d) EKLAVYA_COVERAGE=1 npx c8 --reporter=lcovonly \
    --reports-dir=/tmp/cov vitest run
  # uncovered: `DA:<line>,0` and `BRDA:<line>,<block>,<branch>,0|-` under your file's `SF:`
  ```

  `npm run coverage` does the same and prints the thresholds. Allow about three
  minutes. Dashboard browser and `-wal` file-watch tests fail on some machines
  with or without your change; compare against a clean checkout before blaming
  yourself, and do not treat them as the coverage result.
- `src/paths.ts` shows one uncovered branch when `EKLAVYA_HOME` is set for the
  whole run, as above. That is the run's setting, not a gap; CI does not have it.
- Write the test for the edge, not around it: a git failure, a deleted folder, a
  bad timestamp, an empty command, a spent time budget. Spy on `Date.now`,
  `os.homedir` or an environment variable instead of waiting or editing the
  real one. Vitest workers do not pass `process.env.HOME` to `os.homedir()`.
- Never lower a threshold, exclude a file or add `c8 ignore` to pass. The one
  accepted `c8 ignore` is a race or crash no test can reach, with the reason on
  the same line (`/* c8 ignore next -- a concurrent answer between the two reads */`).
- Prove a test bites: remove the guard it protects, see it fail, put the guard back.
