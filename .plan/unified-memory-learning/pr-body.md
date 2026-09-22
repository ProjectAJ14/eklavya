# One plugin that remembers the project and teaches the developer

<!--
This is the PR description for `docs/unified-memory-learning`, written against
`.github/PULL_REQUEST_TEMPLATE.md`. Paste it into the PR body; the acceptance
transcript and the `eklavya doctor` block have to be filled in from a real
session before it is opened.
-->

## What changed

Eklavya gains a memory half: every tool call, prompt and session boundary is
captured as typed evidence through one privacy filter, distilled locally into
entries, and recalled at the next session start with a receipt that makes the
saving claim checkable. It replaces Claude Mem rather than bridging to it —
`eklavya memory import` brings the history across — and it does not change what
the learning half already did.

## What actually broke

Nothing broke. This is a feature branch: the unified memory + learning program
in `.plan/unified-memory-learning/`, phases 1 through 5 with parts of 6.

**It still changes behaviour**, so the acceptance test in `CONTRIBUTING.md` and
its transcript belong below rather than deleted. What the reviewer should see in
that transcript, on a fresh install with default config:

- the three-line session-start display, with `Your savings: — no context reused
  yet` on the first run and a figure on the second;
- a quiz that arrives exactly when it did before this branch;
- `eklavya memory status` reporting captured evidence after a few tool calls,
  with `mode: off` set — capture is not governed by the learning dials.

<!-- Paste the transcript here. -->

## Environment

| | |
|---|---|
| Model | |
| Harness | Claude Code |
| Harness version | |
| Eklavya version | |
| Other installed plugins | |

<details><summary><code>eklavya doctor</code></summary>

```
```

</details>

## What is in it

| Area | Landed |
|---|---|
| Schema | migrations 009 (memory), 010 (import) and 011 (sync), forward-only; `migrate.test.ts` bumped |
| Capture | a seventh hook, `capture-tool` (PostToolUse, no matcher), plus prompt, lifecycle and seam capture in three existing hooks — all four before their `mode` check |
| Storage | `mcp/src/memory/` — store, identity, privacy, spool, tokens, embeddings, a leased job worker |
| Retrieval | FTS5 keyword, `local-hash-v1` semantic, hybrid; project-scoped by default |
| Distillation | one `Summarizer` port, local by default, `providers.observer` optional and never enabled by an upgrade |
| Tools | eleven memory MCP tool definitions (**see the known issue below**) |
| Surfaces | `/eklavya:memory`, `eklavya memory <subcommand>`, four dashboard routes, two paged endpoints |
| Migration | `eklavya memory import` against the pinned Claude Mem schema (v52), plus transcript replay |
| Sync | `eklavya memory sync push\|pull\|status` against a shared directory; entries, tags and tombstones only, off by default |
| Config | six namespaces: `memory`, `privacy`, `retrieval`, `providers`, `notifications`, `sync` |
| Decisions | ADR-01..09 in `.plan/unified-memory-learning/adr.md` |

## Known issue to resolve before merge

`TOOLS` in `mcp/src/tools/index.ts` imports `codeOutline`, `codeFindSymbol` and
`memoryCollections` but never adds them to the array, so the server registers
seventeen tools while `web/src/content/docs/docs/memory.mdx` and
`skills/memory/SKILL.md` document twenty.
`server.integration.test.ts` compares the advertised names against `TOOLS`
itself, so it agrees with whatever the array holds and cannot catch this. Three
identifiers fix it, and it should be fixed here rather than shipped with the
manual ahead of the server.

## What this does not do

Stated so a reviewer does not go looking for it:

- **No hosted team server** (ADR-09). Sync is a shared directory, not a
  service. Team-shared memory, scoped API tokens and server-side job
  administration are not available; pointing everyone at one folder gives
  sharing without tenancy.
- **No resident daemon** (ADR-05). A short-lived leased worker runs at the
  seams.
- **No neural embedder** (ADR-03) and **no parser** (ADR-07). The ceilings are
  in the manual.
- **One proven host** (ADR-06). Cursor and Cowork are capability descriptors
  with no fixture.
- **No egress by default.** No provider, no notification sink, nothing leaves
  the machine unless it is configured.

## Checks

- [ ] `cd mcp && npm test` passes — **4 failures are pre-existing and are not
      from this branch.** They come from an untracked `.eklavya.json` at the
      repo root containing `{"mode": "off"}`: three in `test/stdin.test.ts` and
      one in `test/server.integration.test.ts`, all of which assert that a hook
      or the statusline prints something that `mode: off` correctly suppresses.
      Moving the file aside makes both files pass. See the release-readiness
      section of `.plan/unified-memory-learning/progress.md`.
- [ ] The acceptance test in `CONTRIBUTING.md` still passes, and its transcript is above
- [ ] Behaviour changed → the manual, the landing page and `README.md` all say
      the same thing. The landing page gained the memory half and a ninth slash
      command; the manual gained `memory.mdx`, `migrating.mdx`, and the memory
      sections of `cli.mdx`, `commands.mdx`, `configuration.mdx` and
      `dashboard.mdx`.
- [ ] Changed `skills/tutor/` → eval evidence before and after. `focus-and-level.md`
      gained the rule for grounding a question in project memory; the tutor
      agent gained three read-only memory tools.
- [ ] Added a migration → `LATEST_SCHEMA_VERSION`, `EXPECTED_TABLES` and the
      migration file list bumped in `mcp/test/migrate.test.ts` for 009, 010 and 011
- [ ] Changed a file `docs/eklavya-runtime.architecture.json` permalinks →
      diagram regenerated, `meta.repository.revision` bumped
- [ ] Conventional Commit subject — `feat:` and `fix:` cut a release, `docs:`
      and `chore:` do not

## Reviewer's reading order

1. `.plan/unified-memory-learning/adr.md` — nine decisions, each with what was
   rejected and how to back out.
2. `.plan/unified-memory-learning/parity.md`, the status table — every
   capability row marked done, partial, declined or not done, with the test
   that proves it or the reason it is missing.
3. `mcp/src/memory/capture.ts` and `mcp/src/memory/privacy.ts` — the filter runs
   before the insert, at every sink, and `memory-hardening.test.ts` is the
   negative test.
4. `hooks/CLAUDE.md`, *Memory capture is not governed by `mode`* — the one
   invariant that is easiest to break by accident.
