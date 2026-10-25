import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  BRAND,
  DEMO_PNG,
  MASCOT_FACE,
  PICKED,
  TEACH,
  EMPTY,
  EXPLAINER,
  NEXT_PROMPT,
  PANE,
  REOPEN,
  STR,
  WORDMARK,
  CLOSE_MS,
  DEMO_QUESTION,
  answerWas,
  demoLast,
  demoResult,
  demoSvg,
  demoSvgWithPng,
  explainerBrief,
  codify,
  gradingRequest,
  logoRows,
  boxRows,
  headingParagraphs,
  plainLabel,
  levelLine,
  parseVerdict,
  payloadOf,
  projectName,
  topicLabel,
  unplacedNotice,
  hintLines,
} from './model'
import type { PanelPending, PanelQuestion, PanelState } from './types'
import type { CardProps } from './card'
import type { PillProps } from './pill'

/**
 * The Eklavya quiz panel: a pane that shows the question the tutor model handed
 * to `present_question`, takes the learner's answer and sends it to the Eklavya
 * server to be graded and recorded once.
 *
 * Everything that matters lives in the server and its database: the question,
 * its key, the once-only guard, the grade. This module draws and relays. It
 * never holds the answer key, and any failure leaves the host as it was: a
 * handler that throws is skipped, and the question stays waiting in the database
 * for the next sync.
 */

// Below this many cells across, the header stacks the mark over the topic (the pane reports bodyColumns).
const NARROW = 60

const REF = { plugin: 'eklavya', key: 'quiz' } as const
const quiz = atom(REF, EMPTY)

/** The server's name as /mcp lists it: plugin-scoped first, then the spelling a hand-installed server has. */
const SERVERS = ['plugin:eklavya:eklavya', 'plugin_eklavya_eklavya', 'eklavya']

/** How often the heartbeat may be refreshed from busy events (tool calls, prompts). The planner trusts it for 90 s. */
const HEARTBEAT_MS = 30_000

/** Module variables are lost on a reload, which is fine: each is only a guard against doing a thing twice. */
let lastSyncAt = 0
let openedFor: string | null = null
let working: string | null = null
let busy = false
/** The greeting toast is shown once per session. */
let greeted = false

/** Bumped when the session ends: a submit that began before it is stale and must write nothing. */
let epoch = 0
let explainedAttempt = 0
/** The result closes itself after CLOSE_MS when nothing else is pending (no Next). */
let closer: { cancel: () => void } | null = null

/**
 * One call to an Eklavya tool through the host's own connection, as the parsed
 * JSON every Eklavya tool returns. The first call after a reload can be refused
 * by the host's auto mode classifier ("gave no verdict ... issue the action
 * again once"); asking once more is what it says and what works.
 */
async function call($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  for (const server of working ? [working] : SERVERS) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const reply = await $.mcp.call(server, tool, args)
        working = server
        return payloadOf(reply.content)
      } catch (err) {
        const why = String(err)
        if (why.includes('no connected MCP tool')) break
        if (!why.includes('gave no verdict')) throw err
      }
    }
  }
  throw new Error('the Eklavya server is not connected')
}

/** Where this session is, as the server needs it. */
async function whereAmI($: EngineInterface) {
  const [sessionId, cwd, surfaces, version] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
    $.session.surfaces(),
    $.session.version(),
  ])
  // A session opened without a folder may report no directory; the server reads that as no project.
  return { session_id: sessionId, cwd: cwd ?? '', host: { surface: surfaces[0] ?? 'terminal', version: version.version } }
}

/**
 * Asks the server whether a question is waiting and shows it. Also the mod's
 * heartbeat: the planner chooses this pane only while a sync is fresh.
 */
