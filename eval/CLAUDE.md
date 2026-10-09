# Working on `eval/`

Harnesses here call the model, often hundreds of times, on the maintainer's own
subscription. Read `README.md` before adding or running one.

- **Track tokens in every eval, always.** Count tokens as well as calls: each
  `claude -p` call carries ~34k tokens of Claude Code context, so call counts
  understate the cost several times over. Run single-shot calls with
  `--output-format json` and pass stdout through `usage.unwrap()` from
  `usage.mjs` (GEPA's Python runner does this in `Budget.add_usage`); read
  session logs with `usage.fromStream()`. A new harness that calls `claude`
  without recording usage is incomplete.
- **Publish the numbers.** A dated result file states input tokens (and how many
  were cached), output tokens and list-price cost, or says explicitly that they
  were not recorded.
- **Everything is manual.** Nothing here runs in CI or from a hook. Say how many
  calls and tokens a run costs near its command, and give it a hard cap
  (`--limit`, `--max-model-calls`) so a first run is small.
- Results under `eval/results/` are historical evidence: correct them with a
  dated note, do not rewrite them.
- Use the real planner and shipped prompts rather than restating them, and
  report unfavourable results too.
