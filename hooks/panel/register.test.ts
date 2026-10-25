import { describe, expect, mock, test } from 'claude-code/testing'

import Card from './card'
import Pill from './pill'
import { BRAND, MASCOT_FACE, DEMO_PNG, demoSvg, demoSvgWithPng, DEMO_QUESTION, DEMO_RIGHT, demoResult, EMPTY, EXPLAINER, NEXT_PROMPT, STR, hintLines, explainerBrief, gradingRequest, parseVerdict, payloadOf, projectName, topicLabel, unplacedNotice, WORDMARK, PICKED, TEACH, LOGO_GRID, LOGO_PALETTE, codify, headingParagraphs, logoRows, boxRows, plainLabel } from './model'

const PLUGIN = 'eklavya'
const PANE = 'eklavya-quiz'
const SURFACES = ['terminal', 'desktop'] as const
/** The surfaces that keep the native Button cards: the desktop app draws region cards instead (and so does nothing a Button does). */
const NATIVE = ['terminal', 'vscode'] as const

const QUESTION = {
  question_id: 'q1',
  repo: '/work/proj',
  stem: 'Why does the server compare the Origin header?',
  options: [
    { id: 'o1', label: 'Tokens are checked by the server', note: 'note one' },
    { id: 'o2', label: 'Cookies are signed', note: 'note two' },
    { id: 'o3', label: 'The origin is compared', note: 'note three' },
    { id: 'o4', label: 'The body is hashed', note: 'note four' },
  ],
  concept_name: 'CSRF',
  tier: 2,
  more: false,
  phase: 'pending',
}

const reply = (payload: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false })

/**
 * A stand-in for the Eklavya server and the host, answering beneath the mod:
 * what `panel_sync` says is waiting, what `panel_answer` replies, whether the
 * host seats the pane, what the grader says. Every call is recorded.
 */
function world(on: any, script: Record<string, any> = {}) {
  const log = { calls: [] as { tool: string; args: any }[], prompts: [] as string[], opens: [] as any[], closes: [] as any[], toasts: [] as string[], graded: [] as string[], spawns: [] as any[] }
  const s = {
    waiting: QUESTION as any,
    answer: ((args: any) => ({ phase: 'answered', attempt_id: 7, correct: args.option_id === 'o3', correct_label: 'The origin is compared', explanation: 'The Origin cannot be forged.' })) as any,
    placed: true,
    surfaces: ['terminal'] as string[],
    spawn: { model: 'm', agentId: 'a1' } as any,
    verdict: '{"grade":5,"outcome":"answered","feedback":"Right, and you said why."}' as any,
    ...script,
  }
  on('mcp.call', async (_$: any, e: any) => {
    log.calls.push({ tool: e.tool, args: e.args })
    if (e.tool === 'panel_sync') return { value: reply(s.waiting ?? { none: true }) }
    if (e.tool === 'panel_answer') {
      if (e.args.kind === 'text' && e.args.grade === undefined) return { value: reply({ phase: 'grading', correct_label: 'The origin is compared' }) }
      return { value: reply(await s.answer(e.args)) }
    }
    return { value: reply({ error: 'unknown_tool' }) }
  })
  on('ui.open', async (_$: any, e: any) => {
    log.opens.push(e)
    return { value: s.placed ? { isPlaced: true } : { isPlaced: false, reason: 'width 80 is under the floor of 144' } }
  })
  on('model.complete', async (_$: any, e: any) => {
    log.graded.push(e.prompt)
    if (typeof s.verdict === 'function') return { value: await s.verdict() }
    return { value: typeof s.verdict === 'string' ? { isAnswered: true, text: s.verdict, usage: {} } : s.verdict }
  })
  on('prompt.submit', async (_$: any, e: any) => {
    log.prompts.push(e.text)
    return { text: e.text }
  })
  on('agent.spawn', async (_$: any, e: any) => {
    log.spawns.push(e)
    return typeof s.spawn === 'function' ? s.spawn() : s.spawn
  })
  on('ui.toast', async (_$: any, e: any) => {
    log.toasts.push(e.text)
    return { value: undefined }
  })
  host(on, log, s.surfaces, 'cwd' in s ? s.cwd : '/work/proj')
  return { log, s }
}

/** The rest of what the host answers beneath the mod. */
function host(on: any, log?: { closes: any[] }, surfaces: string[] = ['terminal'], cwd = '/work/proj') {
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', async (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('session.cwd', async () => ({ value: cwd }))
  on('session.id', async () => ({ value: 'test-session' }))
  on('session.surfaces', async () => ({ value: surfaces }))
  on('session.version', async () => ({ value: { version: '2.1.292', base: '2.1.292', builtAt: '2026-10-01T00:00:00Z' } }))
  on('command.register', async () => ({ value: undefined }))
  on('ui.close', async (_$: any, e: any) => {
    log?.closes.push(e)
    return { value: undefined }
  })
}

async function boot($: any) {
  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
}

async function mount($: any, surface: (typeof SURFACES)[number], over: Record<string, unknown> = {}) {
  return $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    requestId: PANE,
    props: { title: 'Eklavya', isFocused: true, bodyColumns: 60, placement: 'dock', ...over } as any,
    viewport: { columns: 160, rows: 40 } as any,
  })
}

const press = ($: any, key: string, surface = 'terminal') => $.ui.press({ plugin: PLUGIN, key, surface })
/** How many answer cards are picked: the picked one has the bold border. */
const ticks = async (pane: any) => (JSON.stringify(await pane.drawn()).match(/"borderStyle":"bold"/g) ?? []).length
const answers = (log: any) => log.calls.filter((c: any) => c.tool === 'panel_answer')

const CARD = { fact: 'The Origin header names the page that sent the request.', details: 'A browser sets it and a page cannot change it.' }

describe('the Did You Know card', () => {
  for (const surface of SURFACES) {
    test(`opens on the card, hides the question, and "I knew this" asks it, on ${surface}`, async ($, on) => {
      const w = world(on, { waiting: { ...QUESTION, card: CARD }, surfaces: [surface] })
      await boot($)
      const pane = await mount($, surface)
      await $.session.start({ cwd: '/work/proj', surface, isInteractive: true })
      expect(await pane.find({ text: STR.dyk })).toBeDefined()
      expect(await pane.find({ text: CARD.fact })).toBeDefined()
      expect(await pane.find({ text: QUESTION.stem })).toBeUndefined()
      await press($, 'knew', surface)
      expect(await pane.find({ text: QUESTION.stem })).toBeDefined()
      expect(await pane.find({ text: STR.dyk })).toBeUndefined()
      // Asking the question is not an answer.
      expect(answers(w.log)).toHaveLength(0)
    })
  }

  test('"I want to learn more" shows the details, and "Got it" then asks the question', async ($, on) => {
    world(on, { waiting: { ...QUESTION, card: CARD } })
    await boot($)
    const pane = await mount($, 'terminal')
    await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
    expect(await pane.find({ text: CARD.details })).toBeUndefined()
    await press($, 'learn')
    expect(await pane.find({ text: CARD.details })).toBeDefined()
    expect(await pane.find({ text: STR.gotIt })).toBeDefined()
    expect(await pane.find({ key: 'knew' })).toBeUndefined()
    await press($, 'learn')
    expect(await pane.find({ text: QUESTION.stem })).toBeDefined()
  })

  test('a heartbeat while the card is up keeps the card, and a question without one opens on the question', async ($, on) => {
    const w = world(on, { waiting: { ...QUESTION, card: CARD } })
    await boot($)
    const pane = await mount($, 'terminal')
    await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
    await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
    expect(await pane.find({ text: CARD.fact })).toBeDefined()
    w.s.waiting = { ...QUESTION, question_id: 'q2' }
    await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
    expect(await pane.find({ text: QUESTION.stem })).toBeDefined()
  })

  test('the question going away closes the card too', async ($, on) => {
    const w = world(on, { waiting: { ...QUESTION, card: CARD } })
    await boot($)
    const pane = await mount($, 'terminal')
    await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
    w.s.waiting = null
    await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
    expect(await pane.find({ text: STR.empty })).toBeDefined()
  })
})

