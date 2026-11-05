# CLAUDE.md memory section, third wording (2026-11-05)

The shipped text is the final run below; the first table measured a draft
whose search bullet was not limited to sessions with a recall block.

The second wording (`2026-11-05-memory-claudemd-v2.md`) said "call no memory
tool" when no listed title is about the task. In a real session that rule also
stopped every later lookup: recall offered entries on Mirth and Key Vault to
later prompts and Claude neither opened them nor searched when the work moved
on. This wording keeps "do not search" for the task the session started on,
says to open a matching title in any recall block, and adds one search when the
work later turns to something new.

Run: `claude-opus-5-5`, 5 trials per arm, plugin at this branch,
`--claude-md eval/fixtures/memory-use/claude-md-section.md` (v3) or the v2 text
for the `claudemd-v2-shift` label. 30 sessions in three runs: 5.68M input
tokens (5.22M cached) and 63k output, $5.99 at list price (first run of 20:
3.94M in, 3.63M cached, 43k out, $4.06; v2 shift: 721k in, 651k cached, 8k
out, $0.85; second v3 title run: 1.02M in, 943k cached, 12k out, $1.07).

New arm `unguarded-shift`: seed `searchonly` (the decision is a month old
behind sixty newer entries, so only a search finds it); the prompt starts on
`summarize` and then turns to the CSV export.

| Arm | Wording | Valid | `;` | Memory tool | `memory_search` | Decision fetched |
|---|---|---|---|---|---|---|
| unguarded-shift | v2 (shipped) | 5/5 | 0/5 | 5/5 | **0/5** | **0/5** |
| unguarded-shift | v3 | 5/5 | 0/5 | 5/5 | **4/5** | **4/5** |
| unguarded-shift | none | 5/5 | 0/5 | 4/5 | 4/5 | 4/5 |
| unguarded-title | v3 (two runs) | 10/10 | 7/10 | 10/10 | 0/10 | 10/10 |
| unguarded-irrelevant | v3 | 5/5 | 0/5 | 2/5 | 0/5 | n/a |

## Reading

- v2 suppresses the search that the session-start `SEARCH_RULE` otherwise
  causes: 0/5 against 4/5 with no section. v3 restores it to the no-section
  level. This is the defect the change fixes.
- Title-only recall is unchanged: every session opened the decision. The
  first v3 run had 2/5 `;`, the second 5/5; v2 measured 5/5. Across both runs
  7/10, within noise of v2 at n=5.
- Irrelevant memory: no searches (the first wording caused 4/5). Two sessions
  opened the unrelated A4 entry with `memory_get`; v2 had one. The arm's bar is
  at most 1 of 5 calls, so this is one over. Each call is one `memory_get`
  of about 300 tokens.
- In these draft runs `;` stayed 0/5 on the shift arm, including when the
  decision was fetched (the final run below had 3/5). The answers show why: sessions weigh a month-old note
  against the repo's comma sample, keep the comma and offer `;` as an option.
  That is how an entry is applied, not whether it is found, and every wording
  carries the same "check it against the current code" line.

Scores: `2026-11-05-memory-claudemd-v3-score.json`.

## Final run: search limited to sessions with a recall block

The draft's search bullet applied in every project, including ones with memory
off, because `~/.claude/CLAUDE.md` is global. The shipped text says "In a
session that has such a block" and adds "A session with no such block has no
Eklavya memory for this project: call no memory tool." Rerun on that text,
label `claudemd-v3-final`, 20 sessions: 3.45M input tokens (3.17M cached), 36k
output, $3.63 at list price. All four runs together: 9.13M input (8.39M
cached), 99k output, $9.62.

| Arm | Valid | `;` | Memory tool | `memory_search` | Decision fetched | Bar |
|---|---|---|---|---|---|---|
| unguarded-title | 5/5 | 5/5 | 5/5 | 0/5 | 5/5 | pass |
| unguarded-irrelevant | 5/5 | 0/5 | 1/5 | 0/5 | n/a | pass (at most 1 of 5) |
| unguarded-off (no block) | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 | pass |
| unguarded-shift | 5/5 | 3/5 | 5/5 | 3/5 | 3/5 | v2 had 0/5 search |

The scores file holds every trial from all four runs.
