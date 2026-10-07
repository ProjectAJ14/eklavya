import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  EMPTY,
  NEXT_PROMPT,
  PANE,
  REOPEN,
  STR,
  answerWas,
  gradingRequest,
  levelLine,
  parseVerdict,
  payloadOf,
  projectName,
  topicLabel,
  unplacedNotice,
} from './model'
import type { PanelPending, PanelQuestion, PanelState } from './types'

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
let explainedAttempt = 0

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
  return { session_id: sessionId, cwd, host: { surface: surfaces[0] ?? 'terminal', version: version.version } }
}

/**
 * Asks the server whether a question is waiting and shows it. Also the mod's
 * heartbeat: the planner chooses this pane only while a sync is fresh.
 */
async function sync($: EngineInterface): Promise<'disabled' | 'none' | 'question'> {
  lastSyncAt = Date.now()
  const where = await whereAmI($)
  const out = await call($, 'panel_sync', where)

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
    await update($, quiz, (s: PanelState) =>
      s.step === 'awaiting' || s.step === 'grading' || s.step === 'loading' ? { ...EMPTY, message: s.step === 'loading' ? null : s.message } : s,
    )
    return 'none'
  }

  const question = out as unknown as PanelQuestion
  await update($, quiz, (s: PanelState) =>
    s.question?.question_id === question.question_id && s.step !== 'none' && s.step !== 'loading'
      ? { ...s, question }
      : { ...EMPTY, step: 'awaiting', question },
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
  await sync($)
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

    await update($, quiz, (s: PanelState) => ({ ...s, step: 'grading', message: null }))
    const where = await whereAmI($)
    // The session's id now, not the one the question came from: after a /clear
    // the server then refuses this answer as another session's.
    const base = { question_id: q.question_id, session_id: where.session_id, repo: q.repo, cwd: where.cwd }

    if (!pending && state.draft.other) {
      const typed = state.draft.text.trim()
      const held = await call($, 'panel_answer', { ...base, kind: 'text', text: typed })
      if (held.error === 'stale_question') return stale($)
      if (typeof held.correct_label !== 'string') return fail($, STR.unreachable)
      const asked = gradingRequest(q, held.correct_label, typed)
      const reply = await $.model.complete(asked)
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
    if (out.error === 'stale_question') return stale($)
    if (out.error) return fail($, STR.unreachable)

    await update($, quiz, (s: PanelState) => ({
      ...s,
      step: out.phase === 'skipped' ? 'skipped' : 'feedback',
      result: out as PanelState['result'],
      pending: null,
      message: null,
    }))

    // A miss with explain_on_wrong on: the explainer is started by a queued
    // prompt, so the work is not paused and nothing here waits for it.
    if (out.explain?.instruction && explainedAttempt !== out.attempt_id) {
      explainedAttempt = out.attempt_id
      await $.prompt.submit({ text: String(out.explain.instruction) })
    }
  } catch {
    await fail($, STR.unreachable)
  } finally {
    busy = false
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
      openedFor = null
      busy = false
      await update($, quiz, () => EMPTY)
    } catch {
      /* Nothing to undo. */
    }
    return next(e)
  })

  // The question reaches the pane when the model's present_question call returns
  // (the tool is Eklavya's, and the model carries on regardless); other calls
  // refresh the heartbeat now and then. Eklavya's own panel_* calls pass through.
  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    if (name.includes('__panel_')) return next(e)
    const ran = await next(e)
    try {
      if (/^mcp__(plugin_eklavya_)?eklavya__present_question$/.test(name)) await sync($)
      else await beat($)
    } catch {
      /* Fail open. */
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

  on('ui.render', { component: 'Pane', requestId: 'eklavya-quiz' }, async ($, e, next) => {
    // Only our pane: every other pane, and everything else, is the host's.
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e) as any
    const s: PanelState = await read($, quiz)
    const q = s.question

    const head = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="suggestion">
          {STR.brand}
        </Text>
        <Text dimColor>{STR.powered}</Text>
      </Box>
    )
    const hint = <Text dimColor>Ctrl+X then Tab moves focus here. Enter presses a button. Esc returns to the prompt.</Text>
    const frame = (...body: unknown[]) => (
      <Box flexDirection="column" paddingX={1} gap={1}>
        {head}
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

    const topic = <Text dimColor>{topicLabel(q)}</Text>
    const stem = <Text bold>{q.stem}</Text>

    if (s.step === 'feedback' || s.step === 'skipped') {
      const r = s.result
      if (s.step === 'skipped' || !r) {
        return frame(topic, <Text>{STR.skipped}</Text>, <Button key="done" label={STR.done} variant="primary" hotkey="d" onPress={() => done($)} />)
      }
      const right = r.correct === true
      return frame(
        topic,
        stem,
        <Text bold color={right ? 'suggestion' : 'error'}>
          {right ? STR.correct : STR.wrong}
        </Text>,
        right || !r.correct_label ? null : <Text>{answerWas(r.correct_label)}</Text>,
        r.explanation ? <Text>{r.explanation}</Text> : null,
        r.level_up ? <Text color="suggestion">{levelLine(r.level_up.from, projectName(q.repo))}</Text> : null,
        r.explain ? <Text dimColor>{STR.explainer}</Text> : null,
        <Box flexDirection="row" gap={2}>
          {q.more ? <Button key="next" label={STR.next} hotkey="n" onPress={() => askNext($)} /> : null}
          <Button key="done" label={STR.done} variant="primary" hotkey="d" onPress={() => done($)} />
        </Box>,
      )
    }

    const locked = s.step === 'grading'
    // Submit looks disabled until there is something to send; pressing it then does nothing.
    const hasDraft = s.draft.other ? s.draft.text.trim().length > 0 : s.draft.picked !== null
    const options = q.options.map((o, i) => {
      const chosen = !s.draft.other && s.draft.picked === o.id
      return (
        <Box key={`row-${o.id}`} flexDirection="column">
          <Button
            key={`opt-${o.id}`}
            plain
            label={`${chosen ? '●' : '○'} ${o.label}`}
            hotkey={String(i + 1)}
            onPress={() => (locked ? undefined : pick($, o.id))}
          />
          {o.note ? <Text dimColor>{`  ${o.note}`}</Text> : null}
        </Box>
      )
    })

    return frame(
      topic,
      stem,
      <Box flexDirection="column" gap={1}>
        {options}
        <Button
          key="opt-other"
          plain
          label={`${s.draft.other ? '●' : '○'} ${STR.other}`}
          hotkey="o"
          onPress={() => (locked ? undefined : chooseOther($))}
        />
        {s.draft.other ? (
          <Input
            key="other-text"
            placeholder={STR.otherPlaceholder}
            value={s.draft.text}
            submitLabel="keep"
            onInput={(value: string) => (locked ? undefined : typeOther($, value))}
            onSubmit={(value: string) => (locked ? undefined : typeOther($, value))}
          />
        ) : null}
      </Box>,
      locked ? <Text dimColor>{STR.grading}</Text> : null,
      s.step === 'error' && s.message ? <Text color="error">{s.message}</Text> : null,
      s.step === 'awaiting' && s.message ? <Text color="warning">{s.message}</Text> : null,
      <Box flexDirection="row" gap={2}>
        {locked ? null : s.step === 'error' ? (
          <Button key="retry" label={STR.retry} variant="primary" hotkey="r" onPress={() => submit($, null)} />
        ) : (
          <Button key="submit" label={STR.submit} variant="primary" dimColor={!hasDraft} hotkey="s" onPress={() => submit($, null)} />
        )}
        {locked ? null : <Button key="skip" label={STR.skip} dimColor hotkey="k" onPress={() => skip($)} />}
        {s.step === 'error' ? <Button key="close" label={STR.close} onPress={() => $.ui.close({ id: PANE })} /> : null}
      </Box>,
    )
  })
}