describe('the pane, state by state', () => {
  for (const surface of NATIVE) {
    test(`shows nothing waiting, then the question, on ${surface}`, async ($, on) => {
      const w = world(on, { waiting: null })
      await boot($)
      let pane = await mount($, surface)
      expect(await pane.find({ text: STR.empty })).toBeDefined()
      expect(await pane.find({ text: WORDMARK })).toBeDefined()
      expect(JSON.stringify(await pane.drawn())).not.toContain('Powered by')
      expect(w.log.opens).toHaveLength(0)

      w.s.waiting = QUESTION
      await $.session.start({ cwd: '/work/proj', surface, isInteractive: true })
      expect(await pane.find({ text: topicLabel(QUESTION) })).toBeDefined()
      expect(await pane.find({ text: QUESTION.stem })).toBeDefined()
      for (const o of QUESTION.options) {
        expect(await pane.find({ text: new RegExp(o.label) })).toBeDefined()
        expect(await pane.find({ text: o.note })).toBeDefined()
      }
      expect(await pane.find({ text: STR.other })).toBeDefined()
      expect(await pane.find({ key: 'submit' })).toBeDefined()
      expect(await pane.find({ key: 'skip' })).toBeDefined()
      // Opened unasked, Escape returning the keys, and never taking focus.
      expect(w.log.opens[0]).toMatchObject({ id: PANE, closeOnEscape: true })
      expect(w.log.opens[0].focus).toBeUndefined()
      // The right answer is nowhere in what was drawn.
      expect(JSON.stringify(await pane.drawn())).not.toMatch(/correct_id|grades/)
    })
  }

  test('draws the question as Markdown, each option as a card, and the mark beside the name', async ($, on) => {
    world(on)
    await boot($)
    const drawn = JSON.stringify(await (await mount($, 'terminal')).drawn())
    expect(drawn).toContain('Markdown')
    expect(drawn).toContain('card-o1')
    expect(drawn).toContain('card-other')
    expect(drawn.indexOf('logo-0')).toBeLessThan(drawn.indexOf(WORDMARK))
  })

  for (const surface of ['desktop', 'vscode'] as const) {
    test(`${surface} draws the mascot's own neutral face as the mark, not the block grid`, async ($, on) => {
      world(on)
      await boot($)
      const drawn = JSON.stringify(await (await mount($, surface)).drawn())
      expect(drawn).not.toMatch(/[▘▝▀▖▌▞▛▗▚▐▜▄▙▟█]/)
      expect(drawn).not.toContain('logo-0')
      expect(drawn).toContain(JSON.stringify(STR.mascotAlt))
      expect(drawn).toContain(JSON.stringify(MASCOT_FACE).slice(1, 200))
      expect(drawn.indexOf('"type":"Svg"')).toBeLessThan(drawn.indexOf(WORDMARK))
    })
  }

  test('the terminal keeps the block-character mark and draws no Svg', async ($, on) => {
    world(on)
    await boot($)
    const drawn = JSON.stringify(await (await mount($, 'terminal')).drawn())
    expect(drawn).toContain('logo-0')
    expect(drawn).not.toContain('"type":"Svg"')
  })

  test('selecting an option is a draft: it never submits, grades or skips', async ($, on) => {
    const w = world(on)
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-o2')
    await press($, 'opt-o3')
    expect(await ticks(pane)).toBe(1)
    expect(await pane.find({ key: 'opt-o3' })).toBeDefined()
    expect(answers(w.log)).toHaveLength(0)
  })

  for (const surface of NATIVE) {
    test(`the picked answer, and only it, gets a thick brand border, a filled background and bold text on ${surface}`, async ($, on) => {
      world(on)
      await boot($)
      const pane = await mount($, surface)
      const card = async (id: string) => JSON.stringify(await pane.find({ key: `card-${id}` }))
      for (const id of ['o1', 'o2', 'o3', 'o4', 'other']) {
        expect(await card(id)).toContain('"borderStyle":"single"')
        expect(await card(id)).not.toContain('"bold":true')
        expect(await card(id)).not.toContain('backgroundColor')
      }
      await press($, 'opt-o3', surface)
      expect(await card('o3')).toContain('"borderStyle":"bold"')
      expect(await card('o3')).toContain('"borderColor":"#79D5C4"')
      // The whole card, border to border, is filled: the highlight is on the Box, not on the text.
      expect(await card('o3')).toContain(`"backgroundColor":"${PICKED.bg}"`)
      expect(await card('o3')).toContain('"bold":true')
      for (const id of ['o1', 'o2', 'o4', 'other']) expect(await card(id)).toContain('"borderStyle":"single"')
      // Other takes the pick over, with the same marks.
      await press($, 'opt-other', surface)
      expect(await card('o3')).toContain('"borderStyle":"single"')
      expect(await card('o3')).not.toContain('backgroundColor')
      expect(await card('other')).toContain('"borderStyle":"bold"')
      // ...but not the fill: the typed answer sits inside it, in the host's text colour.
      expect(await card('other')).not.toContain('backgroundColor')
    })

    test(`the terminal's note is inside the answer button and the desktop's is a line under it, on ${surface}`, async ($, on) => {
      world(on)
      await boot($)
      const pane = await mount($, surface)
      const button = JSON.stringify(await pane.find({ key: 'opt-o2' }))
      expect(button).toContain(QUESTION.options[1].label)
      if (surface === 'terminal') expect(button).toContain(QUESTION.options[1].note)
      else {
        // The desktop app draws only a Button's label, so its note is a Text under the button, inside the card.
        expect(button).not.toContain(QUESTION.options[1].note)
        expect(await pane.find({ text: QUESTION.options[1].note })).toBeDefined()
      }
      // The note is no longer a Markdown block beside the button: only the question is Markdown.
      const drawn = JSON.stringify(await pane.drawn())
      expect((drawn.match(/"type":"Markdown"/g) ?? []).length).toBe(1)
      expect(await ticks(pane)).toBe(0)
    })

    test(`a note is dim, turns light on the picked card and sits in the card beside the button, not in it, only on the desktop (${surface})`, async ($, on) => {
      world(on)
      await boot($)
      const pane = await mount($, surface)
      const card = async (id: string) => JSON.stringify(await pane.find({ key: `card-${id}` }))
      const sibling = (c: string, note: string) => c.includes(`"children":["${note}"]`)
      expect(sibling(await card('o2'), 'note two')).toBe(surface !== 'terminal')
      if (surface === 'terminal') return
      expect(await card('o2')).toContain('"dimColor":true')
      await press($, 'opt-o2', surface)
      expect(await card('o2')).toContain(`"color":"${PICKED.note}"`)
      expect(await card('o2')).toContain('"dimColor":false')
      // The other cards keep their dim note, and Other never gets one.
      expect(await card('o1')).toContain('"dimColor":true')
      expect(await card('other')).not.toContain('"dimColor":true')
    })

    test(`an option without a note draws no note line on ${surface}`, async ($, on) => {
      world(on, { waiting: { ...QUESTION, options: QUESTION.options.map((o, i) => (i === 1 ? { id: o.id, label: o.label } : o)) } })
      await boot($)
      const pane = await mount($, surface)
      const card = JSON.stringify(await pane.find({ key: 'card-o2' }))
      expect(card).toContain(QUESTION.options[1].label)
      expect(card).not.toContain('"type":"Text","props":{"wrap":"wrap","dimColor"')
      expect(JSON.stringify(await pane.find({ key: 'card-o1' }))).toContain('note one')
    })
  }

  test('a refused move of the focus mark leaves the pick standing', async ($, on) => {
    // The test host holds no keyboard, so $.ui.focus is refused here, as it is in a real pane the learner has not focused.
    world(on)
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-o2')
    await press($, 'opt-o3')
    expect(await ticks(pane)).toBe(1)
    expect(await pane.find({ key: 'opt-o3' })).toBeDefined()
  })

  test('the key legend and the focus hint are drawn on the terminal', async ($, on) => {
    world(on)
    await boot($)
    const drawn = JSON.stringify(await (await mount($, 'terminal')).drawn())
    expect(drawn).toContain(STR.keys)
    expect(drawn).toContain(STR.focus)
  })

  test('the desktop draws no keys: no hint lines and no hotkeys, since its keys never reach the pane', async ($, on) => {
    world(on)
    await boot($)
    const drawn = JSON.stringify(await (await mount($, 'desktop')).drawn())
    expect(drawn).not.toContain('"hotkey"')
    expect(drawn).not.toContain(STR.keys)
    expect(drawn).not.toContain(STR.focus)
    expect(drawn).not.toContain('Ctrl+X')
    expect(drawn).not.toContain('Esc back')
  })

  test('hintLines gives the terminal both lines and every other surface none', () => {
    expect(hintLines('terminal')).toEqual([STR.focus, STR.keys])
    for (const surface of ['desktop', 'vscode', 'mobile']) expect(hintLines(surface)).toEqual([])
  })

  for (const [attached, reported] of [[['desktop'], 'desktop'], [['terminal', 'desktop'], 'terminal'], [[], 'terminal']] as const) {
    test(`the mod reports ${reported} to the server when ${attached.length ? attached.join(' and ') : 'no surface'} is attached`, async ($, on) => {
      const w = world(on, { waiting: null, surfaces: [...attached] })
      await boot($)
      expect(w.log.calls.find(c => c.tool === 'panel_sync')?.args.host.surface).toBe(reported)
    })
  }

  test('submit does nothing until there is a draft, then sends one answer, once', async ($, on) => {
    const w = world(on)
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'submit')
    expect(answers(w.log)).toHaveLength(0)
    await press($, 'opt-o3')
    await Promise.all([press($, 'submit'), press($, 'submit')])
    expect(answers(w.log)).toHaveLength(1)
    expect(answers(w.log)[0].args).toMatchObject({ question_id: 'q1', repo: '/work/proj', kind: 'choice', option_id: 'o3' })
    // The session's identity now, never the one the question came from.
    expect(answers(w.log)[0].args.session_id).toBe('test-session')
    expect(await pane.find({ text: STR.correct })).toBeDefined()
    expect(await pane.find({ text: 'The Origin cannot be forged.' })).toBeDefined()
    expect(await pane.find({ text: STR.wrong })).toBeUndefined()
  })

  test('a miss says so in words and names the right option', async ($, on) => {
    world(on)
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-o1')
    await press($, 'submit')
    expect(await pane.find({ text: STR.wrong })).toBeDefined()
    expect(await pane.find({ text: 'The answer was: The origin is compared' })).toBeDefined()
  })

  test('skip is its own control and records a decline', async ($, on) => {
    const w = world(on, { answer: () => ({ phase: 'skipped', attempt_id: 8 }) })
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'skip')
    expect(answers(w.log)[0].args).toMatchObject({ kind: 'skip' })
    expect(await pane.find({ text: STR.skipped })).toBeDefined()
    expect(await pane.find({ key: 'done' })).toBeDefined()
  })

  test('Teach me records dont_know, drops the miss styling and says an explainer is coming', async ($, on) => {
    const w = world(on, {
      answer: () => ({
        phase: 'answered', attempt_id: 9, taught: true, correct: false, correct_label: 'The origin is compared',
        explanation: 'Because.', explain: { instruction: 'go', attempt_id: 9 },
      }),
    })
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'teach')
    expect(answers(w.log)[0].args).toMatchObject({ kind: 'dont_know' })
    expect(await pane.find({ text: STR.taught })).toBeDefined()
    expect(JSON.stringify(await pane.drawn())).toMatch(new RegExp(`"color":"${BRAND}"[^}]*\\},"children":\\["New to you`))
    expect(await pane.find({ text: STR.wrong })).toBeUndefined()
    expect(await pane.find({ text: STR.taughtExplainer })).toBeDefined()
  })

  test('Teach me starts the explainer once, telling it the learner gave no answer, even with a draft picked', async ($, on) => {
    const taught = {
      phase: 'answered', attempt_id: 9, taught: true, correct: false, correct_label: 'The origin is compared',
      explain: {
        instruction: 'Start the eklavya-explainer agent.', attempt_id: 9, concept: 'cors', name: 'CORS',
        question: 'Why?', options: ['A one', 'The origin is compared'], option_notes: ['n1', 'n2'],
        answer: null, correct: 'The origin is compared',
      },
    }
    const w = world(on, { answer: () => taught })
    await boot($)
    await mount($, 'terminal')
    await press($, 'opt-o1')
    await press($, 'teach')
    expect(answers(w.log)).toHaveLength(1)
    expect(answers(w.log)[0].args).toMatchObject({ kind: 'dont_know' })
    expect(answers(w.log)[0].args.option_id).toBeUndefined()
    expect(w.log.prompts).toEqual([])
    expect(w.log.spawns).toHaveLength(1)
    expect(w.log.spawns[0].prompt).toContain('pressed Teach me')
    expect(w.log.spawns[0].prompt).not.toContain('The learner answered')
    expect(w.log.spawns[0].prompt).toContain('The right answer: The origin is compared')
  })

  test('Teach me that cannot reach the server keeps its kind and Retry resends it', async ($, on) => {
    let first = true
    const w = world(on, {
      answer: () => {
        if (first) {
          first = false
          throw new Error('connection reset')
        }
        return { phase: 'answered', attempt_id: 9, taught: true, correct: false, correct_label: 'The origin is compared' }
      },
    })
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'teach')
    expect(await pane.find({ text: STR.unreachable })).toBeDefined()
    await press($, 'retry')
    expect(answers(w.log).map((a: any) => a.args.kind)).toEqual(['dont_know', 'dont_know'])
    expect(await pane.find({ text: STR.taught })).toBeDefined()
  })

  test('typing in Other never skips and never submits', async ($, on) => {
    const w = world(on)
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-other')
    await $.ui.input({ plugin: PLUGIN, key: 'other-text', text: 'skip', kind: 'change' })
    await $.ui.input({ plugin: PLUGIN, key: 'other-text', text: 'skip it please', kind: 'submit' })
    expect(answers(w.log)).toHaveLength(0)
    expect(await pane.find({ key: 'other-text' })).toBeDefined()
  })

  test('Enter in Other keeps the typed text even when the host sends an empty submit', async ($, on) => {
    const w = world(on)
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-other')
    await $.ui.input({ plugin: PLUGIN, key: 'other-text', text: "Don't know", kind: 'change' })
    await $.ui.input({ plugin: PLUGIN, key: 'other-text', text: '', kind: 'submit' })
    expect(answers(w.log)).toHaveLength(0)
    expect(await pane.find({ key: 'other-text' })).toBeDefined()
    expect(JSON.stringify(await pane.find({ key: 'other-text' }))).toContain("Don't know")
  })

  test('a typed answer is graded once by the mod and recorded with the grader\'s verdict', async ($, on) => {
    const w = world(on)
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-other')
    await $.ui.input({ plugin: PLUGIN, key: 'other-text', text: 'It proves the request came from our own page.', kind: 'change' })
    await press($, 'submit')
    const sent = answers(w.log).map((c: any) => c.args)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({ kind: 'text', text: 'It proves the request came from our own page.' })
    expect(sent[0].grade).toBeUndefined()
    expect(sent[1]).toMatchObject({ kind: 'text', grade: 5, outcome: 'answered', feedback: 'Right, and you said why.' })
    expect(w.log.graded).toHaveLength(1)
    expect(w.log.graded[0]).toContain('The right answer: The origin is compared')
  })

  test('a grader that refuses records nothing, keeps the words and offers Retry', async ($, on) => {
    const w = world(on, { verdict: { isAnswered: false, reason: 'empty-reply', usage: {} } })
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-other')
    await $.ui.input({ plugin: PLUGIN, key: 'other-text', text: 'my own words', kind: 'change' })
    await press($, 'submit')
    expect(answers(w.log)).toHaveLength(1) // only the "right option please" half
    expect(await pane.find({ text: STR.graderFailed })).toBeDefined()
    expect(await pane.find({ key: 'retry' })).toBeDefined()
    expect(await pane.find({ key: 'other-text' })).toBeDefined()
    // One manual Retry grades again and records.
    w.s.verdict = '{"grade":3,"outcome":"answered","feedback":"Mostly."}'
    await press($, 'retry')
    expect(answers(w.log).at(-1).args).toMatchObject({ grade: 3, outcome: 'answered' })
  })

  test('an unusable verdict is the same: nothing recorded', async ($, on) => {
    const w = world(on, { verdict: '{"grade":9,"outcome":"answered","feedback":"x"}' })
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-other')
    await $.ui.input({ plugin: PLUGIN, key: 'other-text', text: 'words', kind: 'change' })
    await press($, 'submit')
    expect(answers(w.log).filter((c: any) => c.args.grade !== undefined)).toHaveLength(0)
  })

  test('an empty Other asks for words and sends nothing', async ($, on) => {
    const w = world(on)
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-other')
    await press($, 'submit')
    expect(answers(w.log)).toHaveLength(0)
    expect(await pane.find({ text: STR.nothingTyped })).toBeDefined()
  })

  test('a lost reply keeps the draft, and Retry resends the same answer for the server to settle', async ($, on) => {
    let first = true
    const w = world(on, {
      answer: () => {
        if (first) {
          first = false
          throw new Error('connection reset')
        }
        return { phase: 'answered', attempt_id: 7, correct: true, explanation: 'Stored.' }
      },
    })
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-o3')
    await press($, 'submit')
    expect(await pane.find({ text: STR.unreachable })).toBeDefined()
    expect(await ticks(pane)).toBe(1)
    await press($, 'retry')
    expect(await pane.find({ text: STR.correct })).toBeDefined()
    expect(answers(w.log).map((c: any) => c.args.option_id)).toEqual(['o3', 'o3'])
  })

  test('an answer after /clear is refused as another session\'s, and the draft is dropped', async ($, on) => {
    const w = world(on, {})
    w.s.answer = () => {
      w.s.waiting = null
      return { error: 'stale_question' }
    }
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-o3')
    await press($, 'submit')
    expect(await pane.find({ text: STR.stale })).toBeDefined()
    expect(await pane.find({ key: 'submit' })).toBeUndefined()
  })

  test('Next appears only for a round, and asks the model for the next question', async ($, on) => {
    const w = world(on, { waiting: { ...QUESTION, more: true } })
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-o3')
    await press($, 'submit')
    expect(await pane.find({ key: 'next' })).toBeDefined()
    expect(await pane.find({ key: 'done' })).toBeDefined()
    w.s.waiting = null
    await press($, 'next')
    expect(w.log.prompts).toHaveLength(1)
    expect(w.log.prompts[0]).toMatch(/resume_round: true/)
    expect(await pane.find({ text: STR.loading })).toBeDefined()
  })

  test('a single question has no Next, and Done leaves the empty pane', async ($, on) => {
    const w = world(on)
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-o3')
    await press($, 'submit')
    expect(await pane.find({ key: 'next' })).toBeUndefined()
    w.s.waiting = null
    await press($, 'done')
    expect(await pane.find({ text: STR.empty })).toBeDefined()
  })

  test('a finished single question closes itself after 15 seconds; a round with Next does not', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on)
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-o3')
    await press($, 'submit')
    expect(await pane.find({ text: STR.autoClose })).toBeDefined()
    w.s.waiting = null
    await clock.advance(14_000)
    expect(await pane.find({ text: STR.correct })).toBeDefined()
    await clock.advance(1_500)
    expect(await pane.find({ text: STR.empty })).toBeDefined()
  })

  test('a skipped question closes itself too', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, { answer: () => ({ phase: 'skipped' }) })
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'skip')
    expect(await pane.find({ text: STR.skipped })).toBeDefined()
    w.s.waiting = null
    await clock.advance(15_500)
    expect(await pane.find({ text: STR.empty })).toBeDefined()
  })

  test('Done cancels the timer: it closes nothing a second time', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on)
    await boot($)
    await mount($, 'terminal')
    await press($, 'opt-o3')
    await press($, 'submit')
    w.s.waiting = null
    await press($, 'done')
    const closed = w.log.closes.length
    await clock.advance(20_000)
    expect(w.log.closes).toHaveLength(closed)
  })

  test('a session end cancels the timer', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on)
    await boot($)
    await mount($, 'terminal')
    await press($, 'opt-o3')
    await press($, 'submit')
    await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } } as any)
    const closed = w.log.closes.length
    await clock.advance(20_000)
    expect(w.log.closes).toHaveLength(closed)
  })

  test('a result with Next waiting stays until the learner decides', async ($, on) => {
    const clock = mock.clock(on)
    world(on, { waiting: { ...QUESTION, more: true } })
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-o3')
    await press($, 'submit')
    expect(await pane.find({ text: STR.autoClose })).toBeUndefined()
    await clock.advance(60_000)
    expect(await pane.find({ text: STR.correct })).toBeDefined()
  })

  const MISS = {
    phase: 'answered', attempt_id: 9, correct: false, correct_label: 'The origin is compared', explanation: 'x',
    explain: {
      instruction: 'Start the eklavya-explainer agent.', attempt_id: 9, concept: 'cors', name: 'CORS',
      question: 'Why?', options: ['A one', 'The origin is compared'], option_notes: ['n1', 'n2'],
      answer: 'A one', correct: 'The origin is compared',
    },
  }

  test('a miss starts the explainer itself, once, with the pick and the right answer', async ($, on) => {
    const w = world(on, { answer: () => MISS })
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-o1')
    await press($, 'submit')
    expect(w.log.prompts).toEqual([])
    expect(w.log.spawns).toHaveLength(1)
    expect(w.log.spawns[0].subagent_type).toBe(EXPLAINER)
    expect(w.log.spawns[0].prompt).toContain('The learner answered: A one')
    expect(w.log.spawns[0].prompt).toContain('The right answer: The origin is compared')
    expect(w.log.spawns[0].prompt).toContain('B. The origin is compared (note: n2)')
    expect(w.log.spawns[0].prompt).toContain('--attempt 9')
    expect(await pane.find({ text: STR.explainer })).toBeDefined()
  })

  test('a refused spawn falls back to the queued prompt', async ($, on) => {
    const w = world(on, { answer: () => MISS, spawn: { deny: 'no' } })
    await boot($)
    await mount($, 'terminal')
    await press($, 'opt-o1')
    await press($, 'submit')
    expect(w.log.spawns).toHaveLength(2)
    expect(w.log.prompts).toEqual(['Start the eklavya-explainer agent.'])
  })

  test('a spawn refused once is asked again and needs no prompt', async ($, on) => {
    let refused = false
    const spawn = () => (refused ? { model: 'm', agentId: 'a1' } : ((refused = true), { deny: 'Classifier unavailable' }))
    const w = world(on, { answer: () => MISS, spawn })
    await boot($)
    await mount($, 'terminal')
    await press($, 'opt-o1')
    await press($, 'submit')
    expect(w.log.spawns).toHaveLength(2)
    expect(w.log.prompts).toEqual([])
  })

  test('a spawn that throws is asked again, and two throws fall back to the prompt', async ($, on) => {
    let calls = 0
    const spawn = () => {
      calls += 1
      throw new Error('host failed')
    }
    const w = world(on, { answer: () => MISS, spawn })
    await boot($)
    await mount($, 'terminal')
    await press($, 'opt-o1')
    await press($, 'submit')
    expect(calls).toBe(2)
    expect(w.log.prompts).toEqual(['Start the eklavya-explainer agent.'])
  })

  test("the mod's own prompts show one short line; other rows are left alone", async ($, on) => {
    world(on)
    // The engine's own drawing of the row: record the text it is handed.
    const shown: string[] = []
    on('ui.render', async (_$: any, e: any) => {
      shown.push(e.props.text)
      const { Text } = _$.ui.resolve(e)
      return (globalThis as any).h(Text, null, e.props.text)
    })
    await boot($)
    let n = 0
    const row = (text: string, origin: any, isExpanded = false) =>
      $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'UserMessage', requestId: `m${n++}`, props: { text, origin, isExpanded } as any })
    const ours = { kind: 'plugin', name: PLUGIN }
    await row(MISS.explain.instruction, ours)
    // A body short enough to sit under the speaker label is drawn expanded: still one line.
    await row(MISS.explain.instruction, ours, true)
    await row(NEXT_PROMPT, ours)
    await row('Something new the mod may say one day.', ours)
    await row('my own prompt', { kind: 'user' })
    await row('hello', { kind: 'plugin', name: 'other' })
    expect(shown).toEqual([STR.askedExplainer, STR.askedExplainer, STR.askedNext, STR.askedOther, 'my own prompt', 'hello'])
  })

  test('the brief says when the learner typed instead of picking', () => {
    const brief = explainerBrief({ ...MISS.explain, answer: 'my own words' })
    expect(brief).toContain('The learner typed their own answer instead of picking: my own words')
    expect(explainerBrief(MISS.explain)).toContain('The learner answered: A one')
  })

  test('says "You\'ve cleared" on a level-up', async ($, on) => {
    world(on, { answer: () => ({ phase: 'answered', attempt_id: 3, correct: true, explanation: 'ok', level_up: { from: 'easy', to: 'medium' } }) })
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-o3')
    await press($, 'submit')
    expect(await pane.find({ text: "You've cleared easy on proj." })).toBeDefined()
  })
})

