// Drives the real quiz panel mod (hooks/panel/register.tsx) through Claude Code's
// test host and prints each drawn tree for scripts/panel-preview.sh. It is copied
// into a staged plugin as a *.test.ts; it lives here so `claude plugin test` on
// the repository never runs it.
import { describe, expect, test } from 'claude-code/testing'

import Card from './card'
import Pill from './pill'

const PLUGIN = 'eklavya'
const PANE = 'eklavya-quiz'

/** The question from the maintainer's desktop screenshot of 2026-10-16: long answers, each with a note under it as real questions have. */
const LONG = {
  question_id: 'q1',
  repo: '/work/proj',
  stem: 'A text input is rendered as `<input value={name} onChange={e => setName(e.target.value)} />`. What makes this a *controlled* input?',
  options: [
    { id: 'o1', label: 'The browser keeps the typed text and React reads it later on submit', note: 'That is an uncontrolled input: the DOM owns the value' },
    { id: 'o2', label: "The parent's state holds the value, and the input shows whatever that state says on every render", note: 'React state is the single source of truth for the field' },
    { id: 'o3', label: 'It has an onChange handler, so React is notified of every keystroke', note: 'An uncontrolled input can have onChange too' },
    { id: 'o4', label: 'It uses a ref so React can reach into the field directly at any time', note: 'Refs are how you read an uncontrolled input' },
  ],
  concept_name: 'Controlled vs uncontrolled React state',
  tier: 1,
  more: false,
  phase: 'pending',
}

const NOTES = {
  ...LONG,
  question_id: 'q2',
  stem: 'Why does the server compare the `Origin` header?',
  options: [
    { id: 'o1', label: 'Tokens are checked by the server', note: 'Only if a token was sent at all' },
    { id: 'o2', label: 'Cookies are signed', note: 'Signing proves who set it, not who sent it' },
    { id: 'o3', label: 'The origin is compared', note: 'A browser sets it and a page cannot change it' },
    { id: 'o4', label: 'The body is hashed', note: 'A hash says nothing about the sender' },
  ],
  concept_name: 'CSRF',
  tier: 2,
}

const reply = (payload: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false })

function world(on: any, waiting: any, answer: any = { phase: 'answered', attempt_id: 7, correct: false, correct_label: LONG.options[1].label, explanation: 'React owns the value: `value` comes from state and `onChange` writes it back.' }) {
  on('mcp.call', async (_$: any, e: any) => {
    if (e.tool === 'panel_sync') return { value: reply(waiting) }
    if (e.tool === 'panel_answer') return { value: reply(typeof answer === 'function' ? answer(e.args) : answer) }
    return { value: reply({ error: 'unknown_tool' }) }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('model.complete', async () => ({ value: { isAnswered: true, text: '{"grade":5,"outcome":"answered","feedback":"Right."}', usage: {} } }))
  on('prompt.submit', async (_$: any, e: any) => ({ text: e.text }))
  on('agent.spawn', async () => ({ model: 'm', agentId: 'a1' }))
  on('ui.toast', async () => ({ value: undefined }))
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', async (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('session.cwd', async () => ({ value: '/work/proj' }))
  on('session.id', async () => ({ value: 'preview' }))
  on('session.surfaces', async () => ({ value: ['desktop'] }))
  on('session.version', async () => ({ value: { version: '2.1.300', base: '2.1.300', builtAt: '2026-10-01T00:00:00Z' } }))
  on('command.register', async () => ({ value: undefined }))
  on('ui.close', async () => ({ value: undefined }))
}

/**
 * The host draws a `Client` from its module; the test host only records it. So the preview runs the same module
 * here, on a stand-in surface, and puts the tree it returns in the Client's place.
 */
const MODULES: Record<string, (props: any, surface: any) => any> = { 'hooks/card.tsx': Card as any, 'hooks/pill.tsx': Pill as any }
function expand(tree: any): any {
  if (!tree || typeof tree !== 'object') return tree
  if (tree.type === 'Client') {
    const surface: any = {
      elements: new Proxy({}, { get: (_t, tag) => (props: any) => ({ type: String(tag), props: { ...props, children: undefined }, children: props.children }) }),
      state: undefined,
      setState: () => {},
      post: () => {},
      onPointer: () => () => {},
    }
    return expand(MODULES[tree.props.module]!(tree.props.props, surface))
  }
  return { ...tree, children: tree.children?.map(expand) }
}

/** A step is a Button key, `pick:<id>` (a press on a whole card, or `other`'s header), or `teach` (the Teach me region). */
async function step($: any, pane: any, key: string) {
  if (key.startsWith('pick:')) {
    const id = key.slice(5)
    return pane.post({ pick: id }, { in: id === 'other' ? 'other-head' : `card-${id}` })
  }
  if (key === 'teach') return pane.post({ press: 'teach' }, { in: 'teach-client' })
  return $.ui.press({ plugin: PLUGIN, key, surface: 'desktop' })
}

async function scene($: any, name: string, steps: string[] = [], typed?: string) {
  await $.session.start({ cwd: '/work/proj', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'Pane',
    requestId: PANE,
    props: { title: 'Eklavya', isFocused: true, bodyColumns: 60, placement: 'dock' },
    viewport: { columns: 160, rows: 40 },
  })
  for (const key of steps) await step($, pane, key)
  if (typed !== undefined) await $.ui.input({ plugin: PLUGIN, key: 'other-text', kind: 'change', text: typed, surface: 'desktop' })
  console.log('@@SCENE ' + JSON.stringify({ name, tree: expand(await pane.drawn()) }))
  expect(true).toBe(true)
}

describe('panel preview', () => {
  test('waiting', async ($, on) => (world(on, LONG), scene($, 'Question waiting')))
  test('picked', async ($, on) => (world(on, LONG), scene($, 'Answer 2 picked', ['pick:o2'])))
  test('notes', async ($, on) => (world(on, NOTES), scene($, 'Answers with notes, 3 picked', ['pick:o3'])))
  test('other', async ($, on) => (world(on, LONG), scene($, 'Other open, words typed', ['pick:other'], 'React owns the value')))
  test('wrong', async ($, on) => (world(on, LONG), scene($, 'Result: missed', ['pick:o1', 'submit'])))
  test('right', async ($, on) => (world(on, LONG, { phase: 'answered', attempt_id: 8, correct: true, correct_label: LONG.options[1].label, explanation: 'The state is the single source of truth.' }), scene($, 'Result: correct', ['pick:o2', 'submit'])))
  test('taught', async ($, on) => (world(on, LONG, { phase: 'answered', attempt_id: 9, taught: true, correct: false, correct_label: LONG.options[1].label, explanation: 'React owns the value.' }), scene($, 'Result: Teach me', ['teach'])))
})
