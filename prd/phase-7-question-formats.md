# Phase 7 — Question formats

**Status:** phase 1 (multiple choice) implemented
**Spec:** PRD §10b, §7 (migration 006)

## The problem

Observed in real use: mid-task, in an unrelated project, Eklavya asked four tier-2 mechanism questions as blank prompts. *"Walk me through what the browser does with this."*

The honest response to that, while you are in the middle of removing a type somewhere else, is nothing. Not because you do not know — because typing a paragraph costs more than the question is worth right then. And the system cannot tell those apart: silence and ignorance record identically.

The quiz was well-targeted and unanswerable. The interface was the failure, not the pedagogy.

## Phase 1: multiple choice everywhere

Every question is now asked with **`AskUserQuestion`** — four options, one correct, three plausible. Answering is a keystroke.

`format_to_use` on each plan item carries this, rather than the tutor deciding per question. Same reasoning as `tier_to_ask`: a shape chosen ad hoc by whoever is writing the question is a shape that drifts. Today it always returns `mcq`; phase 2 makes it a real choice.

### The escape hatch

`AskUserQuestion` appends an "Other" option automatically, which is where *"I don't know"* goes — and that remains the single most valuable answer in the system, the one that triggers teaching rather than a note in a table.

Four real options plus Other was chosen over three options plus an explicit "not sure" button. Three distractors is a meaningfully harder question than two, and the escape is one keystroke either way. The cost is discoverability. That was originally paid for by setting `header` to `unsure→Other` on every question; the chip now reads `Eklavya` instead, because attribution turned out to matter more — a question arriving mid-task with no name on it reads as the agent going off-piste. "Other" is still appended by the tool and still one keystroke; it is just no longer advertised in the header.

Someone who picks Other and types a real explanation has given *better* evidence than the options could. That records as `format: "open"` and the cap below does not apply.

### The grade cap

Recognition is not recall. Picking the right option out of four is weaker evidence than producing the answer, and one in four is a coin.

`record_attempt` caps `mcq` at **grade 4** and returns `grade_capped: true` when it does. Enforced server-side, not left to the tutor to remember — a rule that depends on the model recalling it is a rule that erodes, and inflated mastery is the one failure that makes the whole record worthless.

Grade 4 still reaches `known` (0.8 ≥ the 0.7 threshold), so this slows how fast mastery is claimed rather than capping how far anyone can get. Two clean multiple-choice answers still master a concept.

### Options are not part of the question

`attempts.question` is what gets fingerprinted for *never ask the same question twice* (PRD goal 2). Baking four shuffled options into that string would make every reshuffle look like a brand-new question and silently undo the guarantee.

So migration 006 adds two columns, not one: `format` (what shape it was) and `options` (a JSON array, stored beside the stem). `format` is recorded rather than inferred from whether `options` is NULL, because that inference works today and breaks the moment a format arrives with no options.

### The subagent cannot do this

`agents/tutor.md` has no `AskUserQuestion` — its tool list is read-only graph access. It renders the same four options as lettered text and takes a letter back. Same rules otherwise: same distractor bar, same cap, same stem-only recording. Only who draws the box changes.

## Phase 2 (not implemented)

Two more formats, and rotation between all three:

| format | cognition | fits |
|---|---|---|
| `mcq` | recognition (easiest) | new or weak concepts, tier 1–3 |
| `fill_blank` | cued recall | tier 1–3, syntax and API-level facts |
| `open` | free recall (hardest) | tier 4–5 — failure modes and design cannot honestly be multiple choice |

The important design note for whoever picks this up: **format is a difficulty dial, not decoration.** Blind rotation would put a multiple-choice question on a tier-5 design question, where four options cannot represent the answer space. Rotation has to be bounded by tier and mastery, which is why `format_to_use` is computed server-side alongside `tier_to_ask` rather than being a preference the tutor applies.

The CHECK constraint in migration 006 already accepts all three values, so phase 2 needs no schema change.

A second question worth settling then: whether a concept should be allowed to reach `known` on multiple-choice evidence alone, or whether mastery should require at least one correct `fill_blank` or `open` answer. The grade cap is the cheap approximation; that would be the honest version.
