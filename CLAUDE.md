# Working on Eklavya

Eklavya is a Claude Code plugin that teaches the developer the concepts behind
the code an agent just wrote. This file is the contributor contract for agents
working in this repo.

## Layout

| Path | What lives there |
|---|---|
| `mcp/src/` | the MCP server: config, store, SM-2 scheduling, quiz planning, concept packs, tools — and `cli.ts`, which builds to `dist/cli.js`, the `eklavya` binary |
| `mcp/src/migrations/` | SQLite migrations, forward-only |
| `mcp/src/hooks/` | the hook logic, in TypeScript — one file per hook, plus the shared `lib.ts` |
| `mcp/test/` | the vitest suite: `cd mcp && npm test` |
| `hooks/` | `hooks.json` and `run.mjs`, the one cross-platform entry point. Seven hooks: SessionStart, UserPromptSubmit (the log-directive nudge, and prompt capture), SubagentStart (the same directive for delegated work), PreToolUse (`Bash`, the commit gate), PostToolUse (`capture-tool` for every tool, and the checkpoint — on the log-concepts call and on the work tools), Stop. Every one dispatches into `mcp/src/hooks/` |
| `skills/` | the prompt-side behaviour; each skill with `disable-model-invocation: true` is also a `/eklavya:<name>` slash command. `tutor/` is the pedagogy, split into a short `SKILL.md` and `tutor/references/*.md` the model reads on demand |
| `user-skill/` | the one skill installed to `~/.claude/skills/`, not shipped in the plugin — it drives the CLI from plain chat. Must never be under `skills/`, or it registers twice |
| `agents/` | the tutor subagent |
| `cli/`, `scripts/` | the editor-agnostic commit gate: `cli/eklavya-gate` is a POSIX script (no Node startup cost in a git hook), `scripts/install-git-hook.sh` installs it. `scripts/bump-version.sh` is the release's version bump |
| `docs/` | contributor reference, not the manual: the pinned plugin/hook/MCP schemas, parallel tutoring, and the subagent policy — who logs, who quizzes, who stays silent — all kept current by hand. `eklavya-runtime.html` is **generated** from `eklavya-runtime.architecture.json` and stamped with the revision it was built from — edit the JSON, never the HTML, then regenerate (see below) |
| `eval/` | the question-quality eval: fixtures, a four-stage harness, and dated results. Measures the product (are the questions good) rather than the machinery. Never runs in CI — two of its four stages cost a model call per question. `eval/README.md` has the method and what would disprove it |
| `CONTRIBUTING.md` | development setup, the manual test scripts, the release process |
| `web/` | the site: the landing page (`public/`) and the manual (Astro Starlight, `src/content/docs/docs/`), deployed to Firebase Hosting. See `web/CLAUDE.md` |
| `.claude/skills/` | this repo's own working skills: the visual language and the dashboard contract |
| `assets/` | README artwork |

**Five directories carry their own `CLAUDE.md`, and it is the one to read
before you edit anything inside them**: `mcp/`, `hooks/`, `cli/`, `skills/` and
`web/`. This file is the shape of the repo and the rules that cross it; those
files hold the invariants each directory enforces and the failure each one
prevents. A change that breaks one of them is a change that passes review and
breaks a learner's session a week later.

## The runtime diagram is generated

`docs/eklavya-runtime.html` is a 700KB artifact rendered from
`docs/eklavya-runtime.architecture.json` by the `archify` skill. Hand-editing the
HTML is how it silently stops matching its own spec. Change the JSON, then:

```bash
cd ~/.claude/skills/archify
node bin/archify.mjs deliver architecture <repo>/docs/eklavya-runtime.architecture.json \
  <repo>/docs/eklavya-runtime.html --quality showcase --repo-root <repo> --json
node bin/archify.mjs visual-check <repo>/docs/eklavya-runtime.html --json
```

`deliver` must report 9/9 checks with 0 errors and 0 warnings, and `visual-check`
must pass every viewport — the artifact fits 1440x900 with nothing to spare, so
a card line one word too long overflows it. `visual-check` writes PNG and JSON
sidecars next to the HTML; they are evidence, not deliverables, so delete them.

