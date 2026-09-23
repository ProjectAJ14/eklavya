import type { z } from 'zod';
import type { DB } from '../db.js';

export interface ToolContext {
  db: DB;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: any, ctx: ToolContext) => unknown;
}

/** Shared arg shapes so every tool speaks the same dialect. */
export const CWD_HINT = "Working directory, so this project's settings are found. Defaults to the server cwd.";
export const SESSION_HINT =
  'Claude Code session id. Optional — omit it and the server resolves the current session itself.';

/**
 * Ceilings on the free text a model hands the learning tools, in characters.
 *
 * Every one of these is persisted -- into `attempts`, `concepts` or
 * `session_concepts` -- and read back into context by later plans, so an
 * unbounded field is a runaway generation that bloats the learner's database
 * and then every prompt that quotes it. Each is set several times above
 * anything legitimate (a real stem runs 100-500 characters, an option under
 * 200, a context line under 150): the point is to stop a runaway, never to
 * trim a real question. Over the limit is rejected by the schema rather than
 * truncated, so the model gets an error naming the field and resends a
 * shorter one; truncating would store a question nobody asked.
 */
export const LIMITS = {
  sessionId: 256,
  cwd: 4096,
  slug: 200,
  name: 200,
  domain: 100,
  description: 2000,
  context: 1000,
  question: 4000,
  answer: 8000,
  feedback: 8000,
  option: 1000,
  options: 10,
  concepts: 50,
  edges: 200,
} as const;
