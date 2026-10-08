# Contributing to Eklavya

For installation and everyday use, read the [manual](https://eklavya-run.web.app/docs/).
For repository rules, read [CLAUDE.md](CLAUDE.md) and the guidance in the directory
you change. User-facing behavior and its documentation ship in the same PR.

## Set up development

Use Node 22 or newer. From the repository root:

```bash
cd mcp
npm ci
npm test
claude plugin validate ..
```

`npm test` builds first, then runs unit and integration tests. Tests that spawn
hooks or the CLI execute `mcp/dist/`, so rebuild before using watch mode after
source changes.

CI runs `npm run coverage` instead: the same suite under c8, which also counts
the hooks and CLI the tests spawn, and fails below 100% lines, statements,
functions or branches. The HTML report lands in `mcp/coverage/index.html`, and
the run page lists every file under 100%. New code needs tests that reach it; a
`/* c8 ignore next -- reason */` is only for code a test cannot reach
deterministically, such as a branch for another operating system.

For interactive development, run `claude --plugin-dir
/path/to/eklavya` from a scratch project; replace that path with your checkout.

To work on the website:

```bash
cd web
npm ci
npm run build
npm run preview
```

Run that block from the repository root. The build includes metadata, link and
asset checks. [web/CLAUDE.md](web/CLAUDE.md) maps manual pages to source files and
describes visual checks.

## Choose the right checks

| Change | Required evidence |
|---|---|
| Runtime behavior | Relevant automated tests and the live learning-loop check below |
| Hooks or commit gate | Hook/gate tests plus the affected manual scenario below |
| Tutor pedagogy | Before/after evaluation and live learning-loop transcript |
| Documentation or website | Website build; source-checked examples; visual checks for changed layouts |
| Plugin manifests or host integration | Plugin validation and re-verification of [host contracts](docs/verified-schemas.md) |

Use temporary `EKLAVYA_HOME` and `EKLAVYA_DB` for runtime experiments. In-process
tests need the same isolation as subprocesses: otherwise local settings can hide
a failure or tests can write real learner data. Do not commit databases,
transcripts containing private work, or files from `~/.eklavya/`.

The test workflow runs on PRs and non-main pushes. The release workflow tests
main before publication. Model-based evaluations run separately because they
cost model calls and are not deterministic.

## Live learning-loop acceptance

The product-level check is:

> Ask for a non-trivial change. One question arrives during the work, and the
> agent resumes the task immediately after the answer.

1. Build the plugin and use a fresh scratch project. Confirm `eklavya doctor`
   reports questions on, focus `concept`, cadence `as-you-go`, without project
   enforcement left over from a gate test.
2. Start `claude --plugin-dir /path/to/eklavya` and request a small feature.
3. Confirm the model called `log_session_concepts`. Without that call the result
   is inconclusive; report it instead of retrying until a run passes.
4. Look for the checkpoint message “Eklavya: quick question on what you just
   built”. A question only after all work is finished is the Stop sweep and does
   not satisfy the mid-task check.
5. Answer and confirm work resumes without an unsolicited summary. Include a
   short, redacted transcript in the PR.

A passing unit suite, a manually requested topic quiz, or an explanation of
expected behavior does not establish that the live loop works. Project settings
live outside the checkout; inspect them with `eklavya config get` rather than
assuming that a clean Git tree means default settings.

## Quiz side panel acceptance

The panel (`quiz.panel`, experimental) needs its own live check, because a
mounted tree is not a painted pane. With a disposable `EKLAVYA_HOME`, the plugin
loaded from your checkout (`claude --plugin-dir /path/to/eklavya`), and
`eklavya config set quiz.panel true`:

1. Ask for a change that logs a concept. A pane opens beside the transcript (or
   "A question is waiting. /eklavya-panel to open it." in a narrow terminal) and
   typing in the prompt still works.
2. While a long Bash command or a background agent runs, answer in the pane.
   Neither pauses. Selecting does not record anything; **Submit answer** records
   exactly one attempt, also on a double click.
3. Try Other with typed words, Skip, Esc then `/eklavya-panel`, a `/clear` with a
   leftover pane, and killing the Eklavya server mid-answer then Retry.
4. Turn `quiz.panel` off and confirm the next question is the card and nothing
   mentions the panel.
5. Pick one answer with its number key and another with a click on its text. Each
   card shows its border and ✓ only for the pick, with no fill, and the host's
   focus mark lands on the same card. Names such as `tester.pumpWidget(widget)`
   in the question appear as code. Answer the last question of a round and
   confirm the result closes itself after 15 seconds, and that a round with
   **Next question** waiting never does.

Run `scripts/test-panel-mod.sh` for the mod's validation and tests. Say which of
terminal and Desktop you ran; only the terminal CLI has been verified. On Desktop, also check that the pane draws without the terminal's `Ctrl+X then Tab` and `Esc` hints, that a click and the number keys pick an answer, and that a host that cannot seat the pane leaves the question on the card.

## Manual scenarios

Use a disposable project/home and record which scenarios were actually run.

### Learning and pacing

Ask for a feature, answer a question, and inspect `/eklavya:progress`. Confirm
the recorded grade and review state. Decline a question and confirm it is not
immediately repeated for the same work. A new session should show its profile;
`quiet: true` should hide visible status while leaving the logging directive
and questions active. Check both `as-you-go` and `end` when changing pacing.

### Commit gate

From a disposable Git repository with a pending change:

```bash
eklavya config set quiz.enforced true --project
/path/to/eklavya/scripts/install-git-hook.sh
```

Have Claude build and attempt a commit before the gate passes; confirm the
in-session denial. Try a terminal commit and confirm the installed Git hook
also blocks it. Answer enough work-concept questions, check `/eklavya:gate`, and
confirm both paths succeed. Repeat the terminal commit from a linked worktree of
that repository while Claude runs in the main checkout; it must also be held.
A project without enforcement must remain ungated.
Settings must stay outside the checkout. Finally run the installer with
`--uninstall` and confirm any previous hook is restored.

### Memory and privacy

Disable questions with `eklavya config set quiz.enabled false --project`, then
do a small task. `eklavya memory status` should still show captured evidence.
A short turn may not close a batch yet; start another session or use
`eklavya memory process` before expecting searchable summaries. Search with
`eklavya memory search "a term from the task"`, then hydrate the chosen entry
with `eklavya memory show <id>` (replace the ID).

Confirm recall in a new session, and no repeated injection of an already-recalled
entry. With `memory.enabled: false`, new capture and recall should stop. In a
scratch repository, read an `.env` file containing a fake token and confirm the
excluded file and raw token are absent from persisted evidence. Do not use a
real credential for this test.

### Parallel tutoring and artifacts

Follow [parallel tutoring](docs/parallel-tutoring.md) to verify that two panes
sharing `EKLAVYA_SESSION_ID` can satisfy one gate. For artifacts, create a test
page with `eklavya artifacts new "Scratch page" --description "A local check"
--open`; confirm it appears in the dashboard and worktree pages use the main
project's folder. An artifact must not access the dashboard API.

With `explain_on_wrong` at its default (`true`), deliberately miss a question. The
verdict and task should continue immediately while the explainer creates a page in
the background. The page must open with the question, every option, the pick in
red and the right answer highlighted.

With `delegate_work` at its default (`true`), start a fresh session and ask for a
change that touches several files. If Claude changes a second file itself (an
edit tool or a shell command), the `delegate-nudge` hook should say so once. Claude should start a background agent, then
ask questions one at a time while it builds, and write the task answer as the
last message once the agent reports. Ask for a one-line fix too: it should stay
inline. In either case the turn must not end on a question or a verdict; if the
Stop sweep fires, it ends with "Back to your task:" and a short restatement.

## Evaluation

[eval/README.md](eval/README.md) explains each harness, costs, limitations and
dated results. Build `mcp/` first. From the repository root:

```bash
npm run eval -- run --limit 8 --focus project --difficulty hard
npm run eval -- score eval/results/<run>
npm run eval -- extract
npm run eval -- history
```

Replace `<run>` with an existing run directory. Generation, judging and extraction
use model calls; deterministic scoring does not. History reads real learner state
and emits aggregates, not question/answer text. Run pedagogy comparisons before
and after the change, retaining unfavorable results and what would disprove the
conclusion. Dated results are historical records, not current product guarantees.

## Documentation review

Every PR that changes product code must also change the manual
(`web/src/content/docs/docs/`), the landing page (`web/public/index.html` or
`app.js`) and a README (`README.md` or `mcp/README.md`). The `docs-sync` job in
the test workflow enforces this; run it locally with
`.github/scripts/check-docs-sync.sh`. The `/verify-docs` skill finds the claims
each surface must change and can write them (`/verify-docs --fix`). The
`Verify docs` workflow runs it every Monday on the past week of `main` and opens
a PR with the fixes. What it cannot fix (claims in product code, and claims it
could not confirm) goes into one open `Verify docs:` issue, which later runs
comment on. It needs the `CLAUDE_CODE_OAUTH_TOKEN` secret from `claude setup-token`.

Use the source maps in root and [web guidance](web/CLAUDE.md). Keep the install
guide short; move alternate routes, maintenance and full flag lists to their
own pages. Verify all new commands, defaults, limits and paths from code. Update
affected diagrams and explain their meaning in text. Check links and metadata
with the website build; inspect changed layouts in both themes at 1280, 900 and
560px. Fill [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md)
and disclose checks not run.

## Releases

Semantic-release tests, versions, tags and publishes from `main`:

| Commit prefix | Effect |
|---|---|
| `fix:` | Patch release |
| `feat:` | Minor release |
| `feat!:` or `BREAKING CHANGE:` | Major release |
| `docs:`, `test:`, `chore:`, `build:`, `ci:`, `refactor:` | No release |

`scripts/bump-version.sh` keeps `.claude-plugin/plugin.json` and `mcp/package.json`
aligned. The marketplace serves this repository; npm ships the same plugin tree
in `mcp/dist/plugin/`. The package and binary are both `eklavya`; the MCP server
is `eklavya serve`. Keep the deprecated `eklavya-mcp` package available for older
pinned installs.

The plugin version can reach Git before npm publication. `hooks/run.mjs` retries
an unavailable pinned package with `latest`; existing runtimes continue working.
Automatic checks occur at session start, at most hourly, so update timing depends
on an active session and network access. Fix a bad release forward: the updater
does not downgrade, and unpublishing cannot repair an installed version.

Release credentials are configured in the workflow: `NPM_TOKEN`, plus the
`projectaj14-release-bot` GitHub App (`RELEASE_APP_ID` variable,
`RELEASE_APP_PRIVATE_KEY` secret). The App is the only bypass actor on `main`'s
ruleset, so it alone can push the version-bump commit and tag; the default
`GITHUB_TOKEN` is rejected with `GH006`. Do not run a publish or change
credentials as part of a docs PR.