Bump `meta.repository.revision` to the commit the evidence was read at, or every
source permalink in the diagram points at the wrong code.

## The site is part of the feature

`web/` is user-facing documentation, not decoration. **Any change to what
Eklavya does or how it is configured is not finished until the landing page, the
manual and `README.md` all say the same thing.** A feature branch that changes
behaviour and touches no documentation is an incomplete branch, and the docs are
not a follow-up ticket — they ship in the same commit as the code.

That applies to:

- a new or renamed config key, or a changed default
- a new value for `quiz`, `focus`, `cadence` or `difficulty` — or another dial
- a new, renamed or removed slash command, or a change to what `user-skill/` can do
- a change to the concept graph's shape — a new seed domain, or anything about
  the pack format in `mcp/src/packs.ts`
- a change to the quiz loop: when questions arrive, what shape they take, how
  they are graded, what the gate requires
- a change to where data is stored or what leaves the machine

The page went stale exactly this way once: it shipped describing `mode` alone,
then `focus` and `cadence` landed and the page kept promising two dials and
five commands. It happened a second way too — the `#dials` card called
`mode: off` "installed but dormant" when memory went on recording, and the
manual said the opposite on the same deploy. Treat the page like a test that has
to be updated with the code.

Concretely, when you change behaviour, check these against the diff:

| Landing page section (`web/public/index.html`) | Must match |
|---|---|
| hero terminal script | the real loop for the default config |
| `#how` steps and tier ladder | the actual sequence and tier meanings |
| `#dials` | `QuizConfig`, `Focus`, `Cadence`, `Difficulty`, `MemoryConfig` in `mcp/src/config.ts`, defaults included |
| `#commands` | the user-invocable skills under `skills/`, plus `user-skill/` |
| data card, install/CTA blocks | `paths.ts`, the setup skill's requirements |

The manual (`web/src/content/docs/docs/`) carries the heaviest duty of all: it
spells out every command's arguments, every config key with its default, every
CLI subcommand, the tier and level bands, and the gate's arithmetic. It goes
stale faster than the landing page because it says more. `web/CLAUDE.md` has the
per-page source-of-truth map and the writing conventions — read it before
editing anything under `web/`.

`README.md` is deliberately short: a pitch, the one install command, and links
into the manual. Resist re-adding reference material to it — a second copy of the
dials or the config keys is a second thing to keep in step, and it is the copy
nobody remembers to update. Everything a contributor needs lives in
`CONTRIBUTING.md`. Where any of them disagree with the code, `mcp/src/config.ts`
is the source of truth.

Do not advertise unshipped work — a feature stays out of `web/` until the code
exists and ships.

## Editing the site

Two halves on one ground: the landing page is hand-written HTML in
`web/public/`, and the manual is Astro Starlight in `web/src/content/docs/docs/`.
`npm run build` from `web/` produces `dist/`, which is what Firebase serves.

`web/public/tokens.css` holds the design tokens as two layers — a scale, then
two grounds (`ink` and `paper`) that redefine the same role names. Components
name a role (`--ink`, `--dim`, `--line`, `--spot`), never a scale step or a raw
hex; doing otherwise pins a component to one ground and breaks the theme toggle.
`.claude/skills/eklavya-design/SKILL.md` is the visual language: verdigris on
warm ink or warm paper, Archivo and Inter and JetBrains Mono, square chrome,
hairline rules, bow-and-arrow motifs, no emoji.

Preview with `npm run build && npm run preview` from `web/`, and check 1280, 900
and 560px **in both grounds** — a bug that only shows on paper is the commonest
kind. `web/CLAUDE.md` has the full pre-commit checklist.

## The dashboard is a third surface

`eklavya dashboard` (`mcp/src/dashboard.ts` and `mcp/src/assets/dashboard.html`)
is a web page too, on the same tokens as the site, and it has its own rules:
one JSON payload of flat rows with every view derived in the browser, a hash
router, hand-rolled SVG charts, and an interaction contract — the wordmark goes
home, anything clickable is keyboard-operable, a filter worth linking to lives
in the hash. **Read `.claude/skills/eklavya-dashboard/SKILL.md` before touching
either file.** Its manual page, `web/src/content/docs/docs/dashboard.mdx`, ships
in the same commit as the change, like every other doc here.

