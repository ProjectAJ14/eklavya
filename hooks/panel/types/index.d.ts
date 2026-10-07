// The quiz panel's state contract: what the mod keeps in `$.state`.
//
// The pending question itself lives in the Eklavya database (`panel_questions`);
// this is only what the pane shows right now and the learner's unsent draft.
// A mod loses its own variables on reload, and the host keeps these.

/** What the pane needs to draw a waiting question. Never the key or the grades. */
export type PanelQuestion = {
  question_id: string
  /** Opaque: echoed back to the server so an answer is checked against its project. */
  repo: string
  stem: string
  options: { id: string; label: string; note: string }[]
  concept_name: string
  tier: number
  /** More questions of this round follow: the pane offers Next. */
  more: boolean
}

/** The learner's unsent answer. Selecting writes here and never submits. */
export type PanelDraft = {
  picked: string | null
  /** "Other" chosen: the typed text is the answer. */
  other: boolean
  text: string
}

/** What `panel_answer` is sent, kept so a Retry resends exactly it and a typed answer is not graded twice. */
export type PanelPending =
  | { kind: 'choice'; option_id: string }
  | { kind: 'skip' }
  | { kind: 'text'; text: string; grade: number; outcome: 'answered' | 'dont_know'; feedback: string }

/** The reply to an answer, as `panel_answer` stored it. */
export type PanelResult = {
  phase: 'answered' | 'skipped'
  attempt_id: number
  correct?: boolean
  correct_label?: string
  explanation?: string
  level_up?: { from: string; to: string }
  explain?: { instruction: string; attempt_id: number }
}

export type PanelStep = 'none' | 'loading' | 'awaiting' | 'grading' | 'feedback' | 'skipped' | 'error'

export type PanelState = {
  step: PanelStep
  question: PanelQuestion | null
  draft: PanelDraft
  pending: PanelPending | null
  result: PanelResult | null
  /** Words for the learner: why the pane is in `error`, or a one-line notice in `none`. */
  message: string | null
}

declare module 'claude-code' {
  interface PluginState {
    eklavya: { quiz: PanelState }
  }
}