async function sync($: EngineInterface): Promise<'disabled' | 'none' | 'question'> {
  const where = await whereAmI($)
  const out = await call($, 'panel_sync', where)
  // A host that draws no SessionStart banner gets it here, once. Never sent on the terminal.
  if (typeof out.greeting === 'string' && !greeted) {
    greeted = true
    $.ui.toast(out.greeting)
  }
  // Only a sync that reached the server counts as a heartbeat. The server can
  // still be starting when the session does, and a failed attempt must not hold
  // the next one back.
  lastSyncAt = Date.now()

  if (out.disabled) {
    await update($, quiz, () => EMPTY)
    await $.ui.close({ id: PANE })
    openedFor = null
    return 'disabled'
  }

  if (out.none) {
    // The question that was here is gone: answered elsewhere, expired, or this
    // is a new session. A result the learner is still reading is left alone.
    openedFor = null
    // An answer in flight has just closed the row, so "none" is expected while it
    // is still being sent: keep the question and the answer until it resolves, or
    // a lost reply leaves nothing to Retry (Retry returns the stored result).
    if (!busy) {
      await update($, quiz, (s: PanelState) =>
        s.step === 'card' || s.step === 'awaiting' || s.step === 'grading' || s.step === 'loading' ? { ...EMPTY, message: s.step === 'loading' ? null : s.message } : s,
      )
    }
    return 'none'
  }

  const question = out as unknown as PanelQuestion
  await update($, quiz, (s: PanelState) =>
    s.question?.question_id === question.question_id && s.step !== 'none' && s.step !== 'loading'
      ? { ...s, question }
      : { ...EMPTY, step: question.card ? 'card' : 'awaiting', question },
  )

  // Seat the pane once per question. Opened unasked it sits from 144 columns and
  // waits below that; say so, and report it so the server never counts an
  // invisible question as shown.
  if (openedFor !== question.question_id) {
    openedFor = question.question_id
    const opened = await $.ui.open({ id: PANE, title: STR.brand, closeOnEscape: true })
    await call($, 'panel_sync', {
      ...where,
      placed: { question_id: question.question_id, ok: opened.isPlaced, ...(opened.isPlaced ? {} : { reason: opened.reason }) },
    })
    if (!opened.isPlaced) $.ui.toast(unplacedNotice())
  }
  return 'question'
}

/** A throttled sync for busy events: the heartbeat, and the way a question presented elsewhere finds its pane. */
async function beat($: EngineInterface): Promise<void> {
  if (Date.now() - lastSyncAt < HEARTBEAT_MS) return
  // A mock question is not in the database: a sync would find nothing waiting and clear it.
  if (await inDemo($)) return
  await sync($)
}

async function inDemo($: EngineInterface): Promise<boolean> {
  const s: PanelState = (await $.state.get(REF)).value ?? EMPTY
  return s.demo !== undefined
}

/** The mock question, drawn with the given answer-card style. Opened from the person's own command, so at any width. */
async function startDemo($: EngineInterface, style: 'button' | 'client'): Promise<void> {
  disarm()
  openedFor = null
  await update($, quiz, () => ({ ...EMPTY, step: 'awaiting', question: DEMO_QUESTION, demo: { style, last: STR.demoReady } }))
  await $.ui.open({ id: PANE, title: STR.brand, closeOnEscape: true })
}

/** Says what went wrong, in words, and keeps whatever the learner had written. */
async function fail($: EngineInterface, message: string): Promise<void> {
  await update($, quiz, (s: PanelState) => ({ ...s, step: 'error', message }))
}

/**
 * Sends one answer, grades a typed one first, and shows the verdict. Single
 * flight: `busy` is set before anything is awaited, so a double press or a
 * second Enter cannot send twice (and the server would answer both with the
 * same stored reply anyway).
 */