describe('the greeting for a host without the SessionStart banner', () => {
  const GREETING = 'Eklavya active · v1.83.0 · memory on · questions on'

  test('toasts what the server sends, once, however many syncs follow', async ($, on) => {
    const w = world(on, { waiting: { ...QUESTION, greeting: GREETING } })
    await boot($)
    await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
    expect(w.log.toasts.filter((t) => t === GREETING)).toHaveLength(1)
  })

  test('toasts nothing when the server sends no greeting', async ($, on) => {
    const w = world(on, { waiting: { none: true } })
    await boot($)
    expect(w.log.toasts).toEqual([])
  })

  test('still toasts with the panel off, and when nothing waits', async ($, on) => {
    const off = world(on, { waiting: { disabled: true, greeting: GREETING } })
    await boot($)
    expect(off.log.toasts).toEqual([GREETING])
  })

  test('greets again in the next session after a clear', async ($, on) => {
    const w = world(on, { waiting: { none: true, greeting: GREETING } })
    await boot($)
    await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } } as any)
    await boot($)
    expect(w.log.toasts.filter((t) => t === GREETING)).toHaveLength(2)
  })
})

describe('placement and lifecycle', () => {
  test('a pane the host cannot seat is reported, and the learner told how to open it', async ($, on) => {
    const w = world(on, { placed: false })
    await boot($)
    const reports = w.log.calls.filter((c) => c.tool === 'panel_sync' && c.args.placed)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.args.placed).toMatchObject({ question_id: 'q1', ok: false })
    expect(w.log.toasts).toContain(unplacedNotice())
  })

  test('a seated pane is reported ok, once per question', async ($, on) => {
    const w = world(on)
    await boot($)
    await boot($)
    const reports = w.log.calls.filter((c) => c.tool === 'panel_sync' && c.args.placed)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.args.placed.ok).toBe(true)
  })

  test('a session opened without a folder still reports in, with an empty directory', async ($, on) => {
    const w = world(on, { cwd: '' })
    await boot($)
    expect(w.log.calls.find(c => c.tool === 'panel_sync')?.args.cwd).toBe('')
  })

  test('the reopen command seats the pane and restores the question', async ($, on) => {
    const w = world(on)
    await boot($)
    const out = await $.command.run({ command: 'eklavya-panel', args: '' } as any)
    expect((out as any).text).toMatch(/opened/)
    expect(w.log.opens.length).toBeGreaterThan(1)
  })

  test('the reopen command with nothing waiting still opens the pane, and with the setting off opens nothing', async ($, on) => {
    const w = world(on, { waiting: null })
    await boot($)
    const out = await $.command.run({ command: 'eklavya-panel', args: '' } as any)
    expect((out as any).text).toMatch(/opened/)
    expect(w.log.opens).toHaveLength(1)
    w.s.waiting = { disabled: true }
    const off = await $.command.run({ command: 'eklavya-panel', args: '' } as any)
    expect((off as any).text).toBe(STR.off)
    expect(w.log.opens).toHaveLength(1)
  })

  test('with the setting off the server says disabled and the mod draws and opens nothing', async ($, on) => {
    const w = world(on, { waiting: { disabled: true } })
    await boot($)
    const pane = await mount($, 'terminal')
    expect(w.log.opens).toHaveLength(0)
    expect(await pane.find({ text: STR.empty })).toBeDefined()
  })

  test('the first refusal from the host\'s classifier is asked again once, as it says', async ($, on) => {
    let refused = true
    const calls: string[] = []
    on('mcp.call', async (_$: any, e: any) => {
      calls.push(e.tool)
      if (refused) {
        refused = false
        return { deny: 'The server-side auto mode classifier gave no verdict for x. Issue the action again once, as-is' }
      }
      return { value: reply({ none: true }) }
    })
    host(on)
    await boot($)
    expect(calls).toEqual(['panel_sync', 'panel_sync'])
  })

  test('tries the other server spellings when the first is not connected', async ($, on) => {
    const servers: string[] = []
    on('mcp.call', async (_$: any, e: any) => {
      servers.push(e.server)
      if (e.server !== 'eklavya') return { deny: 'no connected MCP tool "panel_sync" on a server named "x"' }
      return { value: reply({ none: true }) }
    })
    host(on)
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    await boot($)
    expect(servers).toEqual(['plugin:eklavya:eklavya', 'plugin_eklavya_eklavya', 'eklavya'])
  })

  test('does nothing, and nothing throws, when no Eklavya server is connected', async ($, on) => {
    on('mcp.call', async () => ({ deny: 'no connected MCP tool "panel_sync"' }))
    host(on)
    await boot($)
    const pane = await mount($, 'terminal')
    expect(await pane.find({ text: STR.empty })).toBeDefined()
  })

  test('only its own pane is drawn: another pane is left to the host', async ($, on) => {
    world(on)
    await boot($)
    let found: unknown
    try {
      const other = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'someone-elses-pane', props: { title: 'x', isFocused: false, bodyColumns: 40, placement: 'dock' } as any })
      found = await other.find({ text: WORDMARK })
    } catch {
      found = undefined
    }
    expect(found).toBeUndefined()
  })

  test('a heartbeat that failed because the server was still starting is retried by the next event, before the tool runs', async ($, on) => {
    let up = false
    const seen: string[] = []
    on('mcp.call', async (_$: any, e: any) => {
      seen.push(e.tool)
      return up ? { value: reply({ none: true }) } : { deny: 'no connected MCP tool "panel_sync"' }
    })
    on('tool.call', async () => {
      seen.push('TOOL')
      return { result: '{}' } as any
    })
    host(on)
    await boot($)
    expect(seen).toEqual(['panel_sync', 'panel_sync', 'panel_sync']) // each server spelling tried, none connected
    seen.length = 0
    up = true
    await $.tool.call({ tool: 'Read', tool_input: { file_path: '/x' } } as any)
    // Heartbeat first, then the tool, and no 30 s wait was imposed by the failed attempt.
    expect(seen).toEqual(['panel_sync', 'TOOL'])
    await $.tool.call({ tool: 'Read', tool_input: { file_path: '/y' } } as any)
    expect(seen).toEqual(['panel_sync', 'TOOL', 'TOOL'])
  })

  test('the model\'s present_question call brings the question to the pane, and the mod\'s own calls do not loop', async ($, on) => {
    const w = world(on, { waiting: null })
    on('tool.call', async () => ({ result: '{}' }) as any)
    await boot($)
    expect(w.log.opens).toHaveLength(0)
    w.s.waiting = QUESTION
    await $.tool.call({ tool: 'mcp__plugin_eklavya_eklavya__present_question', tool_input: {} } as any)
    expect(w.log.opens).toHaveLength(1)
    const before = w.log.calls.length
    await $.tool.call({ tool: 'mcp__plugin_eklavya_eklavya__panel_sync', tool_input: {} } as any)
    expect(w.log.calls.length).toBe(before)
  })

  test('a sync that finds nothing while an answer is in flight keeps the answer, so a lost reply can still be retried', async ($, on) => {
    let first = true
    const w = world(on)
    w.s.answer = async () => {
      if (!first) return { phase: 'answered', attempt_id: 7, correct: true, explanation: 'Stored.' }
      first = false
      // The row is closed by the commit; a sync lands before the reply does, then the reply is lost.
      w.s.waiting = null
      await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
      throw new Error('connection reset')
    }
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-o3')
    await press($, 'submit')
    expect(await pane.find({ text: STR.unreachable })).toBeDefined()
    expect(await pane.find({ key: 'retry' })).toBeDefined()
    await press($, 'retry')
    expect(await pane.find({ text: STR.correct })).toBeDefined()
  })

  test('a session that ends while a typed answer is being graded records nothing for it', async ($, on) => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => (release = r))
    const w = world(on, { verdict: async () => (await gate, { isAnswered: true, text: '{"grade":5,"outcome":"answered","feedback":"Right."}', usage: {} }) })
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-other')
    await $.ui.input({ plugin: PLUGIN, key: 'other-text', text: 'my words', kind: 'change' })
    const pressed = press($, 'submit')
    // The grader is running: the session ends under it.
    for (let i = 0; i < 50 && w.log.graded.length === 0; i += 1) await new Promise(r => setTimeout(r, 5))
    expect(w.log.graded).toHaveLength(1)
    await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } } as any)
    release()
    await pressed
    expect(answers(w.log).filter((c: any) => c.args.grade !== undefined)).toHaveLength(0)
    expect(await pane.find({ text: STR.empty })).toBeDefined()
  })

  test('a session ending clears the draft; a waiting question comes back on the next sync', async ($, on) => {
    world(on)
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-o2')
    await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } } as any)
    expect(await pane.find({ text: STR.empty })).toBeDefined()
    await boot($)
    expect(await ticks(pane)).toBe(0)
  })
})

