import type { PanelQuestion, PanelResult, PanelState } from './types'

/** The pane's id, as `$.ui.open` and the `ui.render` hook both name it. */
export const PANE = 'eklavya-quiz'

/** The command that opens the pane when it was hidden or could not be seated. */
export const REOPEN = '/eklavya-panel'

export const EMPTY: PanelState = {
  step: 'none',
  question: null,
  draft: { picked: null, other: false, text: '' },
  pending: null,
  result: null,
  message: null,
}

/** Tier names as the dashboard shows them (`TIER` in `assets/dashboard.html`; a test keeps the two equal). */
export const TIER: Record<number, string> = { 1: 'recall', 2: 'mechanism', 3: 'judgement', 4: 'failure modes', 5: 'design' }

/** Brand verdigris (`--vd-300`): the selected card's border and the name. */
export const BRAND = '#79D5C4'
/** The fill and text of the picked answer: set together so the contrast holds in a light or a dark theme. */
export const PICKED = { bg: '#1E5A52', text: '#FFFFFF', note: '#C9E8E3' }
/** Teach me is Claude's orange (the logo's mascot), fill and border. The text is dark, as white on that orange is too faint at body size. */
export const TEACH = { bg: '#D97757', text: '#1F1E1D', hover: '#E48866' }

/**
 * The logo: the Claude mascot (orange) holding an Eklavya bow and arrow (white), drawn on a
 * grid where one cell is a quarter of a text character. Designed in the logo maker; a letter
 * names its colour in LOGO_PALETTE and a dot is empty.
 */
export const LOGO_GRID = [
  '.................dd.......',
  '................d..d......',
  '................d...d.....',
  '...aaaaaaaaaaaa.d....d....',
  '...aa.aaaaaa.aa.d.....d...',
  '.aaaaaaaaaaaaaaadddddddddd',
  '...aaaaaaaaaaaa.d.....d...',
  '....a.a....a.a..d....d....',
  '................d...d.....',
  '................d..d......',
  '.................dd.......',
  '..........................',
] as const
export const LOGO_PALETTE: Record<string, string> = { a: '#D97757', d: '#FFFFFF' }

/** One stretch of text cells that share a colour pair. A text character holds two colours at most. */
export type LogoRun = { text: string; fg?: string; bg?: string }

/** Quadrant glyphs by which of the four cells (upper left 1, upper right 2, lower left 4, lower right 8) are filled. */
const QUADRANT = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'

/**
 * The grid as rows of text runs: each 2 by 2 block becomes one quadrant character, the
 * first colour as its foreground and a second, if any, as its background. A third colour
 * in one block is dropped, so the logo degrades and never throws.
 */
export function logoRows(grid: readonly string[] = LOGO_GRID, palette: Record<string, string> = LOGO_PALETTE): LogoRun[][] {
  const out: LogoRun[][] = []
  for (let cy = 0; cy < Math.ceil(grid.length / 2); cy++) {
    const runs: LogoRun[] = []
    for (let cx = 0; cx < Math.ceil((grid[0]?.length ?? 0) / 2); cx++) {
      const quad = [grid[cy * 2]?.[cx * 2], grid[cy * 2]?.[cx * 2 + 1], grid[cy * 2 + 1]?.[cx * 2], grid[cy * 2 + 1]?.[cx * 2 + 1]].map(c => (c && c !== '.' ? c : ''))
      const [first, second] = [...new Set(quad.filter(Boolean))]
      let run: LogoRun = { text: ' ' }
      if (first) {
        const mask = quad.reduce((n, c, i) => (c === first ? n | (1 << i) : n), 0)
        run = { text: QUADRANT[mask], fg: palette[first], bg: second ? palette[second] : undefined }
      }
      const last = runs[runs.length - 1]
      if (last && last.fg === run.fg && last.bg === run.bg) last.text += run.text
      else runs.push(run)
    }
    out.push(runs)
  }
  return out
}