async function submit($: EngineInterface, wanted: PanelPending | null): Promise<void> {
  if (busy) return
  busy = true
  const mine = epoch
  try {
    const state: PanelState = (await $.state.get(REF)).value ?? EMPTY
    const q = state.question
    if (!q || (state.step !== 'awaiting' && state.step !== 'error')) return

    let pending = wanted ?? state.pending
    if (!pending) {
      if (state.draft.other) {
        if (!state.draft.text.trim()) {
          await update($, quiz, (s: PanelState) => ({ ...s, message: STR.nothingTyped }))
          return
        }
      } else if (!state.draft.picked) {
        return
      }
    }

    // The mock question is answered here: nothing is sent, graded by the server or recorded.
    if (state.demo) {
      const kind = pending ? pending.kind : state.draft.other ? 'text' : 'choice'
      const result = demoResult(kind, pending ? null : state.draft.picked)
      await update($, quiz, (s: PanelState) => ({
        ...s,
        step: result.phase === 'skipped' ? 'skipped' : 'feedback',
        result,
        pending: null,
        message: null,
        demo: s.demo && { ...s.demo, last: demoLast(`${kind} answer submitted`) },
      }))
      return
    }

    await update($, quiz, (s: PanelState) => ({ ...s, step: 'grading', message: null }))
    const where = await whereAmI($)
    if (epoch !== mine) return
    // The session's id now, not the one the question came from: after a /clear
    // the server then refuses this answer as another session's.
    const base = { question_id: q.question_id, session_id: where.session_id, repo: q.repo, cwd: where.cwd }

    if (!pending && state.draft.other) {
      const typed = state.draft.text.trim()
      const held = await call($, 'panel_answer', { ...base, kind: 'text', text: typed })
      if (epoch !== mine) return
      if (held.error === 'stale_question') return stale($)
      if (typeof held.correct_label !== 'string') return fail($, STR.unreachable)
      const asked = gradingRequest(q, held.correct_label, typed)
      const reply = await $.model.complete(asked)
      // The session ended while the grader ran: record nothing for it.
      if (epoch !== mine) return
      const verdict = reply.isAnswered ? parseVerdict(reply.text) : null
      // A refusal, an empty reply, a timeout or anything that is not a verdict
      // records nothing: the learner keeps their words and may try once more.
      if (!verdict) return fail($, STR.graderFailed)
      pending = { kind: 'text', text: typed, ...verdict }
    } else if (!pending) {
      pending = { kind: 'choice', option_id: state.draft.picked! }
    }
    const sent = pending
    await update($, quiz, (s: PanelState) => ({ ...s, pending: sent }))

    const out = await call($, 'panel_answer', { ...base, ...sent })
    if (epoch !== mine) return
    if (out.error === 'stale_question') return stale($)
    if (out.error) return fail($, STR.unreachable)

    await update($, quiz, (s: PanelState) => ({
      ...s,
      step: out.phase === 'skipped' ? 'skipped' : 'feedback',
      result: out as PanelState['result'],
      pending: null,
      message: null,
    }))

    // The last question of a round has no Next: the result closes itself, as Done would.
    if (!q.more) arm($, mine, q.question_id)

    // A miss with explain_on_wrong on: the panel starts the explainer itself in
    // the background, so no prompt shows in the transcript and nothing waits.
    // Auto mode judges every spawn (it drops Agent allow rules), and its
    // classifier can be briefly unavailable, so a refusal is asked once more.
    // A second refusal falls back to the queued prompt the model acts on.
    if (out.explain?.instruction && explainedAttempt !== out.attempt_id) {
      explainedAttempt = out.attempt_id
      let spawned = null
      for (let tries = 0; tries < 2 && (!spawned || spawned.deny); tries += 1) {
        spawned = await $.agent
          .spawn({ subagentType: EXPLAINER, description: 'Eklavya explainer', prompt: explainerBrief(out.explain) })
          .catch(() => null)
      }
      if (!spawned || spawned.deny) await $.prompt.submit({ text: String(out.explain.instruction) })
    }
  } catch {
    if (epoch === mine) await fail($, STR.unreachable)
  } finally {
    // Only this submission's own flag: a newer session's may be set by now.
    if (epoch === mine) busy = false
  }
}

