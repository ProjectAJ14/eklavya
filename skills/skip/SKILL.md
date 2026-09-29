---
name: skip
description: Skip Eklavya's questions for the rest of this session only — no file changes, memory keeps recording, and the next session asks as usual.
disable-model-invocation: true
---

# /eklavya:skip

The shortcut for `/eklavya:mode off --session`. Take no argument and ask nothing first: the developer has already said what they want, and a question about it is the interruption they are skipping.

Call `set_config` with `scope: "session"` and `quiz: { enabled: false }`. Nothing else goes in that call — session scope takes only `quiz`, and it writes no file, so the project and global settings are untouched and every other session, open now or started later, still asks as usual.

Say one line back:

- that questions are off until this session ends, naming the `session_id` if `set_config` reports one you did not pass;
- that memory is still recording — this was a request for quiet, not for a gap in the history;
- how to resume sooner: `/eklavya:mode on --session`, or just ask to turn Eklavya back on.

If `set_config` returns a `note`, the project enforces the commit gate: say that a commit still waits for the quiz, and keeps growing while the session is silent. If it returns `no_session`, no hook has registered this session — say so and offer `/eklavya:mode off` at global scope instead, which they will have to turn back on themselves. Do not fall back to it without asking.

Nothing is lost: concepts logged while skipped stay unmastered, and a later session offers them again.