## Conventions

- Every pull request fills `.github/PULL_REQUEST_TEMPLATE.md`, and one that changes
  behaviour pastes the transcript of the acceptance test `CONTRIBUTING.md` defines.
- Conventional commits; semantic-release publishes from `main`. `feat:` and
  `fix:` cut a release, `docs:` and `chore:` do not — site and README work is
  `docs:`.
- Migrations are forward-only. Adding one means bumping the schema constants in
  `mcp/test/migrate.test.ts` in the same change.
- Hooks must never break a session: every failure path exits 0.
- Never commit a learner's `knowledge.db` or anything under `~/.eklavya/`.

## Every answer ends with what I have to DO — ALWAYS

Everything above is the contract for the code. This section and the five after it
govern how you reply to me, the maintainer, in chat. This is the rule that keeps
getting broken, so it goes first.

- **Group by topic.** A heading per topic. Bullets under it. Never one long run of prose.
- **Close with `What I need from you:`** — a short list of actions, or the single word `Nothing`.
  If I have to re-read the answer to work out what I am being asked to do, the answer failed.
- **Ten lines per topic, hard cap.** Longer means it is two topics, or it is detail nobody asked for.
- **Do not re-explain what I already know.** I was in the conversation. Skip the recap and the
  background; give the new fact.
- **A correction is one line.** "I was wrong about X, here is the truth." Not a paragraph about how
  the mistake happened.
- **No narrating the investigation.** I want the finding, not the route to it.
- **Name what is not done.** A behaviour change that left the site, the manual or `README.md`
  untouched, a skipped acceptance test, a regenerated diagram not yet checked — each is a line in
  the action list, not a footnote.

Length is not thoroughness. Simple, very clear, no noise, a clear action needed from me.

## Always recommend, and say what it costs — ALWAYS

**Never hand me a list of options and stop.** Options without a recommendation move the decision
back to me with none of the work done. I ask for the options to see the trade-off, not to do the
analysis.

Every set of options ends with a pick, and the pick carries:

- **Which one, in one line.** Not "it depends" and not two co-favourites.
- **Why — the reason, not the restatement.** "Because correctness beats cosmetics here" is a
  reason. "Because it fixes the bug" is the option repeated back.
- **What it costs.** Time, risk, what stays broken meanwhile, what else it blocks.

**When the quick fix and the right fix are different, give BOTH and say so.** A recommendation that
hides the trade-off reads like there wasn't one.

- **The patch** — what to do now, how long, and precisely what it leaves unfixed.
- **The proper fix** — what it takes, and what it buys that the patch does not.
- **Which one to do today, and whether the other still needs an issue.** A patch shipped with no
  issue for the real fix is a decision to never fix it, and it should be named as such.

Watch for the expensive option that looks like the thorough one — a rename or migration to solve
what is really a wording problem is the classic case.

If there is genuinely only one sane option, say that too, and say why the alternatives are not
alternatives. Silence reads as "I did not think about it".

## Check before you conclude — ALWAYS

**Never name a cause you have not verified.** This repo can answer most questions itself:
`cd mcp && npm test`, `eklavya doctor` and `eklavya status`, the store at
`sqlite3 "$(eklavya db-path)"`, and `git status`. If a claim can be checked, check it before
saying it, not after I push back.

Two failures, and they are different:

**Did not check.**

- **Look at the specific cases, never the aggregate.** The population you are explaining is the
  one to look at. An overall rate produces confident diagnoses about rows that are not in question.
- **Measure over a window longer than the thing you are measuring.** "No errors in the last two
  minutes" says nothing about a job that runs every five.
- **Read the code path before blaming it.** Before claiming a function lacks a guard, `grep` its
  callers — the guard is often one level up.
- **A passing test on this machine is not a passing test.** In-process tests that call
  `loadConfig()` read the real `~/.eklavya/config.json`, so they pass here and fail in CI. Pin the
  config or point `EKLAVYA_HOME` at a temp directory before calling a test green.