/** The grid as rows of boxes for a host whose font cannot tile glyphs: runs of one colour (or none) and their width in cells. */
export function boxRows(grid: readonly string[] = LOGO_GRID, palette: Record<string, string> = LOGO_PALETTE): { width: number; color?: string }[][] {
  return grid.map(row => {
    const runs: { width: number; color?: string }[] = []
    for (const c of row) {
      const color = c === '.' ? undefined : palette[c]
      const last = runs[runs.length - 1]
      if (last && last.color === color) last.width++
      else runs.push({ width: 1, color })
    }
    return runs
  })
}

/** The name as the header sets it: spaced capitals, the nearest a terminal gets to a larger type size. */
/** A call such as `tester.tap(find.byType(X))`, nested up to three deep, a lowerCamelCase name or a snake_case name. */
const CODE_LIKE = /[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\((?:[^()\n]|\((?:[^()\n]|\([^()\n]*\))*\))*\)|\b[a-z]{2,}(?:[A-Z][a-z0-9]+)+\b|\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g

/**
 * Wraps code-looking words in backticks so the pane's Markdown draws them as code. A question
 * is plain prose unless its author marked the code, and an old or careless one often is not.
 * Text already in backticks is left as written.
 */
export function codify(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(CODE_LIKE, '`$&`')))
    .join('')
}

/** Block Markdown a heading mark would break: a fence, heading, list, quote, or bold already in it. */
const NOT_HEADING = /```|\*\*|^\s*(?:#|[-*+>]|\d+[.)])\s/m

/** Makes each plain paragraph of a question a heading, so the app draws it larger and bold; a heading is one line, so its line breaks become spaces. */
export function headingParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(p => (p.trim() && !NOT_HEADING.test(p) ? `### ${p.trim().replace(/\s*\n\s*/g, ' ')}` : p))
    .join('\n\n')
}

