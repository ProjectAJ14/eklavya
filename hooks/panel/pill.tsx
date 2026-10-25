import type { ClientModule } from 'claude-code'

/**
 * A compact filled button drawn as a `Client` region, so a press anywhere on it (fill, padding or
 * text) counts. A `Button` takes no fill, and a `Box` takes no press, so a coloured button whose
 * whole body is pressable has to be a region of its own. It sizes to its text and posts
 * `{ press: id }` to the hooks module, which validates it. Colours come in as props.
 */
export type PillProps = {
  id: string
  label: string
  locked: boolean
  fill: string
  hoverFill: string
  text: string
}

const Pill: ClientModule<PillProps, { hover: boolean }> = (p, s) => {
  const { Box, Text } = s.elements
  const hover = s.state?.hover ?? false
  s.onPointer(e => {
    if (e.type === 'enter' && !hover) s.setState({ hover: true })
    else if (e.type === 'leave' && hover) s.setState({ hover: false })
    else if (e.type === 'up' && !p.locked && (e.button === undefined || e.button === 'left')) s.post({ press: p.id })
  })
  const fill = hover && !p.locked ? p.hoverFill : p.fill
  return Box({
    flexDirection: 'row',
    paddingX: 2,
    paddingY: 0.5,
    borderStyle: 'round',
    borderColor: fill,
    backgroundColor: fill,
    children: [Text({ color: p.text, children: [p.label] })],
  })
}

export default Pill