**Checked partially, then generalised from the part.** More dangerous, because the evidence makes
the answer feel earned. In each case a complete check exists and usually takes one command:

- **A sample proves what it contains, never what it lacks.** Absence in a sample is evidence about
  the sample. To claim absence, count over the population that would contain it.
- **Do not generalise a diff from the lines you happened to read.** "The first twelve lines are
  formatting" does not make the change formatting-only. Compare the whole thing — and note
  `--ignore-all-space` cannot collapse a line break, so it does not prove it either.
- **Check whether the defect is yours before reporting it as somebody else's.** `git status` and
  `git diff` answer this. Attributing your own uncommitted mistake to the codebase wastes time twice.
- **Recalled memory is a claim about the past.** An `<eklavya-memory>` block says what was true
  when it was written. Check the file, flag or function still exists before building on it.

The pattern under all of them: **say what would make the claim false, then go and look for that.**
Confirming evidence is easy to find for a wrong answer; an honest attempt to falsify is what
separates a verified claim from a plausible one.

When something cannot be verified, say so plainly and say what would settle it. "I think X, and
the way to know is Y" is worth more than a confident wrong answer.

A correction is one line, and it comes before anything else in the reply.

## Do not make me connect the dots — ALWAYS

**No cross-referencing.** Say the thing, in the place where it matters, in full.

- No "as in option B", "see points 1–3 above", "like the earlier case". If a fact matters here,
  state it here. Naming a category I have to scroll back and decode is the same as not saying it.
- No issue or PR numbers as shorthand. Say what it *was*, then the number if it is still useful.
- One decision per question. Presenting five findings that only mean something combined leaves
  the combining to me — do it first, then give the conclusion.

## Chat replies: short. Bullets. No noise. — ALWAYS

This governs what Claude writes **in chat**. Code comments, commit messages and documents
are unaffected — they stay as thorough as the rest of this file asks for.

- **Bullets by default.** Prose paragraphs only when a bullet genuinely cannot carry it.
- **Lead with the answer.** The finding, the number, the verdict — first line, no wind-up.
- **One line per point.** If a point needs three sentences, it is two points or it is detail
  nobody asked for.
- **Cut the reasoning unless asked.** Say what changed and what it means. The *why* is already
  in the code comment and the commit; do not restate it in chat.
- **No recaps.** Do not summarise what just scrolled past, do not re-list what was already
  agreed, do not close with "so in summary".
- **Asking a question:** the question, then the options. No preamble explaining why it is being
  asked.
- **Gotchas stay.** A "watch out" is never noise — keep it, one line, at the end.

The failure mode to avoid: a correct answer buried in three paragraphs of context I already have.

## How I want things explained — ALWAYS

**Every answer, every context, every question** — explain in plain English first. No
jargon, no framework names, no acronyms unless unavoidable.

- Lead with what it *does*, not what it *is*. "This stops the commit until you answer one
  question" beats "This is a PreToolUse hook matching `Bash`."
- Use concrete examples and real-world analogies whenever something is abstract.
- If something has a "watch out" / gotcha / known bug — call it out explicitly at the end
  in plain terms.
- In DOCUMENTS and code comments, avoid bullet walls — group them or write in prose. In CHAT,
  bullets are the default; see the section above, which wins on any conflict.
- Tables are fine for field mappings and comparisons.

**For code-review fixes and bugs specifically**, use this 6-part pattern:

1. **Issue (simple language)** — what is actually wrong, in one or two sentences.
2. **Solution (simple language)** — what we'll do, in similarly plain words.
3. **Impact** — what breaks today, what data is lost, what user-visible symptom this prevents.
4. **Example** — a small concrete walkthrough, ideally a timeline OR a tiny snippet showing
   the broken vs fixed behaviour.
5. **Changes needed** — files, new modules, migrations, approximate LOC.
6. **Recommendation + why** — pick / rank / order, with a one-line reason. "Do #1 first
   because correctness; #3 last because cosmetic."

This pattern is for *explaining* a finding before coding. Once I pick one, dive straight
into code.
