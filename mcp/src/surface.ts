/**
 * Which Claude surface this session is running on.
 *
 * Eklavya loads in three places, and only two of them are the same product.
 *
 *   - the Claude Code CLI, in a terminal;
 *   - the Code tab in Claude Desktop, which is the same engine on the same
 *     `~/.claude`, so it needs nothing from this file;
 *   - Cowork, Claude Desktop's agentic workspace, where the agent loop runs
 *     natively on the device — which is what lets the MCP server reach the real
 *     `~/.eklavya/knowledge.db` and keep one knowledge graph across all three.
 *
 * The third one produces documents, analyses and decks rather than code. Every
 * directive and framing string Eklavya injects says "the code you just wrote"
 * and "the diff", because until now that was always true. In a Cowork session
 * it is false, and a tutor told to ground a question in a diff that does not
 * exist either invents one or says nothing.
 *
 * The fix here is deliberately a note rather than a second vocabulary. Ten
 * strings restated in knowledge-work English would be ten strings to keep in
 * step with their code-shaped twins forever, and the pedagogy is identical
 * either way — log what the work is *about*, ask the transferable version. One
 * sentence that renames the nouns is the smaller thing that does the same job.
 *
 * ponytail: one note over a parallel vocabulary. If Cowork ever needs different
 * pedagogy rather than different nouns, that is the point to split them.
 */

export type Surface = 'code' | 'cowork';

/**
 * The Cowork entrypoints that are not spelled with "cowork" in them.
 *
 * `CLAUDE_CODE_ENTRYPOINT` is set by the host when it spawns the engine and is
 * inherited by every hook and MCP server it starts, so it is readable from
 * anywhere in this codebase without being passed around. A local Cowork session
 * reports `local-agent` — hence Claude Desktop's `local-agent-mode-sessions`
 * directory — and that name predates the product being called Cowork, so no
 * pattern catches it.
 *
 * Everything else does contain the word, which is why the test below is a
 * substring and not a list. Claude Desktop's own entrypoint enum carries
 * `remote_cowork`, `remote_cowork_trigger`, `claude-coworker` and
 * `claude-coworker-terminal`, and it treats `claude-coworker` as a *prefix
 * family* rather than a fixed pair:
 *
 *     nji = ["claude-coworker"];
 *     rji = (e) => tji.has(e) || nji.some((t) => e.startsWith(t));
 *
 * So the set is open-ended by the host's own design, and an allowlist of the
 * four names known on the day this was written would go stale the first time
 * Anthropic added a fifth — silently, because a missed Cowork session does not
 * error, it just gets told to ground its questions in a diff that is not there.
 *
 * The substring is safe against the rest of that enum: `cli`, `mcp`, `sdk-*`,
 * `bench`, `claude-vscode`, `claude-desktop`, `claude-desktop-3p`, `remote`,
 * `remote_baku`, `remote_trigger`, `remote_desktop`, `remote_mobile`,
 * `claude-in-slack`, `claude-in-teams`, `claude-security`, `ssh-remote` and
 * `claude-code-github-action` contain no "cowork" between them.
 */
const COWORK_ENTRYPOINTS = new Set(['local-agent', 'local_agent']);

/**
 * `EKLAVYA_SURFACE` exists for the same reason `EKLAVYA_HOME` and
 * `EKLAVYA_SESSION_ID` do: so a test can assert both branches without faking a
 * host, and so the CLI can be pointed either way.
 *
 * It is not much of a user-facing escape hatch, and the docs no longer sell it
 * as one: on Cowork the hooks and the server are spawned by Claude Desktop with
 * an environment it composes itself, and the only shell the user can reach is
 * the sandbox VM's, which these processes do not inherit from. That is exactly
 * why the detection above has to be right by itself.
 *
 * An unrecognised entrypoint resolves to `code`, which is the direction to be
 * wrong in: a new Cowork entrypoint costs a session of code-shaped wording, and
 * a misread Claude Code session would cost every session the wrong wording.
 */
export function currentSurface(): Surface {
  const override = process.env.EKLAVYA_SURFACE;
  if (override === 'cowork' || override === 'code') return override;

  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? '';
  return entrypoint.includes('cowork') || COWORK_ENTRYPOINTS.has(entrypoint) ? 'cowork' : 'code';
}

export function isCowork(): boolean {
  return currentSurface() === 'cowork';
}

/**
 * The one sentence that re-points every code-shaped instruction at the work
 * that was actually done.
 *
 * Kept to two sentences on purpose. This is appended to directives that are
 * injected into every session and re-injected on every resume, so its length is
 * a tax on every Cowork turn; and a long re-framing competes with the directive
 * it is supposed to be modifying.
 *
 * It says "these instructions" rather than "the instructions below", which is
 * what it said first: the note is *appended*, so what it modifies is always
 * above it, and in `framingFor` it is appended to a single sentence with a
 * space. One wording has to be true in every position it lands in.
 */
