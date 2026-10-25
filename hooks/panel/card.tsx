import type { ClientModule } from 'claude-code'

/**
 * One answer card drawn as a `Client` region, so a press anywhere on it (border,
 * padding, number, title or note) picks it. A `Button` is only as large as its label, and a
 * `Box` takes no press, so this is the one way to make the whole card the target.
 *
 * It gets no mods API: it holds only its hover and posts `{ pick: id }` to the hooks
 * module, whose `ui.message` hook validates the id and records the pick. The colours
 * come in as props, so the module imports nothing.
 *
 * `bare` draws only the pressable header (padding and text, no border or fill): the Other
 * card's frame and its text box belong to the hooks module, and this is the row that selects it.
 */
export type CardProps = {
  id: string
  label: string
  note: string
  /** The answer's number, drawn before the text; absent for Other. */
  n?: number
  chosen: boolean
  locked: boolean
  bare?: boolean
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
  const words = Box({
    flexDirection: 'column',
    flexShrink: 1,
    children: [
      Text({ wrap: 'wrap', bold: p.chosen && !p.bare, color: p.chosen && !p.bare ? p.text : undefined, children: [p.label] }),
      ...(p.note ? [Text({ wrap: 'wrap', dimColor: !p.chosen, color: p.chosen ? p.noteText : undefined, children: [p.note] })] : []),
    ],
  })
  return Box({
    flexDirection: p.n === undefined ? 'column' : 'row',
    gap: 2,
    paddingX: 2,
    paddingY: 1,
    ...(p.bare
      ? {}
      : {
          borderStyle: p.chosen ? 'bold' : 'single',
          borderColor: p.chosen || (hover && !p.locked) ? p.brand : 'inactive',
          backgroundColor: p.chosen ? p.fill : undefined,
        }),
    children: [
      ...(p.n === undefined ? [] : [Text({ bold: true, dimColor: !p.chosen, color: p.chosen ? p.text : undefined, children: [String(p.n)] })]),
      words,
    ],
  })
}

export default Card
