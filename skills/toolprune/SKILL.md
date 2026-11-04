---
name: toolprune
description: Show the tools this repository's sessions load and never use, and deny or restore them in this checkout's .claude/settings.local.json when asked.
disable-model-invocation: true
---

# /eklavya:toolprune

Every tool a session loads costs context on every request, used or not.
Eklavya keeps, per repository, how many prompts and sessions have passed since
each loaded tool was last used, and proposes the ones that went unused. It
writes nothing until the developer says so.

1. Run `eklavya toolprune list` with Bash and show what it printed: each
   proposed tool with its evidence, and any tools Eklavya already denied.
2. If the developer passed `apply` (all of them) or named tools, run
   `eklavya toolprune apply [tool...]`. Say that the change takes effect from
   the next session, and that `eklavya toolprune restore` undoes it.
3. If they passed `restore`, run `eklavya toolprune restore [tool...]`. Say
   that restored tools are not proposed again.
4. If they asked what it saves, run `eklavya toolprune measure` and repeat its
   two lines as written: it counts listing lines of deferred tools only, and
   says it does not measure full definitions.

Never edit `.claude/settings.local.json` yourself, and never apply without being
asked: the deny list is the developer's file. `eklavya toolprune apply` refuses
when `economy.toolprune` is `off`, when the file is not valid JSON, or when
`.claude` leads out of the repository through a symlink; report its reason as
written. Built-in tools Claude Code needs to work (Bash, Read, Edit, Write, the
search and web tools, Agent, Skill, ToolSearch, AskUserQuestion) and every
Eklavya tool are never proposed.
