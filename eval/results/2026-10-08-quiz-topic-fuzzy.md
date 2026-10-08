# Quiz topic: loose match for a topic word, 2026-10-08

Change: `get_session_quiz_plan` runs a `domain` or `slugs` argument that names
no domain and no concept through `resolveTopic`, the loose match `learn` focus
uses. `resolveTopic` now matches domains by whole words, matches concepts on a
word that starts with the topic, and trims an `-ing`/`-es`/`-ed`/`-s` ending
from a topic longer than five letters. The quiz skill gained one sentence:
pass such a word as given. Issue #135.

## Setup

Claude Code 2.1.293, `claude -p "/eklavya:quiz caching"` in an empty git
repository, `--setting-sources project,local`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`,
and a fresh `EKLAVYA_HOME` per run holding a `.backup` copy of the maintainer's
database (602 concepts). Before: `git archive origin/main` (`af7f8ff`) as the
plugin directory with the installed 1.52.3 runtime, whose planner is the same
as `main`'s. After: this branch as the plugin directory, running its own
`mcp/dist`. The allowed tools were `get_learner_profile`,
`get_session_quiz_plan` and `get_config`.

## Results

| Arm | Plan argument | Plan | What Claude said | Concepts after |
|---|---|---|---|---|
| before | `slugs: ["caching"]` | `no_candidates` | No concept called `caching`; offered `http`, `system-design` and `/eklavya:learn caching` | 602 |
| after | `slugs: ["caching"]` | 2 questions (`cache-storage-outlives-deploy`, `static-site-cache-headers`) | Asked question 1 of 2, on Cache Storage surviving a deploy | 602 |

The same planner, called directly on the copy, gave: `redux` nothing (it no
longer lands on the `ux` domain), `access` three access concepts (not the `css`
domain), `auth` the `web-auth` domain plus concepts with a word starting "auth", `docker` nothing.

## Limitations

One run per arm. No answer was given, so nothing was graded. `-p` mode has no
`AskUserQuestion`, so the question arrived as text. A run
on this branch where `caching` plans nothing, or where a topic word lands on a
domain it only contains as letters, would disprove the change. Transcripts
stay local.
