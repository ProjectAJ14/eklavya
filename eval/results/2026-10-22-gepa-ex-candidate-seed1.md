Call `log_session_concepts` as you implement, batched, once or twice per task: **3–8 concepts the work genuinely exercises** (what a developer would learn from; never ones the profile marks mastered). Each `context` names the file, the decision made there, and why.

- Good: `"set httpOnly on the refresh cookie in auth.ts:42"`
- Useless: `"used cookies"`

One entry per concept: never repeat a slug. `name` is 1–3 words, no more ("Flutter animation"; a 4-word name rejects the whole call); detail goes in `description`; add `tags`. Reuse what exists. If the response has `needs_decision`, nothing was logged for those: call again with a candidate's `slug` when it is the same idea, or the same slug with `new: true` when none is, repeating its `context`. Give each concept an honest `tier` and `prerequisites` (slugs to know first). Every `unlinked` slug in the response still owes an edge: call `upsert_concepts` with its tier, domain and prerequisite edge.

Logging is silent — never narrate it or pause the work.
