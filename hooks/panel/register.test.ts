import { describe, expect, test } from 'claude-code/testing'

import { EMPTY, EXPLAINER, STR, explainerBrief, gradingRequest, parseVerdict, payloadOf, projectName, topicLabel, unplacedNotice } from './model'

const PLUGIN = 'eklavya'
const PANE = 'eklavya-quiz'
const SURFACES = ['terminal', 'desktop'] as const

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
  const log = { calls: [] as { tool: string; args: any }[], prompts: [] as string[], opens: [] as any[], toasts: [] as string[], graded: [] as string[], spawns: [] as any[] }
  const s = {
    waiting: QUESTION as any,
    answer: ((args: any) => ({ phase: 'answered', attempt_id: 7, correct: args.option_id === 'o3', correct_label: 'The origin is compared', explanation: 'The Origin cannot be forged.' })) as any,
    placed: true,
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
    return s.spawn
  })
  on('ui.toast', async (_$: any, e: any) => {
    log.toasts.push(e.text)
    return { value: undefined }
  })
  host(on)
  return { log, s }
}

/** The rest of what the host answers beneath the mod. */
function host(on: any) {
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', async (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('session.cwd', async () => ({ value: '/work/proj' }))
  on('session.id', async () => ({ value: 'test-session' }))
  on('session.surfaces', async () => ({ value: ['terminal'] }))
  on('session.version', async () => ({ value: { version: '2.1.292', base: '2.1.292', builtAt: '2026-10-01T00:00:00Z' } }))
  on('command.register', async () => ({ value: undefined }))
  on('ui.close', async () => ({ value: undefined }))
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
const answers = (log: any) => log.calls.filter((c: any) => c.tool === 'panel_answer')

describe('the pane, state by state', () => {
  for (const surface of SURFACES) {
    test(`shows nothing waiting, then the question, on ${surface}`, async ($, on) => {
      const w = world(on, { waiting: null })
      await boot($)
      let pane = await mount($, surface)
      expect(await pane.find({ text: STR.empty })).toBeDefined()
      expect(await pane.find({ text: STR.brand })).toBeDefined()
      expect(await pane.find({ text: STR.powered })).toBeDefined()
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

  test('selecting an option is a draft: it never submits, grades or skips', async ($, on) => {
    const w = world(on)
    await boot($)
    const pane = await mount($, 'terminal')
    await press($, 'opt-o2')
    await press($, 'opt-o3')
    expect(await pane.find({ text: /● The origin is compared/ })).toBeDefined()
    expect(await pane.find({ text: /○ Cookies are signed/ })).toBeDefined()
    expect(answers(w.log)).toHaveLength(0)
  })

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
    expect(await pane.find({ text: /● The origin is compared/ })).toBeDefined()
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
    expect(w.log.prompts).toEqual(['Start the eklavya-explainer agent.'])
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
      found = await other.find({ text: STR.brand })
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
    expect(await pane.find({ text: /○ Cookies are signed/ })).toBeDefined()
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