/** The question belongs to another session or project: say so, drop the draft, and look again. */
async function stale($: EngineInterface): Promise<void> {
  openedFor = null
  await update($, quiz, () => ({ ...EMPTY, message: STR.stale }))
  await sync($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'eklavya-panel', description: 'Open the Eklavya quiz panel' })
    } catch {
      /* Without the command the pane still opens by itself; only reopening is lost. */
    }
    try {
      await $.command.register({ name: 'eklavya-panel-demo', description: 'Open the Eklavya quiz panel with a mock question, to try its clicks' })
    } catch {
      /* Only the test shortcut is lost. */
    }
    try {
      await sync($)
    } catch {
      /* Fail open: the question stays in the database for the next sync. */
    }
    return next(e)
  })

  // A /clear, a resume or a close of the session ends this session's panel
  // state; a question still waiting in the database survives and comes back on
  // the next sync.
  on('session.end', async ($, e, next) => {
    try {
      epoch += 1
      greeted = false
      disarm()
      openedFor = null
      busy = false
      await update($, quiz, () => EMPTY)
    } catch {
      /* Nothing to undo. */
    }
    return next(e)
  })

  // The question reaches the pane when the model's present_question call returns
  // (the tool is Eklavya's, and the model carries on regardless). Any other call
  // refreshes the heartbeat first, now and then, so it is fresh when the hooks
  // that choose how to ask run after the tool. Eklavya's own panel_* calls pass
  // through.
  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    if (name.includes('__panel_')) return next(e)
    const isPresent = /^mcp__(plugin_eklavya_)?eklavya__present_question$/.test(name)
    if (!isPresent) {
      try {
        await beat($)
      } catch {
        /* Fail open. */
      }
    }
    const ran = await next(e)
    if (isPresent) {
      try {
        await sync($)
      } catch {
        /* Fail open. */
      }
    }
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      await beat($)
    } catch {
      /* Fail open. */
    }
    return next(e)
  })

  on('command.run', { command: 'eklavya-panel' }, async $ => {
    try {
      openedFor = null
      // A mock question on screen gives way to the real state.
      if (await inDemo($)) await update($, quiz, () => EMPTY)
      // The person typed this, so the pane is seated at any width. Off is inert:
      // the server says so and nothing is opened.
      const found = await sync($)
      if (found === 'disabled') return { text: STR.off }
      if (found === 'none') await $.ui.open({ id: PANE, title: STR.brand, closeOnEscape: true })
      return { text: 'Eklavya quiz panel opened.' }
    } catch {
      return { text: `The Eklavya quiz panel could not open. Try ${REOPEN} again.` }
    }
  })

  // The mock question: opens at once, answered on this machine, so a card or a click can be tried with no real question waiting.
  on('command.run', { command: 'eklavya-panel-demo' }, async $ => {
    try {
      await startDemo($, 'client')
      return { text: STR.demoOpened }
    } catch {
      return { text: STR.demoFailed }
    }
  })

  // A press on a `Client` region (card.tsx, pill.tsx) arrives here as data, never as a fact: only an id of the open question, Other, or Teach me counts.
  on('ui.message', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId === PANE) {
      try {
        const started = Date.now()
        const data = e.data as { pick?: unknown; press?: unknown } | null
        const id = data?.pick
        const s: PanelState = (await $.state.get(REF)).value ?? EMPTY
        if (id === 'other') await chooseOther($)
        else if (typeof id === 'string' && s.question?.options.some(o => o.id === id)) await pick($, id, 'whole card', started)
        else if (data?.press === 'teach' && s.question && (s.step === 'awaiting' || s.step === 'error')) await teach($)
      } catch {
        /* Fail open: the card stays as it was. */
      }
    }
    return next(e)
  })

  // The mod's queued prompts are instructions for the model, not words for the
  // learner: their transcript row shows one short line, as a tool call does.
  // Only the drawing changes; the model still reads the whole message.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const from = e.props.origin
    if (from.kind !== 'plugin' || from.name !== 'eklavya') return next(e)
    const said = e.props.text
    const text = said === NEXT_PROMPT ? STR.askedNext : said.includes('eklavya-explainer') ? STR.askedExplainer : STR.askedOther
    return next({ ...e, props: { ...e.props, text } })
  })

  on('ui.render', { component: 'Pane', requestId: 'eklavya-quiz' }, async ($, e, next) => {
    // Only our pane: every other pane, and everything else, is the host's.
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Input, Markdown, Client, Svg, Image } = $.ui.resolve(e) as any
    const s: PanelState = await read($, quiz)
    const q = s.question

    // Any surface but the terminal is the desktop app's: it sets the question as a heading, spaces the
    // answers apart and draws the mark in boxes. The terminal keeps its text layout.
    const app = e.surface !== 'terminal'
    // Only the desktop app draws a `Client` (the whole-card answers, the Teach me pill, the Other row). VS Code has `Svg` but no `Client`:
    // a tree holding an element its surface lacks is replaced whole, so VS Code keeps the native buttons.
    const desktop = e.surface === 'desktop'
    // `Svg` is drawn by the desktop app and VS Code only (the elements table lists no other surface), so any other surface keeps the grid mark.
    const vector = desktop || e.surface === 'vscode'
    // The mark is drawn in text, as Claude Code draws its own, so it shows in every terminal. The
    // desktop app sets text in a proportional font with its own line height, so glyph cells do not
    // tile there: it gets the same grid as filled boxes, one per run of a colour. A cell is one unit
    // wide and half a unit tall, which is square in the app (checked live there; the host's
    // fractional-height support is not documented, so a failure shows as a stretched mark).
    const logo =
      !app ? (
        <Box flexDirection="column" flexShrink={0}>
          {logoRows().map((runs, y) => (
            <Box key={`logo-${y}`} flexDirection="row" flexShrink={0}>
              {runs.map((run, x) => (
                <Text key={`logo-${y}-${x}`} color={run.fg} backgroundColor={run.bg} wrap="truncate">
                  {run.text}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      ) : vector ? (
        // The mascot's own neutral face, as the vector artwork the brand ships (the block grid is for the terminal's cells).
        <Box flexDirection="column" flexShrink={0}>
          <Svg alt={STR.mascotAlt} width={72} height={73} source={MASCOT_FACE} />
        </Box>
      ) : (
        <Box flexDirection="column" flexShrink={0}>
          {boxRows().map((runs, y) => (
            <Box key={`logo-${y}`} flexDirection="row" flexShrink={0} height={0.5}>
              {runs.map((run, x) => (
                <Box key={`logo-${y}-${x}`} width={run.width} height={0.5} flexShrink={0} backgroundColor={run.color} />
              ))}
            </Box>
          ))}
        </Box>
      )
    // A list tile: the mark on the left, the name over the topic beside it. A pane narrower than
    // NARROW cells stacks them, so the topic gets the full width instead of a sliver.
    const stacked = ((e.props as { bodyColumns?: number }).bodyColumns ?? Infinity) < NARROW
    const head = (subtitle?: string) => (
      <Box flexDirection={stacked ? 'column' : 'row'} alignItems={stacked ? 'flex-start' : 'center'} gap={2}>
        {logo}
        <Box flexDirection="column" flexShrink={1}>
          <Text bold color={BRAND}>
            {WORDMARK}
          </Text>
          {subtitle ? <Text wrap="wrap">{subtitle}</Text> : null}
        </Box>
      </Box>
    )
    // The desktop app never sends the pane its keys (see hintLines), so it gets no hotkeys and no hints.
    const hk = (k: string) => (app ? undefined : k)
    const hint = app ? null : (
      <Box flexDirection="column">
        {hintLines(e.surface).map(line => (
          <Text key={line} dimColor>
            {line}
          </Text>
        ))}
      </Box>
    )
    // One answer: a bordered block. The Button holds the answer text, so a press on it
    // selects; the border and fill show the pick, and nothing implies it is
    // right. The desktop app gives the text more room inside the border; the padding itself is not
    // pressable, since a Button takes none. The terminal keeps its tight cards.
    // Other is never filled: the learner types inside it, in the host's own text colour, which a fixed fill could hide.
    const card = (id: string, selected: boolean, button: unknown, body: unknown[], roomy = false) => (
      <Box
        key={`card-${id}`}
        flexDirection="column"
        paddingX={app ? 2 : 1}
        paddingY={app || roomy ? 1 : 0}
        gap={roomy ? 1 : 0}
        borderStyle={selected ? 'bold' : 'single'}
        borderColor={selected ? BRAND : 'inactive'}
        backgroundColor={selected && id !== 'other' ? PICKED.bg : undefined}
      >
        {button}
        {body}
      </Box>
    )
    // The mock question's tester bar: what it is, the last click, and (desktop only) how the answer cards are drawn.
    const demoBar = s.demo ? (
      <Box key="demo-bar" flexDirection="column" gap={app ? 1 : 0}>
        <Text color="warning">{STR.demoBanner}</Text>
        <Text dimColor>{s.demo.last}</Text>
        {desktop ? (
          <Box flexDirection="row" gap={2} alignItems="center">
            <Text dimColor>{STR.demoStyleLabel}</Text>
            <Button key="style-button" label={STR.demoStyleButton} variant={s.demo.style === 'button' ? 'primary' : 'secondary'} onPress={() => setStyle($, 'button')} />
            <Button key="style-client" label={STR.demoStyleClient} variant={s.demo.style === 'client' ? 'primary' : 'secondary'} onPress={() => setStyle($, 'client')} />
          </Box>
        ) : null}
      </Box>
    ) : null
    const frame = (...body: unknown[]) => (
      <Box flexDirection="column" paddingX={1} gap={1}>
        {head(q ? topicLabel(q) : undefined)}
        {demoBar}
        {body}
        {hint}
      </Box>
    )

    if (s.step === 'loading') return frame(<Text dimColor>{STR.loading}</Text>)

    if (s.step === 'none' || !q) {
      return frame(
        <Text dimColor>{s.message ?? STR.empty}</Text>,
        <Box flexDirection="row" gap={2}>
          <Button label={STR.close} role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>,
      )
    }

    if (s.step === 'card' && q.card) {
      return frame(
        <Text bold color={BRAND}>{STR.dyk}</Text>,
        <Markdown text={codify(q.card.fact)} />,
        s.learn ? <Markdown text={codify(q.card.details)} /> : null,
        <Box flexDirection="row" gap={2}>
          {s.learn ? null : <Button key="knew" label={STR.knew} hotkey={hk('i')} onPress={() => askQuestion($)} />}
          <Button key="learn" label={s.learn ? STR.gotIt : STR.learnMore} variant="primary" hotkey={hk('m')} onPress={() => (s.learn ? askQuestion($) : learnMore($))} />
        </Box>,
      )
    }

    const stem = <Markdown text={app ? headingParagraphs(codify(q.stem)) : codify(q.stem)} />

    if (s.step === 'feedback' || s.step === 'skipped') {
      const r = s.result
      if (s.step === 'skipped' || !r) {
        return frame(<Text>{STR.skipped}</Text>, q.more ? null : <Text dimColor>{STR.autoClose}</Text>, <Button key="done" label={STR.done} variant="primary" hotkey={hk('d')} onPress={() => done($)} />)
      }
      const right = r.correct === true
      return frame(
        stem,
        <Text bold color={right ? 'suggestion' : r.taught ? BRAND : 'error'}>
          {right ? STR.correct : r.taught ? STR.taught : STR.wrong}
        </Text>,
        right || !r.correct_label ? null : <Text>{answerWas(r.correct_label)}</Text>,
        r.explanation ? <Markdown text={codify(r.explanation)} /> : null,
        r.level_up ? <Text color="suggestion">{levelLine(r.level_up.from, projectName(q.repo))}</Text> : null,
        r.explain ? <Text dimColor>{r.taught ? STR.taughtExplainer : STR.explainer}</Text> : null,
        q.more ? null : <Text dimColor>{STR.autoClose}</Text>,
        <Box flexDirection="row" gap={2}>
          {q.more ? <Button key="next" label={STR.next} hotkey={hk('n')} onPress={() => askNext($)} /> : null}
          <Button key="done" label={STR.done} variant="primary" hotkey={hk('d')} onPress={() => done($)} />
        </Box>,
      )
    }

    const locked = s.step === 'grading'
    // Submit looks disabled until there is something to send; pressing it then does nothing.
    const hasDraft = s.draft.other ? s.draft.text.trim().length > 0 : s.draft.picked !== null
    // In the terminal the answer and its note are the Button's own inline Text, so a press anywhere on them
    // selects. The desktop app draws only a Button's label (docs/verified-schemas.md row 17), so there the
    // note is a Text under the Button and only the answer selects.
    // Markdown marks cannot show inside a Button, so the code and bold marks are dropped from both.
    // The pick shows by the card's border and fill, never a mark in the text, so picking moves nothing.
    // The terminal indents the note under the `1: ` its plain Button draws.
    // `wrap` asks the app to wrap a long answer rather than cut it off.
    const answer = (id: string, key: string, hotkey: string, label: string, chosen: boolean, note?: string) => (
      <Button
        key={key}
        plain
        hotkey={hk(hotkey)}
        label={label}
        onPress={() => (locked ? undefined : id === 'other' ? chooseOther($) : pick($, id))}
      >
        <Text wrap="wrap" bold={chosen} color={chosen && id !== 'other' ? PICKED.text : undefined}>{label}</Text>
        {note && !app ? <Text wrap="wrap" dimColor={!chosen} color={chosen ? PICKED.note : undefined}>{`\n   ${note}`}</Text> : null}
      </Button>
    )
    // The desktop app draws each answer as one pressable region, so a click on its padding or note picks too (card.tsx);
    // the demo can switch back to the native buttons to compare.
    const wholeCard = desktop && (s.demo ? s.demo.style === 'client' : true)
    const cardProps = (id: string, over: Partial<CardProps>): CardProps => ({ id, label: '', note: '', chosen: false, locked, brand: BRAND, fill: PICKED.bg, text: PICKED.text, noteText: PICKED.note, ...over })
    const options = q.options.map((o, i) => {
      const chosen = !s.draft.other && s.draft.picked === o.id
      if (wholeCard) {
        const props = cardProps(o.id, { label: plainLabel(o.label), note: o.note ? plainLabel(o.note) : '', n: i + 1, chosen })
        return <Client key={`card-${o.id}`} module="./card.tsx" width="100%" props={props} />
      }
      return card(
        o.id,
        chosen,
        // The terminal's plain Button draws its own `1:`; the other surfaces number the label themselves.
        answer(o.id, `opt-${o.id}`, String(i + 1), app ? `${i + 1}  ${plainLabel(o.label)}` : plainLabel(o.label), chosen, o.note ? plainLabel(o.note) : undefined),
        // The desktop app draws only a Button's label, not its inline children, so there the note sits under the button.
        app && o.note
          ? [<Text key={`note-${o.id}`} wrap="wrap" dimColor={!chosen} color={chosen ? PICKED.note : undefined}>{plainLabel(o.note)}</Text>]
          : [],
      )
    })

    // The demo's picture test, under Teach me. The terminal has Image and no Svg; every other surface has Svg and no Image
    // (a tree with an element its surface lacks is replaced whole by the host's own pane, so each surface gets only its own).
    const experiment = s.demo ? (
      <Box key="experiment" flexDirection="column" gap={1} borderStyle="dashed" borderColor="warning" paddingX={1} paddingY={app ? 1 : 0}>
        <Text color="warning" bold>
          {STR.experimentBanner}
        </Text>
        {vector ? (
          <Box flexDirection="column" gap={1}>
            <Text dimColor>{STR.experimentSvg}</Text>
            <Svg alt={STR.experimentImageAlt} width={96} height={96} source={demoSvg()} />
            <Text dimColor>{STR.experimentSvgPng}</Text>
            <Svg alt={STR.experimentImageAlt} width={96} height={96} source={demoSvgWithPng()} />
          </Box>
        ) : app ? (
          <Text dimColor wrap="wrap">
            {STR.experimentNone}
          </Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor wrap="wrap">
              {STR.experimentTerminal}
            </Text>
            <Image key="experiment-image" source={{ png: DEMO_PNG }} columns={12} rows={6} alt={STR.experimentImageAlt} />
          </Box>
        )}
      </Box>
    ) : null

    return frame(
      stem,
      <Box flexDirection="column" gap={app ? 2 : 0} marginTop={app ? 1 : 0}>
        {options}
        {wholeCard ? (
          // The header row is the pressable region; the frame and the text box are ours. Three lines tall, saved on every keystroke,
          // so the button the field draws beside itself has nothing to do: its label is left empty to try to hide it.
          <Box key="card-other" flexDirection="column" borderStyle={s.draft.other ? 'bold' : 'single'} borderColor={s.draft.other ? BRAND : 'inactive'}>
            <Client key="other-head" module="./card.tsx" width="100%" props={cardProps('other', { label: STR.other, chosen: s.draft.other, bare: true })} />
            {s.draft.other ? (
              <Box key="other-box" paddingX={2} paddingBottom={1}>
                <Input
                  key="other-text"
                  autoFocus
                  rows={3}
                  placeholder={STR.otherPlaceholder}
                  value={s.draft.text}
                  submitLabel=""
                  onInput={(value: string) => (locked ? undefined : typeOther($, value))}
                  onSubmit={() => (locked ? undefined : keepOther($))}
                />
              </Box>
            ) : null}
          </Box>
        ) : (
          card(
            'other',
            s.draft.other,
            answer('other', 'opt-other', 'o', STR.other, s.draft.other),
            [
              s.draft.other ? (
                <Box key="other-box" paddingLeft={3}>
                  <Input
                    key="other-text"
                    autoFocus
                    placeholder={STR.otherPlaceholder}
                    value={s.draft.text}
                    submitLabel="keep"
                    onInput={(value: string) => (locked ? undefined : typeOther($, value))}
                    onSubmit={() => (locked ? undefined : keepOther($))}
                  />
                </Box>
              ) : null,
            ],
            s.draft.other,
          )
        )}
      </Box>,
      locked ? <Text dimColor>{STR.grading}</Text> : null,
      s.step === 'error' && s.message ? <Text color="error">{s.message}</Text> : null,
      s.step === 'awaiting' && s.message ? <Text color="warning">{s.message}</Text> : null,
      <Box flexDirection="row" gap={2}>
        {locked ? null : s.step === 'error' ? (
          <Button key="retry" label={STR.retry} variant="primary" hotkey={hk('r')} onPress={() => submit($, null)} />
        ) : (
          <Button key="submit" label={STR.submit} variant="primary" dimColor={!hasDraft} hotkey={hk('s')} onPress={() => submit($, null)} />
        )}
        {locked ? null : <Button key="skip" label={STR.skip} dimColor hotkey={hk('k')} onPress={() => skip($)} />}
        {s.step === 'error' ? <Button key="close" label={STR.close} onPress={() => $.ui.close({ id: PANE })} /> : null}
      </Box>,
      // Teach me has a row of its own, under Submit. A Button takes no fill, and a desktop draws a plain
      // one without its grey chrome: the orange box is the button's body, and as a column it
      // stretches the Button across its width, so all but the thin padding is pressable.
      locked ? null : desktop ? (
        // A compact pill whose whole body is pressable (pill.tsx), sized to its text instead of the pane's width.
        <Box key="teach-row" flexDirection="row">
          <Client
            key="teach-client"
            module="./pill.tsx"
            props={{ id: 'teach', label: STR.teach, locked, fill: TEACH.bg, hoverFill: TEACH.hover, text: TEACH.text } satisfies PillProps}
          />
        </Box>
      ) : app ? (
        <Box key="teach-box" flexDirection="column" backgroundColor={TEACH.bg} borderStyle="round" borderColor={TEACH.bg} paddingX={1} paddingY={0.5}>
          <Button key="teach" plain label={STR.teach} onPress={() => teach($)}>
            <Text color={TEACH.text}>{STR.teach}</Text>
          </Button>
        </Box>
      ) : (
        <Box key="teach-row" flexDirection="row">
          <Button key="teach" label={STR.teach} hotkey={hk('t')} onPress={() => teach($)}>
            <Text color={TEACH.text} backgroundColor={TEACH.bg}>{STR.teach}</Text>
          </Button>
        </Box>
      ),
      experiment,
    )
  })
}

/** The demo's switch between the two ways of drawing an answer card on the desktop. */
async function setStyle($: EngineInterface, style: 'button' | 'client'): Promise<void> {
  await update($, quiz, (s: PanelState) => (s.demo ? { ...s, demo: { ...s.demo, style, last: demoLast(`card style set to ${style}`) } } : s))
}

/** Selecting an option records a draft and nothing else: it never submits, grades or skips. */
async function pick($: EngineInterface, id: string, via = 'button', since?: number): Promise<void> {
  await update($, quiz, (s: PanelState) =>
    s.step === 'awaiting' || s.step === 'error'
      ? { ...s, draft: { ...s.draft, picked: id, other: false }, message: null, ...(s.demo ? { demo: { ...s.demo, last: demoLast(`${id} picked (${via}${since === undefined ? '' : `, ${Date.now() - since} ms in the mod`})`) } } : {}) }
      : s,
  )
  // A whole card has no Button to focus, so asking the host to find `opt-…` would only make the pick wait.
  if (via !== 'button') return
  try {
    // The host's focus mark follows the pick, so the highlighted answer is the chosen one even after a hotkey.
    await $.ui.focus({ requestId: PANE, key: `opt-${id}` })
  } catch {
    /* Fail open: the pick stands without it. */
  }
}

async function chooseOther($: EngineInterface): Promise<void> {
  await update($, quiz, (s: PanelState) => (s.step === 'awaiting' || s.step === 'error' ? { ...s, draft: { ...s.draft, picked: null, other: true }, message: null } : s))
}

async function typeOther($: EngineInterface, value: string): Promise<void> {
  await update($, quiz, (s: PanelState) => (s.step === 'awaiting' || s.step === 'error' ? { ...s, draft: { ...s.draft, text: value } } : s))
}

/** Enter in the Other box keeps what is typed (onInput already stored it, so the host's cleared value never overwrites it) and moves focus to Submit. */
async function keepOther($: EngineInterface): Promise<void> {
  // The primary button is keyed `retry` after a failed grade and `submit` otherwise; only the drawn one accepts focus.
  for (const key of ['submit', 'retry']) {
    try {
      await $.ui.focus({ requestId: PANE, key })
      return
    } catch {
      /* Fail open: the text stays in the draft without the focus move. */
    }
  }
}

/** "I knew this" and "Got it": the card is done, the question follows. */
async function askQuestion($: EngineInterface): Promise<void> {
  await update($, quiz, (s: PanelState) => (s.step === 'card' ? { ...s, step: 'awaiting', learn: false } : s))
}

/** "I want to learn more": the longer version shows under the fact, and the card stays until Got it. */
async function learnMore($: EngineInterface): Promise<void> {
  await update($, quiz, (s: PanelState) => (s.step === 'card' ? { ...s, learn: true } : s))
}

/** "Teach me": a blank the learner asks to have taught. Recorded as dont_know; the explainer starts like it does for a miss. */
async function teach($: EngineInterface): Promise<void> {
  await submit($, { kind: 'dont_know' })
}

async function skip($: EngineInterface): Promise<void> {
  await submit($, { kind: 'skip' })
}

/** Starts the auto-close for this result; any later Done, Next or new question cancels it. */
function arm($: EngineInterface, mine: number, id: string): void {
  try {
    closer?.cancel()
    closer = $.clock.after(CLOSE_MS, async () => {
      try {
        closer = null
        if (epoch !== mine) return
        const s: PanelState = (await $.state.get(REF)).value ?? EMPTY
        // Only the result it was started for: an answer-in-progress or a newer question stays.
        if ((s.step === 'feedback' || s.step === 'skipped') && s.question?.question_id === id) await done($)
      } catch {
        /* Fail open. */
      }
    })
  } catch {
    /* No clock: the learner presses Done. */
  }
}

function disarm(): void {
  closer?.cancel()
  closer = null
}

/** Done closes the pane; another question may already be waiting, and then the pane comes straight back. */
async function done($: EngineInterface): Promise<void> {
  disarm()
  try {
    openedFor = null
    await update($, quiz, () => EMPTY)
    await $.ui.close({ id: PANE })
    await sync($)
  } catch {
    /* Fail open. */
  }
}

/** Next asks the model, by a queued prompt, for the next question of an explicit round. */
async function askNext($: EngineInterface): Promise<void> {
  disarm()
  try {
    openedFor = null
    const now: PanelState = (await $.state.get(REF)).value ?? EMPTY
    // Next in the demo starts the mock again: it must not ask the model for a real question.
    if (now.demo) return await startDemo($, now.demo.style)
    await update($, quiz, () => ({ ...EMPTY, step: 'loading' }))
    await $.prompt.submit({ text: NEXT_PROMPT })
  } catch {
    await fail($, STR.unreachable)
  }
}
