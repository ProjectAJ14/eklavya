import type { ClientModule } from 'claude-code'

/**
 * One answer card drawn as a `Client` region, so a press anywhere on it (border,
 * padding, title or note) picks it. A `Button` is only as large as its label, and a
 * `Box` takes no press, so this is the one way to make the whole card the target.
 *
 * It gets no mods API: it holds only its hover and posts `{ pick: id }` to the hooks
 * module, whose `ui.message` hook validates the id and records the pick. The colours
 * come in as props, so the module imports nothing.
 */
export type CardProps = {
  id: string
  label: string
  note: string
  chosen: boolean
  locked: boolean
  brand: string
  fill: string
  text: string
  noteText: string
}

const Card: ClientModule<CardProps, { hover: boolean }> = (p, s) => {
  const { Box, Text } = s.elements
  const hover = s.state?.hover ?? false
  // One listener, replaced on each call, so it always reads this render's props.
  s.onPointer(e => {
    if (e.type === 'enter' && !hover) s.setState({ hover: true })
    else if (e.type === 'leave' && hover) s.setState({ hover: false })
    else if (e.type === 'up' && !p.locked && (e.button === undefined || e.button === 'left')) s.post({ pick: p.id })
  })
  return Box({
    flexDirection: 'column',
    paddingX: 2,
    paddingY: 1,
    borderStyle: p.chosen ? 'bold' : 'single',
    borderColor: p.chosen || (hover && !p.locked) ? p.brand : 'inactive',
    backgroundColor: p.chosen ? p.fill : undefined,
    children: [
      Text({ wrap: 'wrap', bold: p.chosen, color: p.chosen ? p.text : undefined, children: [p.label] }),
      Text({ wrap: 'wrap', dimColor: !p.chosen, color: p.chosen ? p.noteText : undefined, children: [p.note] }),
    ],
  })
}

export default Card