/** Selecting an option records a draft and nothing else: it never submits, grades or skips. */
async function pick($: EngineInterface, id: string): Promise<void> {
  await update($, quiz, (s: PanelState) => (s.step === 'awaiting' || s.step === 'error' ? { ...s, draft: { ...s.draft, picked: id, other: false }, message: null } : s))
}

async function chooseOther($: EngineInterface): Promise<void> {
  await update($, quiz, (s: PanelState) => (s.step === 'awaiting' || s.step === 'error' ? { ...s, draft: { ...s.draft, picked: null, other: true }, message: null } : s))
}

async function typeOther($: EngineInterface, value: string): Promise<void> {
  await update($, quiz, (s: PanelState) => (s.step === 'awaiting' || s.step === 'error' ? { ...s, draft: { ...s.draft, text: value } } : s))
}

async function skip($: EngineInterface): Promise<void> {
  await submit($, { kind: 'skip' })
}

/** Done closes the pane; another question may already be waiting, and then the pane comes straight back. */
async function done($: EngineInterface): Promise<void> {
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
  try {
    openedFor = null
    await update($, quiz, () => ({ ...EMPTY, step: 'loading' }))
    await $.prompt.submit({ text: NEXT_PROMPT })
  } catch {
    await fail($, STR.unreachable)
  }
}
