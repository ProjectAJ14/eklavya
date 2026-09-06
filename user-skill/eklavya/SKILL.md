---
name: eklavya
description: "Operate Eklavya, the local learning tool that quizzes this developer on the code their agent writes. Use when the user mentions Eklavya by name, or asks to change how often or how hard it quizzes them (its mode, focus, cadence or difficulty dials), see their learning progress or mastery, open the learning dashboard, check the commit gate, or find where their learning data lives. Do not use for ordinary coding help, for teaching a concept, or merely because a task is educational."
---

# Eklavya

Eklavya turns the time an agent spends generating code into learning: it logs
the concepts each task touches, quizzes the developer on them, and tracks
mastery with spaced repetition. Everything is local — one SQLite database, no
network.

This skill is for *operating* Eklavya: reading its state and changing its
settings on request. Teaching is a different job, and the `tutor` skill has it.

## Find the binary first

`eklavya` is usually **not on `PATH`**. `npx eklavya install` puts the runtime
under `~/.eklavya/runtime`, and npm does not link a `--prefix` install globally.
Resolve it once:

```bash
command -v eklavya || command -v "$HOME/.eklavya/runtime/node_modules/.bin/eklavya"
```

That prints the path to use, or nothing. Shell variables do not survive between
tool calls, so **write the resolved path into every later command** rather than
setting `EK=` and hoping it is still there. On Windows the runtime binary is
`eklavya.cmd` in that same `.bin` directory, and `EKLAVYA_RUNTIME` overrides the
location if it is set.

If it prints nothing, fall back to `npx -y eklavya <command>`, which downloads
on first use. If that fails too, Eklavya is not installed: say so and give the
one command that fixes it — `npx eklavya install` — rather than guessing at a
path.

Examples below write `eklavya` for readability. Substitute whatever the line
above resolved to.

## Prefer the MCP tools when they are there

In a Claude Code session with the Eklavya plugin loaded, `get_config`,
`set_config`, `get_learner_profile`, `get_concept_graph` and `get_gate_status`
are available as tools. Use them: they validate the values, they report which
settings a repo is overriding, and they need no subprocess.

The CLI is the fallback for everywhere else — a plain terminal, Cursor, a
session where the plugin is not enabled. The two write the same files, so it
never matters which one a given change went through.

## The four dials

Independent, and conflating them is the usual confusion. Say which one is
changing.

| Dial | Question it answers | Values | Default |
|---|---|---|---|
| `mode` | How hard does Eklavya push? | `ambient`, `enforced`, `off` | `ambient` |
| `focus` | What does it teach? | `project`, `concept`, `learn` | `concept` |
| `cadence` | When do the questions land? | `interleaved`, `end` | `interleaved` |
| `difficulty` | How hard may they get? | `auto`, `easy`, `medium`, `hard` | `auto` |

- `ambient` offers questions and respects the quiz cooldown; `enforced` ignores
  that cooldown, asks a full round rather than one question, and gates commits;
  `off` is dormant and `focus` is never read.
- `project` quizzes the code just written. `concept` asks the transferable
  version of the same idea. `learn` follows `focus_topic`.
- `interleaved` asks one question mid-task, at the seam where a concept was
  logged. `end` holds everything until the task finishes. Neither asks *more*
  questions: `max_questions_per_task` is the budget either way.
- `auto` earns the level per project — everyone starts at `easy` and climbs on
  evidence. A literal level **pins** it and stops progression.

Set one:

```bash
eklavya config set mode enforced          # global: ~/.eklavya/config.json
eklavya config set difficulty easy --repo # this project only: .eklavya.json
```

`focus learn` is useless without a topic, so pass both at once:

```bash
eklavya config set focus learn --topic "database indexing"
```

Repo config wins over global. When someone's personal setting has stopped
applying, that is why — `config get` prints both paths, and `eklavya doctor` or
`get_config` names the keys the repo is overriding.