export const COWORK_NOTE =
  '[Eklavya] This is a Cowork session: the work is documents, analysis and research rather ' +
  'than code, and there is no diff. Wherever these instructions say "code" or "diff", read it ' +
  'as the work you actually produced — the document, the numbers, the decision — and log and ' +
  'quiz that.';

/**
 * Appends the note when, and only when, this is a Cowork session.
 *
 * Every caller is a string Eklavya hands to the model, so this is the single
 * place that decides what Cowork sees. Callers that forget it keep today's
 * behaviour rather than breaking, which is why it is a wrapper and not a flag
 * threaded through five signatures.
 */
export function withSurfaceNote(text: string, separator = '\n'): string {
  return isCowork() ? `${text}${separator}${COWORK_NOTE}` : text;
}

/**
 * Whether the host paints the `header` chip — a different question from `Surface`.
 *
 * `Surface` says what kind of work a session produces. This says what the host
 * draws, and the two do not line up: the Code tab in Claude Desktop is `code`
 * by every measure that matters to the pedagogy — same engine, same
 * `~/.claude`, same diff — and still renders a question card rather than a
 * terminal. `header` is a field every client receives and each one paints as it
 * likes; Claude Desktop's card has no chip in it, so the attribution is
 * dropped on the floor.
 *
 * That leaves a Desktop learner with no attribution at all, because the *other*
 * signal is terminal-only too. 1.14 moved the dials out of the stem and into
 * `eklavya statusline` (see `ask.ts`), which was right for a terminal and
 * silently correct-by-accident everywhere else until Desktop support landed:
 * Claude Desktop has no status bar to run it in. Chip and bar were the two
 * places attribution lived, and Desktop has neither, so a question arrives
 * unsigned mid-task and reads as Claude going off-piste.
 *
 * So the stem gets a prefix back, on those hosts only. This is a partial
 * reversal of 1.14 and worth naming as one: the argument then was that a field
 * with no dim, no weight and no colour is a poor place for a readout. It still
 * is. The difference is that a line of ambient state is a readout, and
 * three characters of "who is asking" are not — and a poor place beats no place.
 */
const HEADERLESS_HOSTS = /desktop/i;

/**
 * True when the host renders a question card instead of a terminal.
 *
 * Matched as a substring for the reason the Cowork test is: `claude-desktop`
 * and `claude-desktop-3p` are what the app stamps today, and the app treats its
 * entrypoint names as prefix families rather than a fixed list, so an allowlist
 * of the two known on the day this was written would go stale the first time a
 * third appeared. `remote_desktop` is caught by the same pattern and should be
 * — it is the desktop app driving a remote session, with the same card and the
 * same missing chip.
 *
 * Cowork is included outright. It is Claude Desktop too, and its agentic
 * workspace has no terminal and no status bar either.
 *
 * `claude-vscode` is deliberately *not* matched: the extension runs Claude Code
 * in an integrated terminal, which paints the chip like any other.
 *
 * `EKLAVYA_SURFACE` deliberately does not reach this. That override says what
 * kind of work a session produces, and this asks what the host draws: setting
 * it to `code` on a Claude Desktop session is a statement about the work, not a
 * claim that a terminal appeared. It still reaches the Cowork half, because a
 * session forced to Cowork is one whose host draws a card by definition.
 *
 * Unknown entrypoints resolve to "paints the chip", which is the direction to
 * be wrong in *for this session's most common host* — the terminal, where a
 * prefix beside a chip that already says Eklavya is pure noise on every
 * question. A host we have never heard of loses attribution until someone adds
 * it; a terminal that gains a redundant prefix annoys every user every time.
 */
export function needsInlineAttribution(): boolean {
  return isCowork() || HEADERLESS_HOSTS.test(process.env.CLAUDE_CODE_ENTRYPOINT ?? '');
}

/**
 * The attribution rule, composed for whichever host is asking.
 *
 * One function rather than a sentence pasted into each caller, because the two
 * hooks and the plan all have to say the same thing and a rule stated in three
 * places is a rule that drifts. The terminal branch is what both hooks said
 * verbatim before this existed.
 *
 * The prefix is a separate line rather than an inline `[Eklavya] What does…`
 * because newlines survive the `question` field intact (verified — see
 * `docs/verified-schemas.md`) and a signature on its own row is the closest the
 * stem can get to a chip. `stripAskHeader` handles either shape regardless,
 * since what the model actually does with an instruction is its own business.
 */
export function attributionRule(): string {
  return needsInlineAttribution()
    ? 'Header "Eklavya", and — because this host draws a question card with no chip in it — ' +
        'open the stem with "[Eklavya]" on its own line, then the question. That line is the only ' +
        'thing on screen saying who is asking. Nothing else goes in the stem: the dials are not ' +
        'shown here either, and they are not what the prefix is for.'
    : 'Header "Eklavya", so it is clear who is asking. Ask the stem on its own — the dials that ' +
        'chose this question live in the status bar, so what you ask is the question and nothing else.';
}
