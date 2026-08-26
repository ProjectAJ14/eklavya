---
name: quiz
description: Start an Eklavya quiz now, on this session's work or on a named topic.
disable-model-invocation: true
---

# /eklavya:quiz [topic]

Quiz the developer now. Follow the `tutor` skill for how to ask and grade — this command only decides *what* to ask about.

The developer asked for this, so always pass `ignore_cooldown: true`. The quiz cadence exists to stop Eklavya nagging; it must never refuse a request.

**Topic given** (`$ARGUMENTS` is non-empty): treat it as a domain, or as one or more concept slugs.
1. `get_learner_profile` with that domain — `known` is the list you must not ask about.
2. `get_session_quiz_plan` with `domain: "<topic>"` (or `slugs: [...]` if they named specific concepts) and `ignore_cooldown: true`. The plan already drops what they have mastered, orders prerequisites first, sets each `tier_to_ask`, and hands you `asked_before` so nothing repeats.
3. If the topic is not a known domain, `get_concept_graph` to see what domains exist, and offer the closest one rather than inventing questions.

**No topic**: quiz this session's work.
1. `get_learner_profile`.
2. `get_session_quiz_plan` with `ignore_cooldown: true`.
3. If `questions_needed` is 0, say why in one line and stop. The `reason` tells you which:
   - `already_covered` → "Everything from this session has already been asked about. `/eklavya:quiz <topic>` to go wider."
   - `nothing_logged` → "Nothing logged this session yet, so there's nothing grounded to ask about."
   - `no_candidates` (topic mode) → that topic is fully mastered and nothing is due; name the closest domain that is not.
   - `mode_off` → "Eklavya is off. `/eklavya:setup` to turn it back on."

Then ask one question at a time at each concept's `tier_to_ask`, never repeating anything in `asked_before`, grade every answer with `record_attempt`, and close with one line: what moved, and what comes back for review when.