Other keys, same `config set` shape: `pass_threshold`,
`max_questions_per_task`, `min_minutes_between_quizzes`,
`min_minutes_between_checkpoints`, `level_up_after`, `level_up_accuracy`,
`max_new_concepts_per_session`, `max_stop_blocks_per_session`, `quiet`.

## Reading state

```bash
eklavya doctor      # is it wired up: runtime, driver, plugin, skill, database, config, level
eklavya config get  # the effective config, and which file each half came from
eklavya db-path     # where the learning history lives
```

## When Eklavya has stopped working

Reach for this whenever someone says Eklavya has gone quiet, stopped asking
questions, or seems to have switched itself off. It never fails loudly — every
hook exits successfully by design, so it can't break a session — which means a
broken install and a quiet one look the same from the outside.

Run `eklavya doctor`. Its first four lines are the install itself: `runtime`,
`driver`, `plugin`, `skill`. If any says `FAILED`, it exits non-zero and prints
the fix.

The fix is almost always `eklavya install`. It is idempotent — it reinstalls the
runtime, re-copies the plugin and rewrites the registration, and never touches
the learning history. Two cases it can't fix on its own, and `doctor` says which:

- **the plugin is registered but not enabled** — something switched it off in
  `~/.claude/settings.json`; re-enable it there or with `/plugin`.
- **the skill is a different skill named eklavya** — they have their own
  `~/.claude/skills/eklavya/`. Never overwrite it. Tell them to move theirs
  first, then run `eklavya install`.

Restarting Claude Code is what picks up a repaired install — the plugin and MCP
server are read at session start. There is no background process to restart.

## The dashboard

```bash
eklavya dashboard              # opens http://127.0.0.1:41729 in their browser
eklavya dashboard --port 8080
eklavya dashboard --no-open    # serve it, print the URL, open nothing
```

It binds to loopback only and reads the local database — that is the whole
security model, and it is worth saying when someone asks where their data
goes. The process runs until interrupted, so start it in the background and
hand back the URL rather than blocking the session on it.

It opens the browser itself, so do not tell them to click the URL. Use
`--no-open` when they only asked *where* the dashboard is, or when the session
is on a machine with no desktop.

Six sections, each deep-linkable — hand back the one that answers what was
actually asked rather than the bare root:

| Ask | Link |
|---|---|
| how am I doing, streaks, activity | `/#/overview` |
| what am I learning, search a concept | `/#/concepts` (or `/#/concepts/due`, `/mastered`, `/unseen`), `/#/concept/<slug>` for one |
| what is due, what is scheduled, what I skipped | `/#/review`, `/#/review/upcoming`, `/#/review/skipped` |
| what did that session teach me | `/#/sessions` |
| how hard is this repo allowed to get | `/#/projects` |
| where are the gaps | `/#/domains` |

## When the plugin is loaded, point at the commands

These do more than this skill should reimplement. Name the one that fits and
let the user run it:

| Command | For |
|---|---|
| `/eklavya:progress` | the mastery map — what stuck, what was skipped, what is due |
| `/eklavya:quiz [topic]` | a quiz right now, ignoring the cooldown |
| `/eklavya:learn <topic>` | a structured lesson ordered by prerequisites |
| `/eklavya:mode` | the dials, explained and changed in a conversation |
| `/eklavya:level` | the per-project difficulty band and progress through it |
| `/eklavya:gate` | commit-gate status for this session |
| `/eklavya:pack [domain]` | write a concept pack, so Eklavya can quiz on a domain or a codebase it does not know |
| `/eklavya:setup` | first-run setup |

If they are asking to *be taught*, that is `/eklavya:learn` or the `tutor`
skill, not this one.

## Rules

- Never run `eklavya uninstall --purge` unless the user has said, in this
  conversation, that they want their learning history deleted. It is months of
  spaced repetition and it does not come back.
- Do not set `focus: learn` as a side effect of a lesson. It changes what every
  later session asks about; ask first.
- Report a dial change in one line — the key, the new value, and which file it
  landed in. Do not re-explain the dial they just set.
- A repo-scoped change writes `.eklavya.json` at the repo root, which is a
  tracked file in most projects. Say so when you write one.
