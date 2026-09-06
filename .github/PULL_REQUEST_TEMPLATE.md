<!--
Work grounded in a real session is held to a different bar than work reasoned
from the documentation. The environment table and the transcript are how a
reviewer tells the two apart, so fill them in even when the fix looks obvious.
-->

## What changed

<!-- One or two sentences. -->

## What actually broke

<!--
The session that made you write this: what you asked for, what Eklavya did,
what it should have done instead. Paste the transcript excerpt — the checkpoint
that fired at the wrong moment, the question that came back twice, the commit
the gate let through. A transcript is worth more than a description of one.

Nothing broke — a feature, a doc fix, a refactor? Say so, and delete the
environment table below.
-->

## Environment

| | |
|---|---|
| Model | |
| Harness | Claude Code, Codex, … |
| Harness version | `claude --version` |
| Eklavya version | `eklavya doctor` names the installed one; `.claude-plugin/plugin.json` is the branch you built |
| Other installed plugins | all of them, not the ones you think are relevant |

<details><summary><code>eklavya doctor</code></summary>

Redact the paths first: the `level:` line names your repository's full path, and
the rest carry your home directory.

```
```

</details>

## Checks

- [ ] `cd mcp && npm test` passes
- [ ] The acceptance test in `CONTRIBUTING.md` still passes, and its transcript is above
- [ ] Behaviour changed → the manual, the landing page and `README.md` all say the same thing (`CLAUDE.md`, *The site is part of the feature*)
- [ ] Changed `skills/tutor/` → eval evidence before and after (`CONTRIBUTING.md`, *The eval*)
- [ ] Added a migration → `LATEST_SCHEMA_VERSION`, `EXPECTED_TABLES` and the migration file list bumped in `mcp/test/migrate.test.ts`
- [ ] Changed a file `docs/eklavya-runtime.architecture.json` permalinks → diagram regenerated, `meta.repository.revision` bumped
- [ ] Conventional Commit subject — `feat:` and `fix:` cut a release, `docs:` and `chore:` do not
