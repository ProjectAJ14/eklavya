# Third-party notices

Eklavya is released under the MIT licence (`LICENSE`). Parts of it are
translated from other projects under their own licences, listed here.

## TokenEconomizer

- Project: [microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer)
  — "Experience-Driven Black-Box Cost Control for Coding Agents"
- Licence: Apache License, Version 2.0. The full text is in
  [`mcp/src/economy/LICENSE`](mcp/src/economy/LICENSE) and ships with the
  package as `dist/economy/LICENSE`.
- Upstream commit read: `d3e193b8734ec76230da1e08d7929ba9d14640d8`
  (4 November 2026). The upstream repository has no `NOTICE` file.
- Where: only the files under [`mcp/src/economy/`](mcp/src/economy/). Each
  starts with a header naming the upstream file and commit, says it was
  translated and adapted, and lists what changed. Eklavya's MIT files import
  from that folder and do not copy its logic.

| Eklavya file | Translated from |
|---|---|
| `mcp/src/economy/shell-edits.ts` | `tokeneconomizer/loopguard/shell_edits.py` |
| `mcp/src/economy/signals.ts` | `tokeneconomizer/loopguard/state.py` |
| `mcp/src/economy/loopguard.ts` | `tokeneconomizer/loopguard/rules.py`, `envelope.py` |
| `mcp/src/economy/transcript.ts` | `tokeneconomizer/trace/claude.py` |
| `mcp/src/economy/pricing.ts` | `tokeneconomizer/pricing.py` |
| `mcp/src/economy/toolprune.ts` | `tokeneconomizer/plugin/denylist.py`, `toolprune/tools.py` |
| `mcp/src/economy/envfacts.ts` | `tokeneconomizer/microskills/envfacts.py`, `observe.py`, `lifecycle.py` |

The modifications are Eklavya's and are released under the same Apache-2.0
terms as the files they modify. `.github/scripts/check-economy-headers.sh`
fails CI when a file in that folder loses its header.
