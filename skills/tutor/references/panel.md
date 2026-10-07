# Asking in the panel

Required reading when the plan's `presentation` is `"panel"`, on top of
`writing-mcq.md`. Anywhere a plan has no `presentation` field, or says `"tool"`,
this file does not apply.

The question goes to the Claude Code side panel instead of an `AskUserQuestion`
card. Parts 1 to 5 of `writing-mcq.md` are exactly the same: the
same stem, the same cold reader, the same three distractor rules, the same
`answer_position`. Part 6 does not apply, because the panel is its own
attribution: no `header`, no `[Eklavya]` line, and no `ask_attribution` in the
plan.

Make one call to `present_question` instead:

- `slug`, and `question` (the stem alone), and `difficulty` (the plan's
  `tier_to_ask`).
- `options`: four, in display order, each `{label, description, grade}`. The
  `label` is the option itself, a complete claim (what `writing-mcq.md` calls the
  option), never `A` or `1`: the panel numbers them, and a bare marker is rejected.
  The `description` is the one clause from part 4. Mark the right one
  `correct: true`, **in the `answer_position` slot** (the call is rejected with
  `wrong_answer_position` otherwise, and nothing is stored).
- Each option's `grade` is what a learner who picks it has shown, on the scale in
  `grading.md`: **4** for the right option, **2** for a distractor that has the
  shape of the idea (rows two and four of the table), **1** for one built on a
  misconception (rows one and three). Grade 3 is not available to a pick: only
  typed words can show a hesitant "right".
- `more: true` only in an explicit round (the plan has more items after this one, as for `/eklavya:quiz`): the panel then offers a Next button. Leave it out otherwise. Once a round is planned the server tracks it: the last question's `more` is set false for you, and Next arrives as a prompt telling you to call `get_session_quiz_plan` with `resume_round: true`.
- `explanation`: one line saying why the right option is right. The panel shows
  it after the answer, so it is the whole of your feedback.

It returns at once. Do not wait for the answer, do not call `record_attempt`
(the panel records it, once), do not give a verdict, and go straight back to
the task. One question may be open per session: a second call is rejected with
`question_open`, so do not ask another until the plan offers one.

If the call is rejected with `panel_disabled` or `panel_unavailable`, the panel
is not showing questions here: call `get_session_quiz_plan` again and ask the
card way, following its `ask_attribution`. Never ask the same question in both.