describe('code in the text', () => {
  test('calls and camelCase or snake_case names are marked as code, and marked code is left alone', () => {
    expect(codify('begins with tester.pumpWidget(widget). What next?')).toBe('begins with `tester.pumpWidget(widget)`. What next?')
    expect(codify('calls tester.tap(find.byType(ElevatedButton)) now')).toBe('calls `tester.tap(find.byType(ElevatedButton))` now')
    expect(codify('setState and record_attempt and pumpAndSettle')).toBe('`setState` and `record_attempt` and `pumpAndSettle`')
    expect(codify('already `shouldRepaint(old)` marked')).toBe('already `shouldRepaint(old)` marked')
  })

  test('brand names and plain prose are not marked', () => {
    for (const s of ['JavaScript on GitHub and iPhone', 'true of pump with a duration', 'e.g. foo (bar) plain']) expect(codify(s)).toBe(s)
  })

  test('a button label drops code and bold marks and keeps underscores', () => {
    expect(plainLabel('Calls `pump()` **now** my_var')).toBe('Calls pump() now my_var')
  })

  test('the stem and the explanation are drawn marked as code; a note, inside its Button, is plain', async ($, on) => {
    world(on, {
      waiting: { ...QUESTION, stem: 'It begins with tester.pumpWidget(widget). What does it do?', options: [{ id: 'o1', label: 'Mounts it', note: 'true of pumpAndSettle' }, { id: 'o2', label: 'Other', note: 'n' }] },
      answer: () => ({ phase: 'answered', attempt_id: 7, correct: false, correct_label: 'Mounts it', explanation: 'See setState(fn) for why.' }),
    })
    await boot($)
    const pane = await mount($, 'terminal')
    const drawn = JSON.stringify(await pane.drawn())
    expect(drawn).toContain('`tester.pumpWidget(widget)`')
    expect(drawn).toContain('true of pumpAndSettle')
    await press($, 'opt-o2')
    await press($, 'submit')
    expect(JSON.stringify(await pane.drawn())).toContain('`setState(fn)`')
  })
})

