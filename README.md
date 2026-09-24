<div align="center">

<img src="web/public/brand/mark.svg" alt="Eklavya bow-and-arrow icon" width="120" height="120">

# Eklavya

**Learn while your agent works — and carry project context forward.**

**[Visit the website →](https://eklavya-run.web.app/)**

*Named for Ekalavya, who mastered archery practicing before a silent statue of his guru. Here, the statue talks back.*

<img src="assets/checkpoint.gif" alt="A checkpoint question arriving in the middle of a task, answered in two keystrokes, and the work carrying straight on" width="760">

[![npm](https://img.shields.io/npm/v/eklavya?style=flat-square&color=0A5751&labelColor=16150f)](https://www.npmjs.com/package/eklavya)
[![license](https://img.shields.io/npm/l/eklavya?style=flat-square&color=0A5751&labelColor=16150f)](LICENSE)
[![node](https://img.shields.io/node/v/eklavya?style=flat-square&color=0A5751&labelColor=16150f)](https://nodejs.org)

</div>

Eklavya is a plugin for Claude Code. It does two jobs:

1. **It helps you understand the code Claude writes.** It asks you short
   questions about the work, while the work happens.
2. **It remembers what happened in your project.** The next time you open
   Claude, it can recall what you did last time.

Your learning history and memory are stored on your computer. There is no
Eklavya account. Eklavya sends anonymous daily usage counts, never code, paths,
names or text. [Every field is listed](https://eklavya-run.web.app/docs/usage-analytics/),
and `eklavya telemetry off` stops them.

## What you get

| Feature | In one line | Read more |
|---|---|---|
| Learning | Short questions about the code Claude just wrote. | [First session](https://eklavya-run.web.app/docs/first-session/) |
| Memory | Claude remembers your past work in this project. | [Memory](https://eklavya-run.web.app/docs/memory/) |
| Artifacts | Turn any explanation into a page with diagrams. | [Artifacts](https://eklavya-run.web.app/docs/commands/#the-artifacts-skill) |
| Dashboard | See your progress, memory and pages in the browser. | [Dashboard](https://eklavya-run.web.app/docs/dashboard/) |
| Dials | Choose what it teaches, when it asks and how hard. | [The dials](https://eklavya-run.web.app/docs/dials/) |
| Commit gate | Optional: pass a quiz before you can commit. | [Commit gate](https://eklavya-run.web.app/docs/commit-gate/) |

## Learning

Eklavya notices the ideas behind Claude's work, like "database index" or
"refresh token". Then it asks you about them.

| What it does | How it works | Read more |
|---|---|---|
| Asks while you work | One question at a time, in the middle of the task. Answer or skip. | [First session](https://eklavya-run.web.app/docs/first-session/) |
| Grades your answer | Each answer gets a grade and a short explanation. | [Grading](https://eklavya-run.web.app/docs/grading-engine/) |
| Brings topics back | Spaced reviews bring an idea back before you forget it. | [Grading](https://eklavya-run.web.app/docs/grading-engine/) |
| Grows with you | Each project starts easy. Good answers unlock harder questions. | [Levels and tiers](https://eklavya-run.web.app/docs/levels-and-tiers/) |
| Teaches a topic | `/eklavya:learn caching` gives a short lesson, basics first. | [Commands](https://eklavya-run.web.app/docs/commands/#eklavyalearn-topic) |
| Quizzes on demand | `/eklavya:quiz` asks about this session's work right now. | [Commands](https://eklavya-run.web.app/docs/commands/#eklavyaquiz-topic) |
| Adds new subjects | Comes with git, Node backend, React and web auth. Add more with `/eklavya:pack`. | [Concept packs](https://eklavya-run.web.app/docs/packs/) |

## Memory

Eklavya records what you and Claude do. It turns that into short notes called
**observations**. When you start a new session, Claude gets recent, relevant
notes to check against the code.

| What it does | How it works | Read more |
|---|---|---|
| Captures your work | Saves prompts, file edits and tool calls as you work. | [What gets captured](https://eklavya-run.web.app/docs/memory/#what-gets-captured) |
| Hides secrets | Skips files like `.env` and keys. Removes tokens and passwords before saving. | [What is never captured](https://eklavya-run.web.app/docs/memory/#what-is-never-captured) |
| Writes summaries | Groups work into observations and session summaries, on your machine. | [How observations are made](https://eklavya-run.web.app/docs/memory/#how-observations-are-made) |
| Recalls history | Gives Claude past work at session start and on related prompts. | [How recall works](https://eklavya-run.web.app/docs/memory/#how-recall-works) |
| Search and notes | Ask `/eklavya:memory` about a past change, save a note or fix a wrong entry. | [Commands](https://eklavya-run.web.app/docs/commands/#eklavyamemory) |
| Shows the savings | Estimates how much smaller recall is than the raw history. | [Savings](https://eklavya-run.web.app/docs/memory/#what-the-savings-percentage-measures) |
| Imports Claude Mem | Brings in your history from Claude Mem. | [Migrating](https://eklavya-run.web.app/docs/migrating/) |
| Syncs machines | Optional: share memory between your computers through a folder. | [Sync](https://eklavya-run.web.app/docs/configuration/#sync--memory-across-your-machines) |

Memory is only evidence. It never marks a topic as learned. Only a real answer
does that.

## Artifacts

Ask Claude to explain something "as an Eklavya artifact". You get an HTML page
with diagrams that you can print or save as PDF.

| What it does | How it works | Read more |
|---|---|---|
| Explainer pages | "Explain refresh-token rotation as an Eklavya artifact." | [Artifacts skill](https://eklavya-run.web.app/docs/commands/#the-artifacts-skill) |
| Help after a miss | Optional: after a wrong answer, a page explains the idea in the background. | [Configuration](https://eklavya-run.web.app/docs/configuration/#every-key) |
| One library | Pages are saved on your computer and listed in the dashboard. | [Artifacts dashboard](https://eklavya-run.web.app/docs/dashboard/#artifacts) |

## Dashboard

Run `eklavya dashboard` to open a local page in your browser. It has three
parts:

| Part | What you can see | Read more |
|---|---|---|
| Learning | Accuracy, mastery, reviews due, weak topics, sessions and projects. | [Learning pages](https://eklavya-run.web.app/docs/dashboard/#learning) |
| Memory | A timeline of past work, sessions, projects, savings and health. | [Memory pages](https://eklavya-run.web.app/docs/dashboard/#memory-pages) |
| Artifacts | Every saved page, grouped by project. | [Artifacts pages](https://eklavya-run.web.app/docs/dashboard/#artifacts) |

For a short summary in chat, use `/eklavya:progress`.

## The dials

Each setting works on its own. Memory has its own switch, so you can turn
questions off and keep memory on.

| Dial | Default | Other choices |
|---|---|---|
| `quiz.enabled` | `true`: ask questions | `false`: no questions |
| `quiz.enforced` | `false`: commit freely | `true`: pass a quiz before a commit |
| `focus` | `concept`: the idea behind the code | `project`: this codebase · `learn`: a topic you pick |
| `cadence` | `interleaved`: during the task | `end`: after the task |
| `difficulty` | `auto`: grows with you | `easy`, `medium` or `hard` |
| `memory.enabled` | `true`: record and recall | `false`: learning only |

By default Eklavya asks up to four questions per session on its own, at
least four minutes apart. `/eklavya:quiz` can always ask more. Change a dial with `/eklavya:mode` in Claude Code, or
`eklavya config set` in a terminal. See [the dials](https://eklavya-run.web.app/docs/dials/)
and [every setting](https://eklavya-run.web.app/docs/configuration/).

## Commands

| Command | What it does |
|---|---|
| `/eklavya:quiz [topic]` | Take a quiz now. |
| `/eklavya:mode [value]` | Show or change the dials. |
| `/eklavya:learn <topic>` | Take a short lesson. |
| `/eklavya:level [level]` | See your level or pick one. |
| `/eklavya:pack [topic]` | Add new topics, or topics from your code. |
| `/eklavya:progress` | See what you know and what is due. |
| `/eklavya:memory` | Search past work or save a note. |
| `/eklavya:gate` | See why a commit is blocked. |
| `/eklavya:setup` | Check the install and pick settings. |

You can also just ask, like "Space out Eklavya's questions". See
[all commands](https://eklavya-run.web.app/docs/commands/) and
[the CLI](https://eklavya-run.web.app/docs/cli/).

## Install

With **Claude Code and Node.js 22+** on macOS, Linux or Windows:

```bash
npm install -g eklavya && eklavya install
```

Accept the defaults, restart Claude Code, and start a task. Eklavya updates
itself in the background. See [Installing](https://eklavya-run.web.app/docs/installing/)
for other setups.

## Documentation

| I want to… | Read |
|---|---|
| Get started | [Installing](https://eklavya-run.web.app/docs/installing/) · [Your first session](https://eklavya-run.web.app/docs/first-session/) |
| Change how it asks | [The dials](https://eklavya-run.web.app/docs/dials/) · [Configuration](https://eklavya-run.web.app/docs/configuration/) |
| Find a command | [Commands](https://eklavya-run.web.app/docs/commands/) · [CLI](https://eklavya-run.web.app/docs/cli/) |
| Understand memory | [Memory](https://eklavya-run.web.app/docs/memory/) · [Your data](https://eklavya-run.web.app/docs/your-data/) |
| Understand grading | [Grading](https://eklavya-run.web.app/docs/grading-engine/) · [Levels and tiers](https://eklavya-run.web.app/docs/levels-and-tiers/) |
| See how it is built | [How it works](https://eklavya-run.web.app/docs/how-it-works/) |
| Update or remove it | [Updates](https://eklavya-run.web.app/docs/updates/) |
| Fix a problem | [Troubleshooting](https://eklavya-run.web.app/docs/troubleshooting/) · [FAQ](https://eklavya-run.web.app/docs/faq/) |

Or start at the [full manual](https://eklavya-run.web.app/docs/).

## Contributing

Development setup, the manual test scripts and the release process are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT
