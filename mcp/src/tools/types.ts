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
export const CWD_HINT = 'Working directory, so the repo-level .eklavya.json is found. Defaults to the server cwd.';
export const SESSION_HINT =
  'Claude Code session id. Optional — omit it and the server resolves the current session itself.';
