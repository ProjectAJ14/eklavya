# Eklavya

[Eklavya](https://github.com/ProjectAJ14/eklavya) teaches the concepts behind
agent-written code and keeps local project memory. This package includes the
Claude Code plugin, installer, CLI and MCP server.

## Install in Claude Code

With Claude Code and Node.js 22+ with npm:

```bash
npm install -g eklavya && eklavya install
```

The installer uses the defaults without settings questions and keeps saved
choices. It registers the plugin, installs the managed runtime and chat/artifact
skills, and prepares local storage. New installs have the quiz side panel,
memory and prompt feedback on. Memory summaries and prompt feedback use
`claude-sonnet-5` through your Claude Code login, so captured session evidence
goes to that model. [Memory](https://eklavya-run.web.app/docs/memory/) explains
what is captured and how to use local summaries instead.
If Claude Mem is installed, it keeps recording and Eklavya memory stays off
until you [switch recorders](https://eklavya-run.web.app/docs/migrating/).

[Allow Eklavya's ten tools in auto mode](https://eklavya-run.web.app/docs/installing/),
then restart Claude Code. `/eklavya:setup` is an optional installation check.

Read the [installation guide](https://eklavya-run.web.app/docs/installing/) for
verification and [updates and removal](https://eklavya-run.web.app/docs/updates/)
for maintenance. Uninstall preserves learner data unless you explicitly use
`--purge`.

## Standalone MCP connection

An MCP client can connect directly:

```json
{
  "mcpServers": {
    "eklavya": { "command": "npx", "args": ["-y", "eklavya", "serve"] }
  }
}
```

This exposes tools. Automatic capture, checkpoints and session instructions
depend on host integration; an MCP connection alone does not provide Claude
Code's learning loop.

## Available tools

| Purpose | Tools |
|---|---|
| Learner state and concepts | `get_learner_profile`, `log_session_concepts`, `upsert_concepts`, `get_concept_graph` |
| Questions and assessment | `get_session_quiz_plan`, `record_attempt`, `get_gate_status` |
| Quiz side panel (experimental) | `present_question` for the model; `panel_sync` and `panel_answer`, called only by the panel mod, never by the model; its header stacks the mark above the topic in a pane under 60 cells wide |
| Settings | `get_config`, `set_config` |
| Find and read memory | `memory_search`, `memory_get`, `memory_timeline`, `memory_file_history`, `memory_status` |
| Maintain memory | `memory_write`, `memory_correct`, `memory_delete`, `memory_collections` |
| Inspect code | `code_outline`, `code_find_symbol` |

`log_session_concepts` and `upsert_concepts` take a concept name of 1 to 3 words, a `description` of up to 400 characters and up to 5 `tags`. A new concept that resembles existing ones is not created: the response lists it under `needs_decision` with candidates, and you reuse a candidate's slug or repeat the slug with `new: true`. `log_session_concepts` creates a new concept with the domain and tier you pass, or domain `general` and tier 2 when you pass none. Pass `prerequisites` (up to 5 slugs, existing or in the same call) and each becomes a `prerequisite_of` edge; a slug it cannot find is reported under `prerequisites_not_found`, and the response lists the created concepts that still have no edge under `unlinked`. `upsert_concepts` sets the domain and tier of a model-created concept that still has domain `general`, adds tags to any concept, fills in or refines the description of a model-created concept, and adds edges. It never rewrites the description or domain of a concept from the seed or a pack, or of one that already has a domain (the one it was logged with, or its first tag). Its response lists the concepts it changed under `updated`. `get_concept_graph` returns each concept's `tags`.

`memory_collections` applies a saved filter the same way with or without a
query, and its members are live entries only: a member deleted or corrected
after the last rebuild drops out of `show`, and its replacement joins at the
next `rebuild` if the filter matches it.

`record_attempt` returns the `attempt_id` of the row it wrote. For a
multiple-choice question, also pass `correct` (the right option's label,
verbatim), which lets the learner correct a missed answer from its explainer
page in the dashboard, where the server grades the new pick, and `option_notes`
(the note under each option, in order), which that page shows under each option. A `correct` that is not one of
the options, or notes of the wrong length, is stored as nothing and reported
back (`correct_mismatch`, `option_notes_mismatch`); the answer is still kept.
An `outcome` of `invalid` means the question itself was at fault (it assumed context the learner never saw, or two options both answered it): it is stored in `invalid_questions`, grades nothing, returns no `attempt_id`, and changes no mastery, level, review date or gate; only the repeat check reads it. Each time the option-length check returns a question for a rewrite, `option_checks` (migration 028) keeps the session, concept, surface (`panel` or `card`) and outcome (`sent_back`, then `rewritten` or `unchanged`), never the options; no score, level or gate reads it, and `npm run eval -- history` reports it. An `outcome` of `declined` or `dont_know` with a grade of 3 or more is
contradictory: it returns `error: "outcome_grade_conflict"` and records
nothing, so that call can never update mastery, clear a gate or count toward a
level.

`present_question` is how the model asks in the experimental side panel
(`quiz.panel`) instead of `AskUserQuestion`, when the plan's `presentation` is
`"panel"`: the stem, four options each with a description and a grade (4 for the
right one, 2 for a near miss, 1 for a misconception), the right one in the
plan's `answer_position` slot, and an explanation. It stores the question and
returns at once; it writes no attempt. The panel records the answer through
`panel_answer` with the same code `record_attempt` uses, exactly once. `kind: "dont_know"` (the panel's **New to me — Teach me** button) records `dont_know` with grade 0, replies with the right answer and `taught: true`, and always carries `explain`. On a miss with `explain_on_wrong` on, its reply carries the same `explain` block `record_attempt` returns, and the panel starts the explainer agent from it. `present_question` sends a question back once with `conspicuous_options` (nothing stored) when one option's label plus description outruns the next by a few words or a description explains itself, and presents the same stem as written on the second call. It returns `panel_disabled` while `quiz.panel` is off, and
`panel_sync` returns `{disabled: true}` and expires the session's open question without recording an attempt, so turning the panel back on cannot revive it; `panel_answer` answers only a question
that already exists. A round the learner asked for (a topic, `max`) is remembered per session: `present_question` takes each question off it and sets the last one's `more` false, and `get_session_quiz_plan` with `resume_round: true` plans what is left. This is
a Claude Code mod feature: a standalone MCP client has the tools but not the
panel that calls the other two.

Search first, choose relevant entries, then use `memory_get` for their full
content. Pass `memory_get` the `receipt_id` a recall block names to link the
read to that recall. Calls to `memory_search`, `memory_get`, `memory_timeline`
and `memory_file_history` are logged locally either way, with entry IDs,
outcome, latency and size but never the query or content. Session-aware learning and configuration tools resolve the current session
when `session_id` is omitted. In `memory_timeline`, it instead filters results
to one session; omission shows the project timeline. Other tools may not accept
that argument.

`memory_get` reads only this project's entries unless `all_projects` is true;
an ID from another project comes back under `other_project`. `memory_correct`
and `memory_delete` refuse another project's ID with `other_project` and change
nothing. A correction writes its replacement and the supersession together, and
sync carries it to other devices.

`memory_delete` can be repeated safely: a second soft delete changes nothing,
and `hard: true` erases an entry that was already soft-deleted. The keyword
index holds only entries that are not deleted.

## CLI and data

```bash
npx eklavya doctor
npx eklavya memory status
npx eklavya config get            # or: config get quiz.enabled
npx eklavya dashboard
npx eklavya feedback generate
npx eklavya db-path
npx eklavya --version
```

The [CLI reference](https://eklavya-run.web.app/docs/cli/) lists all commands and
flags. `feedback generate` reviews one of your earlier prompts, using what your later prompts in that session had to add, when `feedback.enabled`,
memory and `providers.observer` are set. Once a day, after your first answer, the Learning dashboard opens one card on arrival (a milestone, a welcome back, the most overdue concept and so on), chosen by the engine in `assets/daily-card.cjs`; the Daily card switch on Settings, Companion, turns it off. Dashboard counts of 1,000 or more read short (1K, 1.2K, 1M). The dashboard reads the database (its Concepts page shows each concept's tags and filters by one with `?tag=`) and has five guarded writes: a setting
change, a correction of a missed answer (which can also complete a level), and acknowledging, deleting or counting the opening of a
feedback item (`POST /api/feedback/acknowledge`, `/delete`, `/opened`; the reads are `GET /api/feedback` and `/api/feedback/list`). An open page listens to
`GET /api/events`, a stream of the change cursor (a counter that moves on every
write it would show; `/api/cursor` returns the same value on its own), and redraws in place
when it moves. In a repository checkout, `node mcp/scripts/dashboard-perf.mjs`
times the dashboard's builders, payload and routes on a seeded database, and
`--live` times a write reaching an open page in headless Chromium
([how to run it](https://github.com/ProjectAJ14/eklavya/blob/main/CONTRIBUTING.md#dashboard-performance)). A request
it cannot parse gets a 400 without stopping the server
([what it is, underneath](https://eklavya-run.web.app/docs/dashboard/#what-it-is-underneath)).
Its Learning page shows your streak and its calendar under the summary tiles, with the archer and a short line beside the streak; a
**To be corrected** tile there and on the Artifacts page counts missed answers still
waiting for a correction; correcting one closes its dialog after three seconds unless you choose **Stay open**. The
review page lists due concepts as cards; opening one shows the steps to quiz that single concept in
Claude Code or Claude desktop, in the project's folder when that folder is available. Every Copy button
answers with a toast.
Its feature tips show the archer companion and use Driver.js, bundled in `dist/` at build and served by the
dashboard itself at `/vendor/driver-hints.js` and `/vendor/driver-hints.css`, so
the page still requests nothing from another host. [Configuration](https://eklavya-run.web.app/docs/configuration/) lists
defaults and scopes. The [memory guide](https://eklavya-run.web.app/docs/memory/)
covers retrieval, processing, providers, privacy and sync.

State is local under `~/.eklavya/`, including `knowledge.db` (SQLite, WAL).
`EKLAVYA_HOME` and `EKLAVYA_DB` override those paths. Questions and memory have
independent switches. Set `providers.observer` to `null` for local memory
summaries and no prompt feedback. The observer's instructions are scored by
`eval/gepa/memory/`, and an end-of-turn batch's output schema requires its
checkpoint. Each feedback item leads with a verdict that
says, in words and never a score, whether the prompt left each area clear, left
it out or did not need it (an older item says "Not flagged" for an area it
did not name), and shows the project, host, session and time it came
from, read from memory when you open it;
see [your data](https://eklavya-run.web.app/docs/your-data/). Anonymous daily
usage counts are on by default and never include paths, names or text;
[usage analytics](https://eklavya-run.web.app/docs/usage-analytics/) lists every
field, and `eklavya telemetry off` stops them.

MIT.
