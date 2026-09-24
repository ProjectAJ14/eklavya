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
source changes. For interactive development, run `claude --plugin-dir
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
   reports questions on, focus `concept`, cadence `interleaved`, without project
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

## Manual scenarios

Use a disposable project/home and record which scenarios were actually run.

### Learning and pacing

Ask for a feature, answer a question, and inspect `/eklavya:progress`. Confirm
the recorded grade and review state. Decline a question and confirm it is not
immediately repeated for the same work. A new session should show its profile;
`quiet: true` should hide visible status while leaving the logging directive
and questions active. Check both `interleaved` and `end` when changing pacing.

### Commit gate

From a disposable Git repository with a pending change:

```bash
eklavya config set quiz.enforced true --project
/path/to/eklavya/scripts/install-git-hook.sh
```

Have Claude build and attempt a commit before the gate passes; confirm the
in-session denial. Try a terminal commit and confirm the installed Git hook
also blocks it. Answer enough work-concept questions, check `/eklavya:gate`, and
confirm both paths succeed. A project without enforcement must remain ungated.
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

With `explain_on_wrong: true`, deliberately miss a question. The verdict and task
should continue immediately while the explainer creates a page in the background.
Restore the setting after the check.

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

Release credentials are configured in the workflow (`NPM_TOKEN`; Actions supplies
`GITHUB_TOKEN`). Do not run a publish or change credentials as part of a docs PR.
