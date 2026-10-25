/**
 * The words the two quiz hooks hand the model, as pure functions.
 *
 * checkpoint-quiz.ts and stop-quiz-check.ts decide WHETHER to speak; this
 * module is WHAT they say. It is separate so the hook-text eval
 * (`eval/hook-text-harness.mjs`) can put the shipped wording in front of the
 * model without a database, and so a wording change is one diff in one file.
 * Each hook file explains why its text says what it says.
 */
import { attributionRule } from '../surface.js';
import { framingFor } from './lib.js';

export interface CheckpointText {
  /** `slug (context)`, the concept most recently logged. */
  concept: string;
  /** Questions left in this session's budget. */
  remaining: number;
  /** The seam is the logging call itself, not a later work tool. */
  justLogged: boolean;
  /** The question goes to the side panel rather than AskUserQuestion. */
  panel: boolean;
  focus: string;
  focusTopic?: string | null;
}

export function checkpointText(o: CheckpointText): string {
  const lead = o.justLogged
    ? 'You just logged a concept. Before writing another line, ask'
    : 'The work has moved on since the last question. Before the next step, ask';
  const ask = o.panel
    ? `  2. Show that ONE question in the side panel with present_question: the stem alone, four options each with its one-line description and a grade (the right one 4, a near miss 2, one built on a misconception 1), the correct one in the slot answer_position names, a one-line explanation, and did_you_know ({fact, details}: the card the panel shows first, teaching the concept without giving the answer away). It returns at once.`
    : `  2. Ask that ONE question with AskUserQuestion: four options, exactly one correct, three plausible but wrong for this stem, and put the correct one in the slot answer_position names.
     ${attributionRule()}`;
  const after = o.panel
    ? `  3. The panel records the answer and shows the verdict itself. Do not call record_attempt, do not announce a result and do not wait for the answer.
  4. Resume the task exactly where you left off. Do not summarise, do not re-plan, do not ask a second question.`
    : `  3. Grade it with record_attempt: format "mcq", the labels in "options", the stem alone in "question".
  4. Tell them the verdict: right, or wrong and what the right answer is, with one line of why. Never skip this -- an answer with no verdict teaches nothing.
  5. Resume the task exactly where you left off. Do not summarise, do not re-plan, do not ask a second question.`;
  const tail = o.panel
    ? ''
    : `
If they say skip, record grade 0 with outcome declined and carry on without teaching it. If they pick Other and say they do not know, record grade 0 with outcome dont_know and teach the answer in two lines. Either way, do not ask again.`;

  return `[Eklavya checkpoint] ${lead} the developer ONE question about it -- this is the whole point of the tool: they learn while you work, not in a pile at the end.

Concept: ${o.concept}

Do exactly this, then get straight back to the task:
  1. get_session_quiz_plan with max: 1 and ignore_cooldown: true (the pacing is already decided -- this hook is the cooldown).
${ask}
${after}

ONE question. Not two, not the whole plan. ${o.remaining} left in this session's budget, and the Stop hook spends whatever you do not.
${framingFor(o.focus, o.focusTopic, 'checkpoint')}${tail}`;
}

export interface StopText {
  /** How many questions this sweep asks. */
  asked: number;
  /** Concept slugs to ask about; empty when `logFirst`. */
  names: string[];
  /** `names` is earlier work in this project that is due again. */
  due: boolean;
  /** The session logged nothing: log first, then plan. */
  logFirst: boolean;
  /** The commit gate needs this quiz. */
  gate: boolean;
}

export function stopText(o: StopText): string {
  const concepts = o.names.join(', ');
  const count = o.asked === 1 ? 'one question' : `up to ${o.asked} questions, one at a time,`;
  const what = o.logFirst
    ? `${count} on this work`
    : o.due
      ? `${count} on earlier work in this project that is due again (${concepts})`
      : `${count} on ${concepts}`;
  const call = o.logFirst
    ? 'call log_session_concepts with the concepts it used, then get_session_quiz_plan, and follow it.'
    : 'call get_session_quiz_plan and follow it.';
  return `Eklavya: ${what} before this turn ends -- ${call}${o.gate ? ' The commit gate needs it.' : ''}`;
}
