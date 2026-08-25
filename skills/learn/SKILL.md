---
name: learn
description: Run a structured Eklavya teaching session on a topic, ordered by prerequisites and calibrated to what the developer already knows.
disable-model-invocation: true
---

# /eklavya:learn <topic>

Teach `$ARGUMENTS` properly. This is a lesson, not a quiz — but it is still a conversation, and it still records what was learned.

1. `get_learner_profile` for the topic's domain. Note `suggested_tier`.
2. `get_concept_graph` with `include_mastery: true` and `unmastered_only: true`. The order returned **is** the teaching order: prerequisites come before what depends on them.
3. If the topic isn't a known domain, ask which of the existing domains is closest, or teach from first principles and `upsert_concepts` as you go.

Then, for each concept in order, and **at most 5 per session**:

- Start from what they already know — the profile tells you what that is. Never re-explain a mastered prerequisite; reference it in a clause and move on.
- Explain in a short paragraph, then show it in code from *this repo* if it appears here. Concrete beats general.
- Ask one question at `suggested_tier` to check it landed, and grade it with `record_attempt`.
- If they miss it, that concept is not done. Come at it from a different angle before moving on.

Stop when you hit five concepts or they've had enough. Close with what to review next and when — `next_review` from the recorded attempts tells you.

Never lecture for more than two exchanges without asking something.
