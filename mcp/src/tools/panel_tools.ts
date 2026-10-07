import { z } from 'zod';
import { panelAnswer, panelSync, presentQuestion, type AnswerInput, type PresentInput, type SyncInput } from '../panel.js';
import { CWD_HINT, LIMITS, SESSION_HINT, type ToolDef } from './types.js';

const OPTION_COUNT = 4;

export const presentQuestionTool: ToolDef = {
  name: 'present_question',
  title: 'Present a quiz question in the side panel',
  description:
    'Hand one multiple-choice question to the Eklavya side panel and return at once. Use it instead of AskUserQuestion only when the plan says presentation "panel". Give the stem alone, four options each with its one-line description and a grade (the right one 4, a near miss 2, one built on a misconception 1) with the right one in the plan\'s answer_position slot, and a one-line explanation shown after the answer. The panel shows it, grades it from those grades and records the attempt itself: do not wait, do not ask anything else, do not call record_attempt, carry on with the task. One question per session may be open; a second is rejected with question_open. Nothing is written to the learner\'s history until they answer.',
  inputSchema: {
    session_id: z.string().max(LIMITS.sessionId).optional().describe(SESSION_HINT),
    cwd: z.string().max(LIMITS.cwd).optional().describe(CWD_HINT),
    slug: z.string().max(LIMITS.slug).describe('The concept asked about.'),
    question: z.string().min(1).max(LIMITS.question).describe('The question stem only: no options, no attribution, no settings line.'),
    options: z
      .array(
        z.object({
          label: z.string().min(1).max(LIMITS.option).describe('The option text. Labels must differ.'),
          description: z.string().max(LIMITS.option).describe('The one-line description shown under the option.'),
          grade: z.number().int().min(1).max(4).describe('4 for the right option, 2 for a near miss, 1 for one built on a misconception.'),
          correct: z.boolean().optional().describe('true on exactly one option, the one graded 4.'),
        }),
      )
      .length(OPTION_COUNT)
      .describe('Exactly four options in display order.'),
    explanation: z.string().min(1).max(LIMITS.feedback).describe('The one-line why, shown after the answer.'),
    difficulty: z.number().int().min(1).max(5).describe('The tier you asked at: tier_to_ask from the plan.'),
  },
  handler: (args: PresentInput, { db }) => presentQuestion(db, args),
};

export const panelSyncTool: ToolDef = {
  name: 'panel_sync',
  title: 'Panel: is a question waiting',
  description:
    'Called only by the Eklavya panel, never by the model. Returns the question waiting for this session and project (its repo, stem, options with ids and notes, phase, concept name, tier), or {none: true}. Never returns the answer key. Reports whether the host could seat the pane (placed) so an invisible question is never counted as shown. Safe to call on every lifecycle event.',
  inputSchema: {
    session_id: z.string().min(1).max(LIMITS.sessionId).describe('The host session id.'),
    cwd: z.string().max(LIMITS.cwd).describe('The session working directory.'),
    placed: z
      .object({
        question_id: z.string().max(LIMITS.sessionId),
        ok: z.boolean(),
        reason: z.string().max(LIMITS.option).optional(),
      })
      .optional()
      .describe('Whether the pane for this question was seated.'),
  },
  handler: (args: SyncInput, { db }) => panelSync(db, args),
};

export const panelAnswerTool: ToolDef = {
  name: 'panel_answer',
  title: 'Panel: record the answer',
  description:
    'Called only by the Eklavya panel, never by the model. Grades and records one answer exactly once: kind "choice" with option_id, kind "text" with the typed text plus the grade (0-5), outcome (answered or dont_know, which needs grade 0) and feedback the panel\'s grader produced, or kind "skip" (a decline). A second call for the same question returns the first reply and writes nothing. A mismatched session or project returns stale_question.',
  inputSchema: {
    question_id: z.string().max(LIMITS.sessionId),
    session_id: z.string().min(1).max(LIMITS.sessionId),
    repo: z.string().max(LIMITS.cwd).describe('The repo panel_sync returned with the question.'),
    cwd: z.string().max(LIMITS.cwd).describe('The session working directory, where this project\'s settings are read.'),
    kind: z.enum(['choice', 'text', 'skip']),
    option_id: z.string().max(16).optional(),
    text: z.string().max(LIMITS.answer).optional(),
    grade: z.number().int().min(0).max(5).optional(),
    outcome: z.enum(['answered', 'dont_know']).optional(),
    feedback: z.string().max(LIMITS.feedback).optional(),
  },
  handler: (args: AnswerInput, { db }) => panelAnswer(db, args),
};