/** What a Button label can show of Markdown: it keeps the words and drops the code and bold marks. */
export function plainLabel(text: string): string {
  return text.replace(/`|\*\*/g, '')
}

export const WORDMARK = 'EKLAVYA'.split('').join(' ')

/** How long a finished result stays before it closes itself, when no Next is waiting. */
export const CLOSE_MS = 15_000

/** Every sentence the learner reads, in one place. The handoff's table, verbatim. */
export const STR = {
  brand: 'Eklavya',
  submit: 'Submit answer',
  skip: 'Skip question',
  teach: 'New to me — Teach me',
  next: 'Next question',
  done: 'Done',
  autoClose: 'Closes by itself in 15 seconds.',
  retry: 'Retry',
  close: 'Close',
  other: 'Other — explain in your own words',
  otherPlaceholder: 'Your answer in your own words',
  loading: 'Loading your question…',
  grading: 'Checking your answer…',
  correct: 'Correct',
  wrong: 'Needs another look',
  taught: "New to you, and that's fine. Here's the answer.",
  skipped: "Skipped. We won't ask this one again.",
  empty: 'No question right now',
  unreachable: "We couldn't reach Eklavya. Your answer is saved here — Retry.",
  stale: 'This question belongs to another session and was closed.',
  nothingTyped: 'Write your answer first, or pick one of the options.',
  graderFailed: "We couldn't check that answer. Your text is saved here — Retry.",
  explainer: 'A page explaining this is being written.',
  taughtExplainer: "An explainer is on its way. We'll ask this again later.",
  /** What the transcript draws for the mod's own queued prompts; the model still reads the full text. */
  askedNext: 'Eklavya: next quiz question',
  askedExplainer: 'Eklavya: write an explainer page for the missed question',
  askedOther: 'Eklavya: a note for Claude',
  focus: 'Ctrl+X then Tab moves the keys here.',
  keys: '1–4 pick · o other · s submit · k skip · t teach me · Esc back to prompt',
  off: 'The quiz panel is off. Turn it on with: eklavya config set quiz.panel true',
  demoBanner: 'DEMO · a mock question. Nothing here is graded by the server or recorded.',
  demoReady: 'Last click: none yet',
  demoOpened: 'Eklavya quiz panel opened with a mock question. Nothing you answer is recorded.',
  demoFailed: 'The demo panel could not open. Try /eklavya-panel-demo again.',
  demoStyleLabel: 'Answer cards:',
  demoStyleButton: 'Native button',
  demoStyleClient: 'Whole card',
  demoExplanation: 'A rename inside one folder is atomic: the poller sees the finished file or none, never half of it. (This is a mock, so it was not recorded.)',
  demoTyped: 'Typed answers are not graded in the demo. (Nothing was sent or recorded.)',
  mascotAlt: 'The Eklavya mascot',
  experimentBanner: 'EXPERIMENT · picture test. Nothing here is part of a real question.',
  experimentTerminal: 'Image: a PNG, drawn as a picture in kitty, Ghostty and iTerm2 (fullscreen); other terminals show the dim text instead. SVG is not drawn in the terminal.',
  experimentImageAlt: 'The Eklavya mark: the Claude mascot holding a bow and arrow',
  experimentNone: 'This surface draws neither an SVG nor an image, so there is nothing to test here.',
  experimentSvg: 'SVG: the mark drawn as vector rectangles.',
  experimentSvgPng: 'Image: the same mark as a PNG inside an SVG (Desktop has no Image element).',
} as const

/** The explainer agent the panel starts itself, so no prompt lands in the transcript. */
export const EXPLAINER = 'eklavya:eklavya-explainer'

/** What `panel_answer`'s explain block carries; `record_attempt` builds it. */
export type ExplainBlock = {
  concept: string
  name: string
  question: string
  options: string[] | null
  option_notes: (string | null)[] | null
  answer: string | null
  correct: string | null
  attempt_id: number
}

/** The explainer's task, written from the explain block alone: nothing else saw the question. */
export function explainerBrief(x: ExplainBlock): string {
  const options = (x.options ?? []).map((o, i) => {
    const note = x.option_notes?.[i]
    return `${String.fromCharCode(65 + i)}. ${o}${note ? ` (note: ${note})` : ''}`
  })
  return [
    `Write an explainer page on ${x.name} (concept slug ${x.concept}) for a question the learner missed.`,
    `Question: ${x.question}`,
    ...(options.length ? ['Options, in order:', ...options] : []),
    // Words typed under Other match no option, so say so; the page lists them as their own item.
    x.answer && options.length && !x.options!.includes(x.answer)
      ? `The learner typed their own answer instead of picking: ${x.answer}`
      : x.answer
        ? `The learner answered: ${x.answer}`
        : `The learner pressed Teach me: they did not know this and asked to be taught from the mechanism up. They gave no answer.`,
    ...(x.correct ? [`The right answer: ${x.correct}`] : []),
    `Pass --attempt ${x.attempt_id} to eklavya artifacts new.`,
  ].join('\n')
}

export const answerWas = (label: string): string => `The answer was: ${label}`

/** The command that opens the mock question; it never reaches the server, so it needs no question to be waiting. */
export const DEMO_COMMAND = 'eklavya-panel-demo'

/** The mock question: long answers, each with a note, as real questions have. `o3` is the right one. */
export const DEMO_QUESTION: PanelQuestion = {
  question_id: 'demo',
  repo: '*',
  stem: 'A job writes a text file into a shared folder that another system polls every minute. Why is it safer to write the file under a temporary name and then rename it into place, rather than writing it directly under its final name?',
  options: [
    { id: 'o1', label: 'Renaming makes the write faster', note: 'A rename skips the disk write, so the final file appears sooner than a direct write would.' },
    { id: 'o2', label: 'Renaming encrypts the file in transit', note: 'The temporary name keeps the contents protected until the rename publishes the finished file.' },
    { id: 'o3', label: 'The poller never sees a half-written file', note: 'A rename within one folder is atomic, so the file appears complete or not at all to the reader.' },
    { id: 'o4', label: 'Renaming lets two jobs write at once', note: 'Each job writes its own temporary name, so both can write the same final file without any conflict.' },
  ],
  concept_name: 'Atomic file replace',
  tier: 2,
  more: true,
}

export const DEMO_RIGHT = 'o3'

/** What the server would reply, made here: a demo answer is graded on this machine and recorded nowhere. */
export function demoResult(kind: 'choice' | 'text' | 'skip' | 'dont_know', optionId: string | null): PanelResult {
  const right = DEMO_QUESTION.options.find(o => o.id === DEMO_RIGHT)!.label
  if (kind === 'skip') return { phase: 'skipped', attempt_id: 0 }
  if (kind === 'dont_know') return { phase: 'answered', attempt_id: 0, taught: true, correct: false, correct_label: right, explanation: STR.demoExplanation }
  const correct = kind === 'choice' && optionId === DEMO_RIGHT
  return { phase: 'answered', attempt_id: 0, correct, correct_label: right, explanation: kind === 'text' ? STR.demoTyped : STR.demoExplanation }
}

/**
 * The mascot's neutral face, the header mark on every surface that draws `Svg`. A copy of
 * `web/public/brand/mascot/expressions/neutral-face.svg` (the mod has no filesystem); a test keeps the two equal,
 * so regenerate with `npm run mascot:generate` and paste the file. The terminal keeps the block-character logo.
 */
export const MASCOT_FACE =
  "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"30 12 126 128\" width=\"200\" height=\"200\" class=\"ek-mascot\" data-expression=\"neutral\" data-variant=\"face\" role=\"img\"><style>:root {/* ---------- MASCOT IDENTITY ----------\n     Archer Cloak artwork keeps its approved identity across both grounds.\n     UI chrome continues to use the surface, text and accent roles below. */\n  --mascot-coral: #ef9875;\n  --mascot-coral-dark: #c96d51;\n  --mascot-highlight: #ffc8a6;\n  --mascot-cloak: #0E6E66;\n  --mascot-cloak-dark: #07403C;\n  --mascot-thread: #C4EDE4;\n  --mascot-ink: #302c2a;\n  --mascot-metal: #5b7c73;\n  --mascot-wood: #bc9569;\n  --mascot-wood-dark: #74583f;\n  --mascot-string: #EAE7E1;\n  --mascot-shadow: #26262a;\n  /* ---------- END MASCOT IDENTITY ---------- */}/* Identity colours and UI surfaces use Eklavya's semantic tokens. */\neklavya-mascot { display:inline-flex; flex-shrink:0; vertical-align:middle; line-height:0; }\n.ek-mascot { display:block; overflow:visible; flex-shrink:0; }\n.ek-mascot[data-variant=\"face\"] { overflow:hidden; }\n.ek-mascot__face path:not([fill]) { fill:none; }\n.ek-companion { display:flex;align-items:center;gap:12px;color:var(--dim);font:13px/1.5 var(--font-body); }\n.ek-companion--hero { margin-bottom:16px; }\n.ek-companion--hero b { display:block;color:var(--ink);font-weight:600; }\n.ek-mascot-message { display:flex;align-items:center;gap:16px;padding:16px 0; }\n.ek-mascot-message p {margin:0}\n/* Secondary loader: draws and releases an arrow over 2.8 s. */\n.ek-mascot--draw .ek-mascot__character { animation:ek-breathe 2.8s ease-in-out infinite; transform-origin:95px 185px; }\n.ek-mascot--draw .ek-mascot__arrow { animation:ek-release 2.8s cubic-bezier(.3,0,.3,1) infinite; }\n.ek-mascot--draw .ek-mascot__string { animation:ek-draw 2.8s ease-in-out infinite; transform-origin:157px 125px; }\n.ek-mascot--draw .ek-mascot__ripple { animation:ek-hit 2.8s ease-out infinite; transform-origin:196px 128px; opacity:0; }\n@keyframes ek-breathe { 0%,100% {transform:translateY(0)} 35%,55% {transform:translateY(-3px) rotate(-1deg)} }\n@keyframes ek-release { 0%,12% {transform:translateX(0);opacity:1} 40%,52% {transform:translateX(-10px);opacity:1} 68% {transform:translateX(22px);opacity:0} 69%,85% {transform:translateX(0);opacity:0} 100% {transform:translateX(0);opacity:1} }\n@keyframes ek-draw { 0%,100% {transform:scaleX(1)} 40%,52% {transform:scaleX(1.11)} 60% {transform:scaleX(.08)} 68% {transform:scaleX(1)} }\n@keyframes ek-hit { 0%,60%,100% {opacity:0;transform:scale(.4)} 68% {opacity:.8;transform:scale(.7)} 88% {opacity:0;transform:scale(1.7)} }\n/* Loader: walking toward the viewer, a 1.2 s stride (two steps). Ground rungs recede on an ease-out, as perspective slows them near the horizon. */\n.ek-mascot--loading .ek-mascot__walker { animation:ek-sway 1.2s ease-in-out infinite; transform-origin:95px 185px; }\n.ek-mascot--loading .ek-mascot__torso { animation:ek-bob .6s ease-in-out infinite; }\n.ek-mascot--loading .ek-mascot__leg, .ek-mascot--loading .ek-mascot__hand { animation:ek-step 1.2s ease-in-out infinite; }\n.ek-mascot--loading .ek-mascot__leg--r, .ek-mascot--loading .ek-mascot__hand--arrow { animation-delay:-.6s; }\n.ek-mascot--loading .ek-mascot__shadow { animation:ek-shadow .6s ease-in-out infinite; transform-origin:95px 186px; }\n.ek-mascot--loading .ek-mascot__rung { animation:ek-recede 1.2s cubic-bezier(.15,.6,.4,1) infinite; transform-origin:95px 162px; }\n.ek-mascot--loading .ek-mascot__rung:nth-child(3) { animation-delay:-.3s; }\n.ek-mascot--loading .ek-mascot__rung:nth-child(4) { animation-delay:-.6s; }\n.ek-mascot--loading .ek-mascot__rung:nth-child(5) { animation-delay:-.9s; }\n@keyframes ek-sway { 0%,100% {transform:rotate(-1.5deg)} 50% {transform:rotate(1.5deg)} }\n@keyframes ek-bob { 0%,100% {transform:translateY(1px)} 50% {transform:translateY(-3px)} }\n@keyframes ek-step { 0%,50%,100% {transform:translateY(0)} 25% {transform:translateY(-6px)} }\n@keyframes ek-shadow { 0%,100% {transform:scaleX(1)} 50% {transform:scaleX(.92)} }\n@keyframes ek-recede { 0% {transform:translateY(56px) scaleX(1);opacity:0} 10% {opacity:1} 85% {opacity:1} 100% {transform:translateY(0) scaleX(.4);opacity:0} }\n@media (prefers-reduced-motion:reduce) { .ek-mascot * {animation:none !important;transition:none !important} }\n\n.ek-companion--rail { padding:12px 20px; text-decoration:none; }\n.ek-mascot-message > :last-child { min-width:0; overflow-wrap:break-word; }\n.ek-mascot-status { display:inline-flex; align-items:center; gap:6px; }\n</style><title>Eklavya, calm and attentive</title><path d=\"M48 109q44-19 88 0l-8 30-33-15-31 15Z\" fill=\"var(--mascot-cloak)\"/><g class=\"ek-mascot__head\">\n        <path d=\"M46 43h18V29h19V18h23v12h20v14h17v19h8v29h-8v16q0 12-16 15H62q-18-3-18-17V91h-9V63h11Z\" fill=\"var(--mascot-coral)\" stroke=\"var(--mascot-coral-dark)\" stroke-width=\"2\" stroke-linejoin=\"round\"/>\n        <path d=\"M48 45h18V32h18V21h19\" fill=\"none\" stroke=\"var(--mascot-highlight)\" stroke-width=\"3\" stroke-linejoin=\"round\"/>\n        <g class=\"ek-mascot__face\" fill=\"var(--mascot-ink)\" stroke=\"var(--mascot-ink)\" stroke-width=\"3.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"64\" y=\"64\" width=\"10\" height=\"19\" rx=\"5\"/><rect x=\"110\" y=\"64\" width=\"10\" height=\"19\" rx=\"5\"/><path d=\"M84 89q8 6 16 0\"/></g>\n      </g><circle cx=\"95\" cy=\"126\" r=\"6\" fill=\"var(--mascot-metal)\"/></svg>"

/** The logo as a PNG (208 by 96, one grid cell is 8 pixels), for the demo's picture test: the mod has no filesystem. */
export const DEMO_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAANAAAABgCAYAAABsbvwBAAABcElEQVR42u3dwQ2DMBBFQXdJKdRKNaYDDqDFu+t50j8mUpDnZCUZQ3pofswTFEAASQBJAEkASQABJAEkASTlBJL9/SWAJIAAEkAASQBJAEkAASSAAJJyHnDABBBAAgggCSAJIIAEEEACCCAJoLpd5zFt3aof4O2BOcQAAQQQQAABBBBAABlAABlAAAEEEEAAAQRQY0Ddga5+ftUPaHtgAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAAB5CLUXk7BfyDmkAEkgAwggAwggAwggAwgAWQEAGQAJQbkHskX6lykuogFCCCADCCADCCAAAIIIIAAAgggAwggAwigCGDRr9/98/lhRYAAAggggAACCCCAAHLAAAIIIIAAAggggAACCCCA1LPVBxQQAQSQAAJIAkgCCCABBJAAAkgCSKp5gAERQABJAEkASQABJIAAkgCSAJJqAgNEAkgCSAJIAgggCSAJIAkgSZIkSZIkSZIk6dduN5j9QcRn8BgAAAAASUVORK5CYII='

/** The logo as SVG, one rect per run of a colour, so the demo can test a vector picture without an asset file. */
export function demoSvg(): string {
  const rects = boxRows()
    .flatMap((runs, y) => {
      let x = 0
      return runs.map(run => {
        const at = x
        x += run.width
        return run.color ? `<rect x="${at}" y="${y}" width="${run.width}" height="1" fill="${run.color}"/>` : ''
      })
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LOGO_GRID[0]!.length} ${LOGO_GRID.length}" shape-rendering="crispEdges">${rects}</svg>`
}

/** The same picture as a PNG inside an SVG: Desktop has no Image element, so this is how a raster is tried there. */
export const demoSvgWithPng = (): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 208 96"><image href="data:image/png;base64,${DEMO_PNG}" width="208" height="96"/></svg>`

/** The tester's line of what was just clicked, and how the click arrived. */
export const demoLast = (what: string): string => `Last click: ${what}`

/**
 * The key hints. Only the terminal gets them: there Ctrl+X then Tab moves the keys into the pane. The
 * desktop app keeps typing in its prompt even after a click on the pane (seen 2026-10-16), so a mod's
 * hotkeys never reach it there, and it shows no keys at all.
 */
export const hintLines = (surface: string): string[] => (surface === 'terminal' ? [STR.focus, STR.keys] : [])

export const unplacedNotice = (): string => `A question is waiting. ${REOPEN} to open it.`
export const levelLine = (level: string, project: string): string => `You've cleared ${level} on ${project}.`

/** `<concept name> · <tier label>`, the tier named the way the dashboard names it. */
export function topicLabel(q: Pick<PanelQuestion, 'concept_name' | 'tier'>): string {
  const tier = TIER[q.tier]
  return `${q.concept_name} · T${q.tier}${tier ? ` ${tier}` : ''}`
}

/** The project's folder name, or a plain phrase when the question belongs to no repository. */
export function projectName(repo: string): string {
  const last = repo.split(/[\\/]/).filter(Boolean).pop()
  return repo === '*' || !last ? 'this project' : last
}

/**
 * The grading rubric for a typed answer: `skills/tutor/references/grading.md`'s
 * free-recall scale, copied row for row (a test fails if either side changes).
 * A typed answer is free recall, so it is not capped at 4.
 */
export const RUBRIC = [
  '0 | no answer — either a blank ("I don\'t know") or a decline. Pass `outcome` to say which',
  '1 | wrong, and the misconception is load-bearing',
  '2 | wrong, but the shape of the idea is there',
  '3 | correct, but hesitant or incomplete — got there slowly',
  '4 | correct and clean',
  '5 | correct, and explained *why*, or caught a nuance you didn\'t ask for',
].join('\n')

export const GRADER_MODEL = 'haiku'

/** One model call with no history: it gets the question, the key and the words, nothing else. */
export function gradingRequest(q: PanelQuestion, correctLabel: string, typed: string): { model: string; system: string; prompt: string } {
  return {
    model: GRADER_MODEL,
    system:
      'You grade one answer a developer typed in their own words to a multiple-choice question, on a 0-5 scale. ' +
      'Before you pick a number, state to yourself what in their answer justifies it; generosity is not kindness. ' +
      'Reply with one JSON object and nothing else: {"grade": 0-5, "outcome": "answered" or "dont_know", "feedback": "..."}. ' +
      'Use "dont_know" only when they said they do not know, with grade 0. ' +
      'Feedback is at most two plain sentences saying what was right or missing.\n\nGrades:\n' +
      RUBRIC,
    prompt: [
      `Question: ${q.stem}`,
      `Options: ${q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o.label}`).join(' | ')}`,
      `The right answer: ${correctLabel}`,
      `Their answer, in their own words: ${typed}`,
    ].join('\n'),
  }
}

export type Verdict = { grade: number; outcome: 'answered' | 'dont_know'; feedback: string }

const FEEDBACK_MAX = 1000

/** The grader's reply, or null when it is anything but a well-formed verdict. Nothing is recorded from null. */
export function parseVerdict(text: string): Verdict | null {
  const found = /\{[\s\S]*\}/.exec(text)
  if (!found) return null
  let raw: unknown
  try {
    raw = JSON.parse(found[0])
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const v = raw as Record<string, unknown>
  const feedback = typeof v.feedback === 'string' ? v.feedback.trim() : ''
  if (typeof v.grade !== 'number' || !Number.isInteger(v.grade) || v.grade < 0 || v.grade > 5) return null
  if (v.outcome !== 'answered' && v.outcome !== 'dont_know') return null
  if (v.outcome === 'dont_know' && v.grade !== 0) return null
  if (!feedback || feedback.length > FEEDBACK_MAX) return null
  return { grade: v.grade, outcome: v.outcome, feedback }
}

/** The text of an MCP tool result's first text block, parsed as the JSON every Eklavya tool returns. */
export function payloadOf(blocks: readonly { type: string; text?: string }[]): Record<string, any> {
  const text = blocks.find((b) => b.type === 'text')?.text
  if (!text) throw new Error('empty reply from the Eklavya server')
  return JSON.parse(text) as Record<string, any>
}

/** Prompts the mod queues for the model. Short: the model reads the plan for the rest. */
export const NEXT_PROMPT =
  'The learner pressed Next question in the Eklavya panel. Call get_session_quiz_plan with resume_round: true and present the next question of this round with present_question, then carry on.'
