import type { PanelQuestion, PanelState } from './types'

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

/** Every sentence the learner reads, in one place. The handoff's table, verbatim. */
export const STR = {
  brand: 'Eklavya',
  powered: 'Powered by Claude',
  submit: 'Submit answer',
  skip: 'Skip question',
  next: 'Next question',
  done: 'Done',
  retry: 'Retry',
  close: 'Close',
  other: 'Other — explain in your own words',
  otherPlaceholder: 'Your answer in your own words',
  loading: 'Loading your question…',
  grading: 'Checking your answer…',
  correct: 'Correct',
  wrong: 'Needs another look',
  skipped: "Skipped. We won't ask this one again.",
  empty: 'No question right now',
  unreachable: "We couldn't reach Eklavya. Your answer is saved here — Retry.",
  stale: 'This question belongs to another session and was closed.',
  nothingTyped: 'Write your answer first, or pick one of the options.',
  graderFailed: "We couldn't check that answer. Your text is saved here — Retry.",
  explainer: 'A page explaining this is being written.',
  off: 'The quiz panel is off. Turn it on with: eklavya config set quiz.panel true',
} as const

export const answerWas = (label: string): string => `The answer was: ${label}`
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
  'The learner pressed Next question in the Eklavya panel. Call get_session_quiz_plan with ignore_cooldown: true and present the next question of this round with present_question (more: true unless it is the last), then carry on.'
