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
2. `get_config`, then `get_session_quiz_plan` with `ignore_cooldown: true` and `max` set to the config's `max_questions_per_task`. Both arguments are there for the same reason: on the default `interleaved` cadence a plan is capped at one question, because Eklavya interrupting is not allowed to become a pile-up — but the developer typing `/eklavya:quiz` asked for a round, and a request is never refused or trimmed. A named topic (above) is already treated as a request; this branch has to say so.
3. If `questions_needed` is 0, say why in one line and stop. The `reason` tells you which:
   - `already_covered` → "Everything from this session has already been asked about. `/eklavya:quiz <topic>` to go wider."
   - `nothing_logged` → "Nothing logged this session yet, so there's nothing grounded to ask about."
   - `no_candidates` (topic mode) → that topic is fully mastered and nothing is due; name the closest domain that is not.
   - `quiz_disabled` → "Questions are off for this project. Memory is still recording — `/eklavya:mode` turns the questions back on." Do not say "Eklavya is off": it is not, and saying so is what sent people hunting for a bug that was a setting.
   - `session_off` → they silenced the questions for this session, and then asked for a quiz. Say so and offer the one step back: "Questions are off for this session — say the word and I'll turn them back on." Turn them back on with `set_config`, `scope: "session"`, `quiz: { enabled: true }` if they agree, then run the quiz.
   - `no_topic` → focus is `learn` with nothing set; ask what they want to learn, then `/eklavya:mode learn <topic>`.
   - `topic_unknown` → the graph has nothing matching their topic; offer the closest domain rather than inventing questions.

   If the plan carries `pending_elsewhere`, add one line after the reason naming those projects by folder name with their counts, most first: "Pending in other projects: eklavya (12), PiDom (3) — run `/eklavya:quiz` there." Say nothing about other projects when the field is absent.

**A named topic overrides the configured focus for this quiz only.** Someone who types `/eklavya:quiz caching` wants caching now; it is not a request to change their standing setting. Do not call `set_config` — `/eklavya:mode` is for that.

Then ask one question at a time at each concept's `tier_to_ask`, following the plan's `framing` field, never repeating anything in `asked_before`, grade every answer with `record_attempt` and tell them whether it was right before the next question, and close with one line: what moved, and what comes back for review when.
