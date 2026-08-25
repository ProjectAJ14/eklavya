---
name: quiz
description: Start an Eklavya quiz now, on this session's work or on a named topic.
disable-model-invocation: true
---

# /eklavya:quiz [topic]

Quiz the developer now. Follow the `tutor` skill for how to ask and grade — this command only decides *what* to ask about.

**Topic given** (`$ARGUMENTS` is non-empty): treat it as a domain or concept.
1. `get_learner_profile` with that domain.
2. `get_concept_graph` for the domain with `include_mastery: true`, `unmastered_only: true`.
3. Pick up to 4 concepts: weakest and due-for-review first, prerequisites before dependents.

**No topic**: quiz this session's work.
1. `get_learner_profile`.
2. `get_session_quiz_plan`.
3. If `questions_needed` is 0, say why in one line and stop:
   - `cooldown` → "Nothing due right now — you were just quizzed."
   - `mode_off` → "Eklavya is off. `/eklavya:setup` to turn it back on."
   - otherwise → "Nothing logged this session yet, so there's nothing grounded to ask about."

Then ask one question at a time at each concept's `tier_to_ask`, grade every answer with `record_attempt`, and close with one line: what moved, and what comes back for review when.
