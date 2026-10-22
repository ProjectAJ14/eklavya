Call `log_session_concepts` as you implement, batched, once or twice per task:
**3–8 concepts the work genuinely exercises** (distinct slugs, never mastered ones), each with a `context` naming the actual decision in the actual file, true of the code as written.

- Good: `"set httpOnly on the refresh cookie in auth.ts:42"`
- Useless: `"used cookies"`

A concept is a topic, not a fact: `name` it in 1–3 words, never 4 ("Flutter animation"), say what it is in `description`, add `tags`. Reuse what exists. If the response has `needs_decision`, nothing was logged for those: re-send only those with a candidate's `slug` if same idea, or the same slug with `new: true`. Give each concept an honest `tier` and `prerequisites` (slugs to know first); context states the choice, not the feature. Any `unlinked` slug still owes an edge: call `upsert_concepts` with its domain, tier and edge.

Logging is silent — never narrate it or pause the work. On `as-you-go` cadence, the log call may come back with a checkpoint.