describe('the logo', () => {
  const silhouette = (row: string) => [...row].map(c => (c === '.' ? '.' : 'x')).join('')
  const mirror = (row: string) => [...row].reverse().join('')

  test('is six text rows of twelve characters: one square pixel is a character wide and half a row tall', () => {
    const rows = logoRows()
    expect(rows).toHaveLength(LOGO_GRID.length / 2)
    for (const r of rows) expect(r.reduce((n, run) => n + run.text.length, 0)).toBe(LOGO_GRID[0].length)
    expect(LOGO_GRID).toHaveLength(12)
    expect(LOGO_GRID[0]).toHaveLength(12)
  })

  test('the head is symmetric: the same steps and ears on both sides, and the same eyes', () => {
    for (const row of LOGO_GRID) {
      expect(silhouette(row), row).toBe(mirror(silhouette(row)))
      // Ink is only ever the eyes, so it mirrors too.
      const ink = [...row].map(c => (c === 'c' ? 'c' : '.')).join('')
      expect(ink, row).toBe(mirror(ink))
    }
  })

  test('has eyes and no mouth: four ink pixels, two rows of two, and nothing below them', () => {
    const inkRows = LOGO_GRID.map((row, y) => (row.includes('c') ? y : -1)).filter(y => y >= 0)
    expect(inkRows).toHaveLength(2)
    expect(LOGO_GRID.join('').split('c').length - 1).toBe(4)
    expect(inkRows[1]! - inkRows[0]!).toBe(1)
    expect(LOGO_GRID.slice(inkRows[1]! + 1).join('')).not.toContain('c')
  })

  test('every letter has a colour from the mascot identity, and no character needs a third colour', () => {
    for (const ch of new Set(LOGO_GRID.join('').replace(/\./g, ''))) expect(LOGO_PALETTE[ch], ch).toMatch(/^#[0-9A-F]{6}$/)
    // Two stacked pixels per character: a pixel pair holds at most two colours, so nothing is dropped.
    for (let y = 0; y < LOGO_GRID.length; y += 2)
      for (let x = 0; x < LOGO_GRID[0].length; x += 1) expect(new Set([LOGO_GRID[y][x], LOGO_GRID[y + 1][x]].filter(c => c !== '.')).size).toBeLessThanOrEqual(2)
  })

  test('a pixel pair takes its colours as foreground and background, and an empty pair is a blank', () => {
    const pal = { a: '#111111', b: '#222222' }
    // Each pixel is drawn twice across, so one column of two pixels is one character.
    expect(logoRows(['a', 'b'], pal)).toEqual([[{ text: '▀', fg: '#111111', bg: '#222222' }]])
    expect(logoRows(['a', '.'], pal)).toEqual([[{ text: '▀', fg: '#111111', bg: undefined }]])
    expect(logoRows(['.', 'a'], pal)).toEqual([[{ text: '▄', fg: '#111111', bg: undefined }]])
    expect(logoRows(['.', '.'], pal)).toEqual([[{ text: ' ' }]])
    // Runs of one colour pair join into one stretch of text.
    expect(logoRows(['aa', 'bb'], pal)).toEqual([[{ text: '▀▀', fg: '#111111', bg: '#222222' }]])
  })
})

describe('the words and the grader', () => {
  test('the strings are the handoff\'s', () => {
    expect(STR.skipped).toBe("Skipped. We won't ask this one again.")
    expect(STR.stale).toBe('This question belongs to another session and was closed.')
    expect(STR.unreachable).toBe("We couldn't reach Eklavya. Your answer is saved here — Retry.")
    expect(unplacedNotice()).toBe('A question is waiting. /eklavya-panel to open it.')
    expect(topicLabel({ concept_name: 'CSRF', tier: 2 })).toBe('CSRF · T2 mechanism')
    expect(topicLabel({ concept_name: 'X', tier: 9 })).toBe('X · T9')
    expect(projectName('/a/b/eklavya')).toBe('eklavya')
    expect(projectName('*')).toBe('this project')
    expect(projectName('/')).toBe('this project')
  })

  test('a verdict must be well formed or it is discarded', () => {
    expect(parseVerdict('{"grade":4,"outcome":"answered","feedback":"Good."}')).toEqual({ grade: 4, outcome: 'answered', feedback: 'Good.' })
    expect(parseVerdict('Here you go: {"grade":0,"outcome":"dont_know","feedback":"Taught."} thanks')).toEqual({ grade: 0, outcome: 'dont_know', feedback: 'Taught.' })
    for (const bad of [
      '',
      'no json at all',
      '{"grade":',
      '[1,2]',
      'null',
      '{"grade":6,"outcome":"answered","feedback":"x"}',
      '{"grade":-1,"outcome":"answered","feedback":"x"}',
      '{"grade":2.5,"outcome":"answered","feedback":"x"}',
      '{"grade":"4","outcome":"answered","feedback":"x"}',
      '{"grade":3,"outcome":"declined","feedback":"x"}',
      '{"grade":3,"outcome":"dont_know","feedback":"x"}',
      '{"grade":3,"outcome":"answered"}',
      '{"grade":3,"outcome":"answered","feedback":"   "}',
      `{"grade":3,"outcome":"answered","feedback":"${'x'.repeat(1001)}"}`,
    ]) {
      expect(parseVerdict(bad)).toBeNull()
    }
  })

  test('the grader is given the question, the key and the words, and the rubric', () => {
    const req = gradingRequest(QUESTION as any, 'The origin is compared', 'my words')
    expect(req.prompt).toContain(QUESTION.stem)
    expect(req.prompt).toContain('The right answer: The origin is compared')
    expect(req.prompt).toContain('my words')
    expect(req.system).toContain('0 | no answer')
    expect(req.system).toContain('5 | correct, and explained *why*')
  })

  test('a tool reply is its first text block as JSON', () => {
    expect(payloadOf([{ type: 'image' }, { type: 'text', text: '{"a":1}' }])).toEqual({ a: 1 })
    expect(() => payloadOf([])).toThrow()
    expect(EMPTY.step).toBe('none')
  })
})

describe('the logo as boxes', () => {
  test('every row adds up to the grid width and a colour run never repeats', () => {
    for (const r of boxRows()) {
      expect(r.reduce((n, run) => n + run.width, 0)).toBe(LOGO_GRID[0].length)
      r.slice(1).forEach((run, i) => expect(run.color).not.toBe(r[i].color))
    }
  })
})

describe('the desktop layout', () => {
  test('Teach me has its own row under Submit; on the desktop app a column box stretches the Button', async ($, on) => {
    world(on)
    await boot($)
    for (const surface of ['terminal', 'vscode', 'desktop'] as const) {
      const tree = await (await mount($, surface)).drawn()
      const teach = /"key":"teach(-client)?"/
      const rows = tree.children.filter((c: any) => c && c.type === 'Box' && teach.test(JSON.stringify(c)))
      expect(rows).toHaveLength(1)
      expect(JSON.stringify(rows[0])).not.toContain('"key":"submit"')
      const all = tree.children.map((c: any) => JSON.stringify(c ?? null))
      expect(all.findIndex((c: string) => c.includes('"key":"submit"'))).toBeLessThan(all.findIndex((c: string) => teach.test(c)))
      // VS Code keeps the native column box; the desktop app's is a row holding one compact region.
      if (surface === 'vscode') expect(rows[0].props).toMatchObject({ key: 'teach-box', flexDirection: 'column' })
      if (surface === 'desktop') expect(rows[0].props).toMatchObject({ key: 'teach-row', flexDirection: 'row' })
    }
  })

  test('the terminal keeps every hotkey and its hints', async ($, on) => {
    world(on)
    await boot($)
    const d = JSON.stringify(await (await mount($, 'terminal')).drawn())
    for (const k of ['1', '2', '3', '4', 'o', 's', 'k', 't']) expect(d).toContain(`"hotkey":"${k}"`)
    expect(d).toContain(STR.keys)
  })

  test('Teach me is drawn in Claude orange on both surfaces', async ($, on) => {
    world(on)
    await boot($)
    // The logo uses the same orange, so each check names the Teach me element itself.
    const vscode = JSON.stringify(await (await mount($, 'vscode')).drawn())
    expect(vscode).toMatch(new RegExp(`"key":"teach-box"[^}]*"backgroundColor":"${TEACH.bg}"[^}]*"borderColor":"${TEACH.bg}"`))
    const desktop = JSON.stringify(await (await mount($, 'desktop')).drawn())
    expect(desktop).toMatch(new RegExp(`"key":"teach-client"[\\s\\S]*"fill":"${TEACH.bg}","hoverFill":"${TEACH.hover}","text":"${TEACH.text}"`))
    const terminal = JSON.stringify(await (await mount($, 'terminal')).drawn())
    expect(terminal).toContain(`"color":"${TEACH.text}","backgroundColor":"${TEACH.bg}"`)
  })

  test('the header sits beside the topic in a wide pane and stacks above it in a narrow one, on every surface', async ($, on) => {
    world(on)
    await boot($)
    // The header is the first Box that holds the wordmark's column; its direction is the layout.
    const direction = async (surface: (typeof SURFACES)[number], bodyColumns?: number) => {
      const pane = await mount($, surface, { bodyColumns })
      const d = JSON.stringify(await pane.drawn())
      await pane.unmount()
      return d.match(/"flexDirection":"(row|column)","alignItems":"(?:center|flex-start)","gap":2/)?.[1]
    }
    for (const surface of SURFACES) {
      expect(await direction(surface, 120)).toBe('row')
      expect(await direction(surface, 59)).toBe('column')
      expect(await direction(surface, 60)).toBe('row')
      // A host that reports no width keeps the row.
      expect(await direction(surface)).toBe('row')
    }
  })

  test('only the surfaces with room pad the inside of a native answer card', async ($, on) => {
    world(on)
    await boot($)
    const pads = async (surface: 'terminal' | 'vscode') => {
      const d = JSON.stringify(await (await mount($, surface)).drawn())
      return { x: (d.match(/"paddingX":2/g) ?? []).length, y: (d.match(/"paddingY":1/g) ?? []).length }
    }
    const [desktop, terminal] = [await pads('vscode'), await pads('terminal')]
    expect(desktop.x).toBe(QUESTION.options.length + 1)
    expect(desktop.y).toBeGreaterThanOrEqual(QUESTION.options.length + 1)
    expect(terminal.x).toBe(0)
    expect(terminal.y).toBe(0)
  })

  test('a pick never moves the text: no tick on either surface, and the desktop note is its own line under the answer', async ($, on) => {
    world(on)
    await boot($)
    const pane = await mount($, 'vscode')
    await press($, 'opt-o1', 'vscode')
    const d = JSON.stringify(await pane.drawn())
    expect(d).not.toContain('✓')
    const term = await mount($, 'terminal')
    await press($, 'opt-o2')
    expect(await ticks(term)).toBe(1)
    expect(JSON.stringify(await term.drawn())).not.toContain('✓')
    expect(d).toContain(QUESTION.options[0].label)
    expect(d).toContain(JSON.stringify(QUESTION.options[0].note))
    expect(d).toContain('"wrap":"wrap"')
  })

  test('headingParagraphs leaves block Markdown and existing bold alone', () => {
    for (const t of ['```\ncode\n```', '- a\n- b', '# Title', '> quote', '1. step', 'already **bold** here'])
      expect(headingParagraphs(t)).toBe(t)
    expect(headingParagraphs('plain\n\n- list')).toBe('### plain\n\n- list')
    expect(headingParagraphs('')).toBe('')
  })

  test('headingParagraphs makes each paragraph one heading line', () => {
    expect(headingParagraphs('one\ntwo\n\nthree')).toBe('### one two\n\n### three')
  })

  test('only the desktop app sets the question as a heading and spaces the answers', async ($, on) => {
    world(on)
    await boot($)
    const gaps = (d: string) => (d.match(/"gap":2/g) ?? []).length
    const desktop = JSON.stringify(await (await mount($, 'desktop')).drawn())
    const terminal = JSON.stringify(await (await mount($, 'terminal')).drawn())
    expect(desktop).toContain('### ' + QUESTION.stem.slice(0, 10))
    expect(terminal).not.toContain('### ' + QUESTION.stem.slice(0, 10))
    expect(gaps(desktop)).toBe(gaps(terminal) + 1)
    expect(desktop).toContain('"marginTop":1')
    expect(terminal).not.toContain('"marginTop":1')
  })
})

describe('the mock question (/eklavya-panel-demo)', () => {
  /** A whole card is a Client, so its pick shows in its props, not in a border of the tree. */
  const chosenCards = (tree: unknown) => (JSON.stringify(tree).match(/"chosen":true/g) ?? []).length
  const demo = ($: any) => $.command.run({ command: 'eklavya-panel-demo', args: '' } as any)
  const serverCalls = (log: any) => log.calls.filter((c: any) => c.tool === 'panel_sync' || c.tool === 'panel_answer')

  test('opens at once with the mock question and the test bar, with nothing waiting and the panel setting off', async ($, on) => {
    const w = world(on, { waiting: { disabled: true } })
    await boot($)
    const before = serverCalls(w.log).length
    const out = await demo($)
    expect((out as any).text).toBe(STR.demoOpened)
    expect(w.log.opens.at(-1)).toMatchObject({ id: PANE, closeOnEscape: true })
    const drawn = JSON.stringify(await (await mount($, 'desktop')).drawn())
    expect(drawn).toContain(JSON.stringify(STR.demoBanner))
    expect(drawn).toContain(JSON.stringify(STR.demoReady))
    expect(drawn).toContain('card-o3')
    expect(serverCalls(w.log)).toHaveLength(before)
  })

  test('a failed open says so in words', async ($, on) => {
    host(on)
    on('mcp.call', async () => ({ value: reply({ none: true }) }))
    on('ui.open', async () => {
      throw new Error('no host')
    })
    await boot($)
    expect(((await demo($)) as any).text).toBe(STR.demoFailed)
  })

  test('answers are graded here and never sent: right, wrong, typed, skipped and taught', async ($, on) => {
    const w = world(on, { waiting: null })
    await boot($)
    await demo($)
    const pane = await mount($, 'terminal')
    // The pane draws again on the next read, so each restart is read before it is pressed.
    const again = async () => {
      await demo($)
      await pane.drawn()
    }
    await press($, `opt-${DEMO_RIGHT}`)
    await press($, 'submit')
    expect(await pane.find({ text: STR.correct })).toBeDefined()
    await press($, 'done')
    await again()
    await press($, 'opt-o1')
    await press($, 'submit')
    expect(await pane.find({ text: STR.wrong })).toBeDefined()
    await again()
    await press($, 'skip')
    expect(await pane.find({ text: STR.skipped })).toBeDefined()
    await again()
    await press($, 'teach')
    expect(await pane.find({ text: STR.taught })).toBeDefined()
    await again()
    await press($, 'opt-other')
    await press($, 'submit')
    expect(await pane.find({ text: STR.nothingTyped })).toBeDefined()
    await $.ui.input({ plugin: PLUGIN, key: 'other-text', text: 'my words', kind: 'change' })
    await press($, 'submit')
    expect(await pane.find({ text: STR.demoTyped })).toBeDefined()
    expect(w.log.spawns).toHaveLength(0)
    expect(w.log.prompts).toHaveLength(0)
    expect(w.log.graded).toHaveLength(0)
    // Done asks the server what is waiting, as ever; no answer is sent.
    expect(answers(w.log)).toHaveLength(0)
    expect(serverCalls(w.log).filter((c: any) => c.tool === 'panel_answer')).toHaveLength(0)
  })

  test('demoResult grades a choice, a typed answer, a skip and a blank', () => {
    expect(demoResult('choice', DEMO_RIGHT).correct).toBe(true)
    expect(demoResult('choice', 'o1').correct).toBe(false)
    expect(demoResult('choice', null).correct).toBe(false)
    expect(demoResult('text', null)).toMatchObject({ correct: false, explanation: STR.demoTyped })
    expect(demoResult('skip', null).phase).toBe('skipped')
    expect(demoResult('dont_know', null)).toMatchObject({ taught: true, correct: false })
  })

  test('the last click is shown, so a tester can see what each press did', async ($, on) => {
    world(on)
    await boot($)
    await demo($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-o2')
    expect(JSON.stringify(await pane.drawn())).toContain('o2 picked (button)')
  })

  test('a background heartbeat does not clear it, and Next starts it again without asking the model', async ($, on) => {
    // The server is down at boot, so no sync has been stamped and the next busy event would sync at once.
    let up = false
    const seen: string[] = []
    const prompts: string[] = []
    on('mcp.call', async (_$: any, e: any) => {
      seen.push(e.tool)
      return up ? { value: reply({ none: true }) } : { deny: 'no connected MCP tool "panel_sync"' }
    })
    on('tool.call', async () => ({ result: '{}' }) as any)
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    on('prompt.submit', async (_$: any, e: any) => {
      prompts.push(e.text)
      return { text: e.text }
    })
    host(on)
    await boot($)
    await demo($)
    const pane = await mount($, 'terminal')
    up = true
    seen.length = 0
    await $.tool.call({ tool: 'Read', tool_input: { file_path: '/x' } } as any)
    expect(seen).toEqual([])
    expect(await pane.find({ key: `opt-${DEMO_QUESTION.options[0]!.id}` })).toBeDefined()
    await press($, 'opt-o3')
    await press($, 'submit')
    await press($, 'next')
    expect(prompts).toHaveLength(0)
    expect(await pane.find({ key: 'opt-o3' })).toBeDefined()
    expect(await pane.find({ text: STR.correct })).toBeUndefined()
  })

  test('the real reopen command leaves the demo for the real state', async ($, on) => {
    world(on, { waiting: null })
    await boot($)
    await demo($)
    const pane = await mount($, 'terminal')
    await $.command.run({ command: 'eklavya-panel', args: '' } as any)
    expect(await pane.find({ text: STR.empty })).toBeDefined()
    expect(JSON.stringify(await pane.drawn())).not.toContain(STR.demoBanner)
  })

  test('only the desktop offers the style switch: it starts on whole cards, and the native buttons are one press away', async ($, on) => {
    world(on)
    await boot($)
    await demo($)
    for (const surface of ['terminal', 'vscode'] as const) {
      const drawn = JSON.stringify(await (await mount($, surface)).drawn())
      expect(drawn).not.toContain(STR.demoStyleClient)
      expect(drawn).not.toContain('"type":"Client"')
    }
    const desktop = await mount($, 'desktop')
    const first = JSON.stringify(await desktop.drawn())
    expect(first).toContain(STR.demoStyleClient)
    for (const o of DEMO_QUESTION.options) expect(first).toContain(`card-${o.id}`)
    expect(first).toContain('card.tsx')
    await press($, 'style-button', 'desktop')
    const native = JSON.stringify(await desktop.drawn())
    for (const o of DEMO_QUESTION.options) expect(native).toContain(`opt-${o.id}`)
    expect(native).not.toContain('card.tsx')
    expect(native).toContain('style set to button')
    await press($, 'style-client', 'desktop')
    expect(JSON.stringify(await desktop.drawn())).toContain('card.tsx')
  })

  test('a press anywhere on a whole card picks it; a bad id, a locked card and another pane change nothing', async ($, on) => {
    world(on)
    await boot($)
    await demo($)
    const pane = await mount($, 'desktop')
    await pane.pointer({ type: 'enter', x: 1, y: 1, in: 'card-o2' } as any)
    await pane.pointer({ type: 'up', x: 1, y: 1, button: 'left', in: 'card-o2' } as any)
    expect(chosenCards(await pane.drawn())).toBe(1)
    expect(JSON.stringify(await pane.drawn())).toMatch(/o2 picked \(whole card, \d+ ms in the mod\)/)
    await pane.pointer({ type: 'leave', x: 1, y: 1, in: 'card-o2' } as any)
    await pane.post({ pick: 'zzz' }, { in: 'card-o2' } as any)
    await pane.post({ pick: 7 }, { in: 'card-o2' } as any)
    await pane.post(null, { in: 'card-o2' } as any)
    expect(chosenCards(await pane.drawn())).toBe(1)
    expect(JSON.stringify(await pane.drawn())).toContain('o2 picked')
  })
})

describe('the mock question: lifecycle and the whole-card module', () => {
  const demo = ($: any) => $.command.run({ command: 'eklavya-panel-demo', args: '' } as any)

  test('a session end clears it, so a /clear leaves no mock behind', async ($, on) => {
    world(on, { waiting: null })
    await boot($)
    await demo($)
    const pane = await mount($, 'terminal')
    expect(await pane.find({ key: 'opt-o3' })).toBeDefined()
    await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } } as any)
    await pane.drawn()
    expect(await pane.find({ key: 'opt-o3' })).toBeUndefined()
    expect(JSON.stringify(await pane.drawn())).not.toContain(STR.demoBanner)
  })

  test('a real question the model presents replaces the mock', async ($, on) => {
    const w = world(on, { waiting: null })
    on('tool.call', async () => ({ result: '{}' }) as any)
    await boot($)
    await demo($)
    const pane = await mount($, 'terminal')
    w.s.waiting = QUESTION
    await $.tool.call({ tool: 'mcp__plugin_eklavya_eklavya__present_question', tool_input: {} } as any)
    await pane.drawn()
    const drawn = JSON.stringify(await pane.drawn())
    expect(drawn).toContain(JSON.stringify(QUESTION.stem))
    expect(drawn).not.toContain(STR.demoBanner)
    await press($, 'opt-o3')
    await press($, 'submit')
    expect(answers(w.log)).toHaveLength(1)
  })

  test('on the desktop Other is a pressable header over a three-line box that appears when it is picked', async ($, on) => {
    world(on)
    await boot($)
    await demo($)
    const pane = await mount($, 'desktop')
    expect(await pane.find({ key: 'other-head' })).toBeDefined()
    expect(await pane.find({ key: 'other-text' })).toBeUndefined()
    await pane.post({ pick: 'other' }, { in: 'other-head' } as any)
    const box = JSON.stringify(await pane.find({ key: 'other-text' }))
    expect(box).toContain('"rows":3')
    expect(box).not.toContain('keep')
    expect(JSON.stringify(await pane.find({ key: 'card-other' }))).toContain('"borderStyle":"bold"')
    await pane.post({ pick: 'o2' }, { in: 'card-o2' } as any)
    expect(await pane.find({ key: 'other-text' })).toBeUndefined()
  })

  test('VS Code and the terminal keep the native Other card with its one-line box and Keep button', async ($, on) => {
    world(on)
    await boot($)
    await demo($)
    for (const surface of ['terminal', 'vscode'] as const) {
      const pane = await mount($, surface)
      expect(await pane.find({ key: 'opt-other' })).toBeDefined()
      await press($, 'opt-other', surface)
      const box = JSON.stringify(await pane.find({ key: 'other-text' }))
      expect(box).toContain('"submitLabel":"keep"')
      expect(box).not.toContain('"rows"')
      await press($, 'opt-o1', surface)
    }
  })

  /** The card module alone, with a surface that records what it is handed. */
  function cardSurface(state?: { hover: boolean }) {
    const seen = { posts: [] as unknown[], states: [] as unknown[], listener: null as null | ((e: any) => void) }
    const surface: any = {
      elements: new Proxy({}, { get: (_t, tag) => (props: any) => ({ type: String(tag), props }) }),
      state,
      setState: (next: unknown) => seen.states.push(next),
      post: (data: unknown) => seen.posts.push(data),
      onPointer: (fn: (e: any) => void) => {
        seen.listener = fn
        return () => {}
      },
    }
    return { seen, surface }
  }
  const props = { id: 'o2', label: 'L', note: 'N', chosen: false, locked: false, brand: '#79D5C4', fill: '#1E5A52', text: '#FFFFFF', noteText: '#C9E8E3' }

  test('the card posts its id on a left or unspecified release and on nothing else', () => {
    const { seen, surface } = cardSurface()
    Card(props, surface)
    for (const e of [{ type: 'up', button: 'left' }, { type: 'up' }]) seen.listener!(e)
    expect(seen.posts).toEqual([{ pick: 'o2' }, { pick: 'o2' }])
    for (const e of [{ type: 'up', button: 'right' }, { type: 'up', button: 'middle' }, { type: 'down', button: 'left' }, { type: 'move' }]) seen.listener!(e)
    expect(seen.posts).toHaveLength(2)
  })

  test('a locked card posts nothing and does not light up under the pointer', () => {
    const { seen, surface } = cardSurface({ hover: true })
    const tree: any = Card({ ...props, locked: true }, surface)
    seen.listener!({ type: 'up', button: 'left' })
    expect(seen.posts).toHaveLength(0)
    expect(tree.props.borderColor).toBe('inactive')
  })

  test('hover is local: it sets state only when it changes, and lights the border', () => {
    const idle = cardSurface()
    Card(props, idle.surface)
    idle.seen.listener!({ type: 'enter' })
    idle.seen.listener!({ type: 'leave' })
    expect(idle.seen.states).toEqual([{ hover: true }])
    const over = cardSurface({ hover: true })
    const tree: any = Card(props, over.surface)
    over.seen.listener!({ type: 'enter' })
    over.seen.listener!({ type: 'leave' })
    expect(over.seen.states).toEqual([{ hover: false }])
    expect(tree.props.borderColor).toBe(props.brand)
    expect(tree.props.borderStyle).toBe('single')
  })

  test('a picked card has the bold brand border, the fill and the picked text colours', () => {
    const { surface } = cardSurface()
    const tree: any = Card({ ...props, chosen: true }, surface)
    expect(tree.props).toMatchObject({ borderStyle: 'bold', borderColor: props.brand, backgroundColor: props.fill })
    const words = tree.props.children[0].props.children
    expect(words[0].props).toMatchObject({ bold: true, color: props.text })
    expect(words[1].props).toMatchObject({ dimColor: false, color: props.noteText })
  })
})

