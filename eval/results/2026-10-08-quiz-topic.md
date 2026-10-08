# Quiz topic: domain or slugs, and no minting, 2026-10-08

Change: `skills/quiz/SKILL.md` reads the domain list from
`get_learner_profile` (no `domain`) and passes the topic as `domain` only when
it names one exactly, otherwise as `slugs`. An empty topic plan now offers the
closest domain and `/eklavya:learn`, and the skill forbids minting concepts.
The old step 3 sent the model to `get_concept_graph` to "see what domains
exist", which that tool cannot do: it needs a domain and returns an empty list
for an unknown one.

## Setup

Claude Code 2.1.293, `claude -p "/eklavya:quiz <topic>"` in the `talea`
checkout, `--setting-sources project,local`, one `--plugin-dir` per arm (main
at `8063d27` before, this branch after), `ENABLE_CLAUDEAI_MCP_SERVERS=false`,
and a fresh `EKLAVYA_HOME` per run holding a `.backup` copy of the
maintainer's database (593 concepts). Both arms ran the installed 1.52.2
runtime, so only the skill differed. The init event also listed three
organisation-managed plugins with no Eklavya tools in each arm.
`background-update-communication`, the slug from 2026-10-04, no longer exists
in the database, so a live slug stood in for it.

## Results

| Topic | Arm | Plan argument | What Claude said | Concepts after |
|---|---|---|---|---|
| `electron-net-fetch` (a concept) | before | `domain` | One question (the 2026-10-04 planner fallback rescued it) | 593 |
| `electron-net-fetch` | after | `slugs` | One question | 593 |
| `self-update-rollout` (unknown) | before | `domain` | Offered `ci-cd`, then: "Reply `add it` and I'll create a self-update topic from talea's update code, then quiz you on it." | 593 |
| `self-update-rollout` | after | `slugs` | Said nothing by that name is due; offered `release-engineering`, `ci-cd` and `/eklavya:learn self-update-rollout` | 593 |

The before arm on the unknown topic also called `get_concept_graph` with the
unknown domain (empty) and then the profile without a domain to find the
domains, which is the path the new step 1 takes directly.

## Limitations

One run per cell. No answer was given, so nothing was recorded or minted in
any arm; the minting is an offer, as in the 2026-10-04 report. A run on this
branch that offers to create concepts in a quiz, or that passes an existing
domain name as `slugs`, would disprove the change. Transcripts stay local.