describe('the demo picture test under Teach me', () => {
  const demo = ($: any) => $.command.run({ command: 'eklavya-panel-demo', args: '' } as any)
  const types = (tree: unknown) => [...(typeof tree === 'string' ? tree : JSON.stringify(tree)).matchAll(/"type":"(Svg|Image)"/g)].map(m => m[1])

  test('the terminal draws the PNG as an Image and no Svg, below Teach me', async ($, on) => {
    world(on)
    await boot($)
    await demo($)
    const drawn = JSON.stringify(await (await mount($, 'terminal')).drawn())
    expect(types(drawn)).toEqual(['Image'])
    expect(drawn).toContain(DEMO_PNG)
    expect(drawn).toContain(STR.experimentBanner)
    expect(drawn.indexOf('"key":"teach"')).toBeLessThan(drawn.indexOf(STR.experimentBanner))
    expect(drawn.indexOf(STR.experimentBanner)).toBeLessThan(drawn.indexOf('"type":"Image"'))
  })

  test('the desktop draws the vector and the PNG-in-SVG as two Svg and no Image, below Teach me', async ($, on) => {
    world(on)
    await boot($)
    await demo($)
    const drawn = JSON.stringify(await (await mount($, 'desktop')).drawn())
    // The header's mascot face, then the two test pictures.
    expect(types(drawn)).toEqual(['Svg', 'Svg', 'Svg'])
    expect(drawn).toContain(STR.experimentBanner)
    expect(drawn).toContain(JSON.stringify(STR.experimentImageAlt))
    expect(drawn.indexOf('"key":"teach-client"')).toBeLessThan(drawn.indexOf(STR.experimentBanner))
    // The two test pictures follow the banner; the header's face is before everything.
    const banner = drawn.indexOf(STR.experimentBanner)
    expect(drawn.indexOf('"type":"Svg"')).toBeLessThan(banner)
    expect(drawn.indexOf('"type":"Svg"', banner)).toBeGreaterThan(banner)
  })

  test('a real question never carries the experiment, on either surface', async ($, on) => {
    world(on)
    await boot($)
    for (const surface of SURFACES) {
      const drawn = JSON.stringify(await (await mount($, surface)).drawn())
      // Only the header's mascot face on the desktop; nothing at all on the terminal.
      expect(types(drawn)).toEqual(surface === 'desktop' ? ['Svg'] : [])
      expect(drawn).not.toContain(STR.experimentBanner)
    }
  })

  test('the picture is gone once the demo is answered, and the style switch keeps it', async ($, on) => {
    world(on)
    await boot($)
    await demo($)
    const pane = await mount($, 'desktop')
    await press($, 'style-button', 'desktop')
    expect(types(await pane.drawn())).toEqual(['Svg', 'Svg', 'Svg'])
    await press($, 'style-client', 'desktop')
    expect(types(await pane.drawn())).toEqual(['Svg', 'Svg', 'Svg'])
    await press($, 'skip', 'desktop')
    expect(types(await pane.drawn())).toEqual(['Svg'])
  })

  test('the assets are what the host accepts: a PNG of the mark, and plain SVG with no script', () => {
    expect(DEMO_PNG.startsWith('iVBORw0KGgo')).toBe(true)
    const bytes = Uint8Array.from(atob(DEMO_PNG), c => c.charCodeAt(0))
    const dim = (at: number) => (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!
    expect([dim(16), dim(20)]).toEqual([96, 96])
    const svg = demoSvg()
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"')).toBe(true)
    expect((svg.match(/<rect /g) ?? []).length).toBeGreaterThan(10)
    expect(svg).toContain('#EF9875')
    expect(svg).not.toMatch(/<script|on\w+=/i)
    const wrapped = demoSvgWithPng()
    expect(wrapped).toContain(`href="data:image/png;base64,${DEMO_PNG}"`)
    expect(wrapped.length).toBeLessThan(131072)
  })
})

describe('real questions on the desktop: whole cards, numbers, the Teach me pill and the Other row', () => {
  const clients = (tree: unknown) => ((typeof tree === 'string' ? tree : JSON.stringify(tree)).match(/"type":"Client"/g) ?? []).length
  const chosenCards = (tree: unknown) => (JSON.stringify(tree).match(/"chosen":true/g) ?? []).length

  test('every answer is a numbered region, and Other and Teach me are regions too', async ($, on) => {
    world(on)
    await boot($)
    const pane = await mount($, 'desktop')
    const drawn = JSON.stringify(await pane.drawn())
    QUESTION.options.forEach((o, i) => {
      const card = JSON.stringify(drawn.slice(drawn.indexOf(`"key":"card-${o.id}"`)))
      expect(card).toContain(`\\"n\\":${i + 1}`)
    })
    expect(clients(drawn)).toBe(QUESTION.options.length + 2)
    expect(drawn).toContain('"key":"other-head"')
    expect(drawn).toContain('"key":"teach-client"')
    // Nothing the desktop does not draw: no Button to focus, no hotkey, no hint.
    expect(drawn).not.toContain('"key":"opt-o1"')
    expect(drawn).not.toContain('"hotkey"')
  })

  test('VS Code and the terminal draw no Client at all, and VS Code numbers the labels itself', async ($, on) => {
    world(on)
    await boot($)
    const vscode = JSON.stringify(await (await mount($, 'vscode')).drawn())
    const terminal = JSON.stringify(await (await mount($, 'terminal')).drawn())
    expect(clients(vscode)).toBe(0)
    expect(clients(terminal)).toBe(0)
    QUESTION.options.forEach((o, i) => expect(vscode).toContain(`${i + 1}  ${o.label}`))
    // The terminal's plain Button already draws `1:`, so its label stays bare.
    expect(terminal).not.toContain(`1  ${QUESTION.options[0].label}`)
  })

  test('a press on a card, on Other and on Teach me reaches the same handlers as the buttons do', async ($, on) => {
    mock.clock(on)
    const w = world(on)
    await boot($)
    const pane = await mount($, 'desktop')
    await pane.post({ pick: 'o3' }, { in: 'card-o3' } as any)
    await pane.post({ press: 'teach' }, { in: 'teach-client' } as any)
    expect(answers(w.log)).toHaveLength(1)
    expect(answers(w.log)[0].args).toMatchObject({ kind: 'dont_know', question_id: 'q1' })
    // The draft pick did not become an answer: Teach me is its own kind.
    expect(answers(w.log)[0].args.option_id).toBeUndefined()
  })

  test('Other opens from its header and a typed answer is sent from Submit', async ($, on) => {
    const w = world(on)
    await boot($)
    const pane = await mount($, 'desktop')
    await pane.post({ pick: 'other' }, { in: 'other-head' } as any)
    expect(JSON.stringify(await pane.find({ key: 'other-text' }))).toContain('"rows":3')
    await $.ui.input({ plugin: PLUGIN, key: 'other-text', text: 'the rename is atomic', kind: 'change' })
    await press($, 'submit', 'desktop')
    expect(answers(w.log).at(-1)!.args).toMatchObject({ kind: 'text', text: 'the rename is atomic' })
  })

  test('data that names no answer or no press changes nothing', async ($, on) => {
    mock.clock(on)
    const w = world(on)
    await boot($)
    const pane = await mount($, 'desktop')
    for (const data of [{ pick: 'zzz' }, { pick: 4 }, { press: 'launch' }, { press: 7 }, {}, null, 'teach'] as const)
      await pane.post(data as any, { in: 'card-o1' } as any)
    expect(answers(w.log)).toHaveLength(0)
    expect(chosenCards(await pane.drawn())).toBe(0)
  })

  /** A tiny stand-in for the surface a region module draws on. */
  function surfaceOf(state?: { hover: boolean }) {
    const seen = { posts: [] as unknown[], states: [] as unknown[], listener: null as null | ((e: any) => void) }
    const surface: any = {
      elements: new Proxy({}, { get: (_t, tag) => (props: any) => ({ type: String(tag), props }) }),
      state,
      setState: (next: unknown) => seen.states.push(next),
      post: (data: unknown) => seen.posts.push(data),
      onPointer: (fn: (e: any) => void) => {
        seen.listener = fn
        return () => {}
      },
    }
    return { seen, surface }
  }

  test('a numbered card is a row of the number and the words, and the number follows the pick', () => {
    const base = { id: 'o2', label: 'L', note: 'N', n: 2, chosen: false, locked: false, brand: '#79D5C4', fill: '#1E5A52', text: '#FFFFFF', noteText: '#C9E8E3' }
    const idle: any = Card(base, surfaceOf().surface)
    expect(idle.props.flexDirection).toBe('row')
    expect(idle.props.children[0].props).toMatchObject({ bold: true, dimColor: true, children: ['2'] })
    const picked: any = Card({ ...base, chosen: true }, surfaceOf().surface)
    expect(picked.props.children[0].props).toMatchObject({ dimColor: false, color: '#FFFFFF' })
  })

  test('a bare card has no border or fill and no note line when it has no note', () => {
    const { surface } = surfaceOf()
    const tree: any = Card({ id: 'other', label: 'Other', note: '', chosen: true, locked: false, bare: true, brand: 'b', fill: 'f', text: 't', noteText: 'n' }, surface)
    expect(tree.props.borderStyle).toBeUndefined()
    expect(tree.props.backgroundColor).toBeUndefined()
    const words = tree.props.children[0].props.children
    expect(words).toHaveLength(1)
    expect(words[0].props).toMatchObject({ bold: false })
  })

  test('the Teach me pill posts on a left or unspecified release only, never when locked, and lights under the pointer', () => {
    const props = { id: 'teach', label: 'Teach', locked: false, fill: '#D97757', hoverFill: '#E48866', text: '#1F1E1D' }
    const idle = surfaceOf()
    const tree: any = Pill(props, idle.surface)
    expect(tree.props).toMatchObject({ backgroundColor: '#D97757', borderColor: '#D97757', paddingY: 0.5 })
    for (const e of [{ type: 'up', button: 'left' }, { type: 'up' }, { type: 'up', button: 'right' }, { type: 'down', button: 'left' }]) idle.seen.listener!(e)
    expect(idle.seen.posts).toEqual([{ press: 'teach' }, { press: 'teach' }])
    idle.seen.listener!({ type: 'enter' })
    idle.seen.listener!({ type: 'leave' })
    expect(idle.seen.states).toEqual([{ hover: true }])
    const over = surfaceOf({ hover: true })
    expect((Pill(props, over.surface) as any).props.backgroundColor).toBe('#E48866')
    over.seen.listener!({ type: 'enter' })
    over.seen.listener!({ type: 'leave' })
    expect(over.seen.states).toEqual([{ hover: false }])
    const locked = surfaceOf({ hover: true })
    const lockedTree: any = Pill({ ...props, locked: true }, locked.surface)
    locked.seen.listener!({ type: 'up', button: 'left' })
    expect(locked.seen.posts).toHaveLength(0)
    expect(lockedTree.props.backgroundColor).toBe('#D97757')
  })
})

describe('gaps closed in review: surfaces, grading and multi-line answers', () => {
  const elements = (tree: unknown) => [...JSON.stringify(tree).matchAll(/"type":"(Svg|Client|Image)"/g)].map(m => m[1])

  test('a surface the elements table does not list for Svg keeps the grid mark and draws no Svg, Client or Image', async ($, on) => {
    world(on)
    await boot($)
    await $.command.run({ command: 'eklavya-panel-demo', args: '' } as any)
    const drawn = JSON.stringify(await (await mount($, 'mobile' as any)).drawn())
    expect(elements(drawn)).toEqual([])
    expect(drawn).toContain('logo-0')
    expect(drawn).toContain(STR.experimentNone)
    expect(drawn).toContain('opt-o1')
  })

  test('while an answer is being graded the cards and the pill are locked, Teach me is gone and a stray click changes nothing', async ($, on) => {
    mock.clock(on)
    const w = world(on)
    let seen = ''
    let afterStray = 0
    let pane: any
    w.s.answer = async () => {
      // Read while the answer is in flight: the pane is in its grading step.
      seen = JSON.stringify(await pane.drawn())
      await pane.post({ pick: 'o1' }, { in: 'card-o1' })
      afterStray = (JSON.stringify(await pane.drawn()).match(/"chosen":true/g) ?? []).length
      return { phase: 'answered', attempt_id: 7, correct: true, explanation: 'Stored.' }
    }
    await boot($)
    pane = await mount($, 'desktop')
    await pane.post({ pick: 'o3' }, { in: 'card-o3' })
    await press($, 'submit', 'desktop')
    expect(seen).toContain('"locked":true')
    expect(seen).not.toContain('"locked":false')
    expect(seen).not.toContain('teach-client')
    expect(seen).toContain(STR.grading)
    // The pick made during grading did not move the chosen card.
    expect(afterStray).toBe(1)
    expect(await pane.find({ text: STR.correct })).toBeDefined()
  })

  test('a typed answer of several lines is graded and recorded whole, newlines kept', async ($, on) => {
    const w = world(on)
    await boot($)
    const pane = await mount($, 'desktop')
    await pane.post({ pick: 'other' }, { in: 'other-head' })
    const text = 'A rename is atomic.\nSo the poller sees the file whole.'
    await $.ui.input({ plugin: PLUGIN, key: 'other-text', text, kind: 'change' })
    await press($, 'submit', 'desktop')
    expect(w.log.graded).toHaveLength(1)
    expect(w.log.graded[0]).toContain(text)
    const sent = answers(w.log).filter((c: any) => c.args.kind === 'text')
    expect(sent).toHaveLength(2)
    for (const call of sent) expect(call.args.text).toBe(text)
  })
})
